import asyncio
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Optional, AsyncGenerator
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, Response, Query, Depends
from fastapi.responses import JSONResponse

from cf_bypasser.core.bypasser import CamoufoxBypasser
from cf_bypasser.core.mirror import RequestMirror
from cf_bypasser.server.models import (
    CookieRequest, CookieResponse, MirrorRequestHeaders,
    MirrorResponse, CacheStatsResponse, CacheClearResponse, ErrorResponse,
    MirrorRequestInfo, CookieGenerationInfo
)

# Global instances
global_bypasser = None
global_mirror = None
bypass_semaphore = None
watchdog_task = None

logger = logging.getLogger(__name__)

DEFAULT_MAX_TREE_RSS_MB = 700
DEFAULT_WATCHDOG_INTERVAL_SEC = 30
DEFAULT_MAX_CONCURRENCY = 1


def env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def process_tree_rss_mb(root_pid: int = None) -> float:
    root_pid = root_pid or os.getpid()
    children = {}

    for entry in os.scandir('/proc'):
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            with open(f'/proc/{pid}/stat', 'r', encoding='utf-8') as fh:
                stat = fh.read()
            after_comm = stat.rsplit(') ', 1)[1].split()
            ppid = int(after_comm[1])
        except Exception:
            continue
        children.setdefault(ppid, []).append(pid)

    stack = [root_pid]
    seen = set()
    rss_pages = 0

    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        try:
            with open(f'/proc/{pid}/statm', 'r', encoding='utf-8') as fh:
                parts = fh.read().split()
            rss_pages += int(parts[1])
        except Exception:
            pass
        stack.extend(children.get(pid, []))

    return rss_pages * os.sysconf('SC_PAGE_SIZE') / 1024 / 1024


async def delayed_exit_for_memory(reason: str, delay: float = 1.0) -> None:
    await asyncio.sleep(delay)
    logger.error(f'Exiting bypass service for PM2 restart: {reason}')
    os._exit(75)


def schedule_memory_restart_if_needed(reason: str) -> None:
    limit_mb = env_int('BYPASS_MAX_TREE_RSS_MB', DEFAULT_MAX_TREE_RSS_MB, 128)
    rss_mb = process_tree_rss_mb()
    if rss_mb > limit_mb:
        logger.error(f'Bypass process tree RSS {rss_mb:.1f} MB exceeds {limit_mb} MB after {reason}')
        asyncio.create_task(delayed_exit_for_memory(f'tree RSS {rss_mb:.1f} MB > {limit_mb} MB'))


async def memory_watchdog() -> None:
    interval = env_int('BYPASS_WATCHDOG_INTERVAL_SEC', DEFAULT_WATCHDOG_INTERVAL_SEC, 5)
    limit_mb = env_int('BYPASS_MAX_TREE_RSS_MB', DEFAULT_MAX_TREE_RSS_MB, 128)
    while True:
        await asyncio.sleep(interval)
        # A single active Camoufox browser can be large on this host. Let the request finish
        # so normal cleanup and the post-request guard can run before deciding to restart.
        if bypass_semaphore and bypass_semaphore.locked():
            continue
        rss_mb = process_tree_rss_mb()
        if rss_mb > limit_mb:
            logger.error(f'Bypass process tree RSS {rss_mb:.1f} MB exceeds watchdog limit {limit_mb} MB')
            os._exit(75)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Lifespan context manager for FastAPI application startup and shutdown.
    """
    global global_bypasser, global_mirror, bypass_semaphore, watchdog_task
    
    # Startup
    logger.info("Starting Cloudflare Bypasser Server...")
    
    # Initialize bypasser with cache
    global_bypasser = CamoufoxBypasser(max_retries=5, log=True)
    
    # Initialize request mirror
    global_mirror = RequestMirror(global_bypasser)

    max_concurrency = env_int('BYPASS_MAX_CONCURRENCY', DEFAULT_MAX_CONCURRENCY, 1)
    bypass_semaphore = asyncio.Semaphore(max_concurrency)
    watchdog_task = asyncio.create_task(memory_watchdog())
    logger.info(f"Bypass concurrency limit: {max_concurrency}")
    logger.info(f"Bypass tree RSS restart limit: {env_int('BYPASS_MAX_TREE_RSS_MB', DEFAULT_MAX_TREE_RSS_MB, 128)} MB")
    
    logger.info("Server initialization complete")
    
    yield
    
    # Shutdown
    logger.info("Shutting down Cloudflare Bypasser Server...")
    
    try:
        if watchdog_task:
            watchdog_task.cancel()
            try:
                await watchdog_task
            except asyncio.CancelledError:
                pass

        if global_mirror:
            await global_mirror.cleanup()
        
        if global_bypasser:
            await global_bypasser.cleanup()
    except Exception as e:
        logger.error(f"Error during shutdown: {e}")
    
    logger.info("Server shutdown complete")


def is_safe_url(url: str) -> bool:
    """Check if the URL is safe (not localhost/private)."""
    try:
        parsed_url = urlparse(url)
        ip_pattern = re.compile(
            r"^(127\.0\.0\.1|localhost|0\.0\.0\.0|::1|10\.\d+\.\d+\.\d+|172\.1[6-9]\.\d+\.\d+|172\.2[0-9]\.\d+\.\d+|172\.3[0-1]\.\d+\.\d+|192\.168\.\d+\.\d+)$"
        )
        hostname = parsed_url.hostname
        if (hostname and ip_pattern.match(hostname)) or parsed_url.scheme == "file":
            return False
        return True
    except:
        return False


def setup_routes(app: FastAPI):
    """Setup all routes for the FastAPI application."""
    
    @app.get("/cookies", response_model=CookieResponse, responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}})
    async def get_cookies(
        url: str = Query(..., description="Target URL to get cookies for"),
        retries: int = Query(5, ge=1, le=10, description="Number of retry attempts"),
        proxy: Optional[str] = Query(None, description="Proxy URL (optional)")
    ):
        """
        Legacy endpoint for backward compatibility.
        Get Cloudflare clearance cookies for a URL.
        """
        # Validate URL
        if not is_safe_url(url):
            raise HTTPException(
                status_code=400, 
                detail="Invalid or unsafe URL - localhost and private IPs are not allowed"
            )
        
        # Validate proxy format if provided
        if proxy and not proxy.startswith(('http://', 'https://', 'socks4://', 'socks5://')):
            raise HTTPException(
                status_code=400,
                detail="Proxy must start with http://, https://, socks4://, or socks5://"
            )
        
        try:
            start_time = time.time()
            logger.info(f"Getting cookies for {url} (retries: {retries}, proxy: {'yes' if proxy else 'no'})")
            
            # Use the global bypasser or create a new one
            bypasser = global_bypasser or CamoufoxBypasser(max_retries=retries, log=True)
            gate = bypass_semaphore or asyncio.Semaphore(DEFAULT_MAX_CONCURRENCY)
            
            # Get cookies using the cache system
            async with gate:
                data = await bypasser.get_or_generate_cookies(url, proxy)
            schedule_memory_restart_if_needed('/cookies')
            
            if not data:
                raise HTTPException(status_code=500, detail="Failed to bypass Cloudflare protection")
            
            generation_time = int((time.time() - start_time) * 1000)
            cf_cookies = [name for name in data["cookies"].keys() if name.startswith(('cf_', '__cf'))]
            
            logger.info(f"Successfully generated {len(data['cookies'])} cookies in {generation_time}ms")
            logger.info(f"Cloudflare cookies: {cf_cookies}")
            
            return CookieResponse(
                cookies=data["cookies"],
                user_agent=data["user_agent"]
            )
            
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error getting cookies for {url}: {e}")
            raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

    @app.get("/html", responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}})
    async def get_html(
        url: str = Query(..., description="Target URL to get HTML content for"),
        retries: int = Query(5, ge=1, le=10, description="Number of retry attempts"),
        proxy: Optional[str] = Query(None, description="Proxy URL (optional)"),
        bypassCookieCache: bool = Query(False, description="Force fresh cookie generation")
    ):
        """
        Get HTML content from a URL after bypassing Cloudflare protection.
        Returns the raw HTML content directly.
        """
        # Validate URL
        if not is_safe_url(url):
            raise HTTPException(
                status_code=400, 
                detail="Invalid or unsafe URL - localhost and private IPs are not allowed"
            )
        
        # Validate proxy format if provided
        if proxy and not proxy.startswith(('http://', 'https://', 'socks4://', 'socks5://')):
            raise HTTPException(
                status_code=400,
                detail="Proxy must start with http://, https://, socks4://, or socks5://"
            )
        
        try:
            start_time = time.time()
            logger.info(f"Getting HTML content for {url} (retries: {retries}, proxy: {'yes' if proxy else 'no'})")
            
            # Use the global bypasser or create a new one
            bypasser = global_bypasser or CamoufoxBypasser(max_retries=retries, log=True)
            gate = bypass_semaphore or asyncio.Semaphore(DEFAULT_MAX_CONCURRENCY)
            
            # Get HTML content using the new method
            async with gate:
                data = await bypasser.get_or_generate_html(url, proxy, bypass_cache=bypassCookieCache)
            schedule_memory_restart_if_needed('/html')
            
            if not data:
                raise HTTPException(status_code=500, detail="Failed to bypass Cloudflare protection")
            
            generation_time = int((time.time() - start_time) * 1000)
            cf_cookies = [name for name in data["cookies"].keys() if name.startswith(('cf_', '__cf'))]
            content_length = len(data["html"])
            
            logger.info(f"Successfully generated HTML content ({content_length} chars) and {len(data['cookies'])} cookies in {generation_time}ms")
            logger.info(f"Cloudflare cookies: {cf_cookies}")
            
            # Return raw HTML content with proper headers
            return Response(
                content=data["html"],
                media_type="text/html",
                headers={
                    "x-cf-bypasser-cookies": str(len(data["cookies"])),
                    "x-cf-bypasser-user-agent": data["user_agent"],
                    "x-cf-bypasser-final-url": data["url"],
                    "x-processing-time-ms": str(generation_time)
                }
            )
            
        except HTTPException:
            raise
        except Exception as e:
            logger.info(f"Error getting HTML content for {url}: {e}")
            raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

    @app.post("/cache/clear", response_model=CacheClearResponse, responses={500: {"model": ErrorResponse}})
    async def clear_cache():
        """
        Clear the cookie cache and cleanup active sessions.
        This will force fresh cookie generation for all subsequent requests.
        """
        try:
            cleared_entries = 0
            
            if global_bypasser:
                cache = global_bypasser.cookie_cache.cache
                cleared_entries = len(cache)
                global_bypasser.cookie_cache.clear_all()
                logger.info(f"Cleared {cleared_entries} cache entries")
            
            if global_mirror:
                await global_mirror.cleanup()
                logger.info("Cleaned up mirror sessions")
            
            return CacheClearResponse(
                status="success",
                message=f"Cache cleared successfully - {cleared_entries} entries removed"
            )
        except Exception as e:
            logger.error(f"Error clearing cache: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to clear cache: {str(e)}")

    @app.get("/cache/stats", response_model=CacheStatsResponse, responses={500: {"model": ErrorResponse}})
    async def cache_stats():
        """
        Get detailed cache statistics including active entries and hostnames.
        """
        try:
            if not global_bypasser:
                return CacheStatsResponse(
                    cached_entries=0,
                    total_hostnames=0,
                    hostnames=[]
                )
            
            cache = global_bypasser.cookie_cache.cache
            active_entries = sum(1 for cached in cache.values() if not cached.is_expired())
            expired_entries = len(cache) - active_entries
            
            logger.info(f"Cache stats: {active_entries} active, {expired_entries} expired, {len(cache)} total")
            
            return CacheStatsResponse(
                cached_entries=active_entries,
                total_hostnames=len(cache),
                hostnames=list(cache.keys())
            )
        except Exception as e:
            logger.error(f"Error getting cache stats: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to get cache stats: {str(e)}")

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
    async def mirror_request(request: Request, path: str = ""):
        """
        Dynamic request mirroring endpoint - captures all paths except health, cookies, and cache.
        
        Required Headers:
        - x-hostname: Target hostname (e.g., "example.com")
        
        Optional Headers:
        - x-proxy: Proxy URL (http://, https://, socks4://, socks5://)
        - x-bypass-cache: Force fresh cookie generation (true/false)
        
        Returns the mirrored response from the target with Cloudflare protection bypassed.
        """
        
        # Skip mirroring for specific endpoints
        if path in ["cookies", "html"] or path.startswith("cache/"):
            raise HTTPException(status_code=404, detail="Not found")
        
        try:
            start_time = time.time()
            
            # Extract headers
            headers = dict(request.headers)
            
            # Extract mirror-specific headers
            hostname = None
            proxy = None
            bypass_cache = False
            
            for key, value in headers.items():
                key_lower = key.lower()
                if key_lower == 'x-hostname':
                    hostname = value
                elif key_lower == 'x-proxy':
                    proxy = value
                elif key_lower == 'x-bypass-cache':
                    bypass_cache = value.lower() in ('true', '1', 'yes', 'on')
            
            # Validate required headers
            if not hostname:
                raise HTTPException(
                    status_code=400, 
                    detail="x-hostname header is required for request mirroring"
                )
            
            # Validate hostname
            if not is_safe_url(f"https://{hostname}"):
                raise HTTPException(
                    status_code=400, 
                    detail="Invalid or unsafe hostname - localhost and private IPs are not allowed"
                )
            
            # Validate proxy format if provided
            if proxy and not proxy.startswith(('http://', 'https://', 'socks4://', 'socks5://')):
                raise HTTPException(
                    status_code=400,
                    detail="x-proxy must start with http://, https://, socks4://, or socks5://"
                )
            
            # Log request info
            request_info = MirrorRequestInfo(
                method=request.method,
                hostname=hostname,
                path=f"/{path}" if path else "/",
                proxy_used=proxy,
                cache_bypassed=bypass_cache,
                attempt_number=1,
                max_attempts=3
            )
            
            logger.info(f"Mirroring {request_info.method} request to {request_info.hostname}{request_info.path}")
            if proxy:
                logger.info(f"Using proxy: {proxy}")
            if bypass_cache:
                logger.info("x-bypass-cache header detected - forcing fresh cookie generation")
            
            # Get request body
            body = await request.body()
            
            # Get query string
            query_string = str(request.query_params)
            
            # Use the global mirror or create a new one
            mirror = global_mirror or RequestMirror(global_bypasser)
            
            # Mirror the request
            status_code, response_headers, response_content = await mirror.mirror_request(
                method=request.method,
                path=f"/{path}" if path else "/",
                query_string=query_string,
                headers=headers,
                body=body
            )
            
            processing_time = int((time.time() - start_time) * 1000)
            
            # Log response info
            logger.info(f"Request to {hostname} completed with status {status_code} in {processing_time}ms")
            logger.info(f"Response size: {len(response_content)} bytes")
            
            # Create response with proper headers
            response = Response(
                content=response_content,
                status_code=status_code,
                headers=response_headers
            )
            
            # Add custom headers for debugging
            response.headers["x-cf-bypasser-version"] = "2.0.0"
            response.headers["x-processing-time-ms"] = str(processing_time)
            response.headers["x-cache-bypassed"] = str(bypass_cache).lower()
            
            return response
            
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error mirroring request: {e}")
            raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

    @app.post("/cache/clear", response_model=CacheClearResponse, responses={500: {"model": ErrorResponse}})
    async def clear_cache():
        """
        Clear the cookie cache and cleanup active sessions.
        This will force fresh cookie generation for all subsequent requests.
        """
        try:
            cleared_entries = 0
            
            if global_bypasser:
                cache = global_bypasser.cookie_cache.cache
                cleared_entries = len(cache)
                global_bypasser.cookie_cache.clear_all()
                logger.info(f"Cleared {cleared_entries} cache entries")
            
            if global_mirror:
                await global_mirror.cleanup()
                logger.info("Cleaned up mirror sessions")
            
            return CacheClearResponse(
                status="success",
                message=f"Cache cleared successfully - {cleared_entries} entries removed"
            )
        except Exception as e:
            logger.error(f"Error clearing cache: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to clear cache: {str(e)}")

    @app.get("/cache/stats", response_model=CacheStatsResponse, responses={500: {"model": ErrorResponse}})
    async def cache_stats():
        """
        Get detailed cache statistics including active entries and hostnames.
        """
        try:
            if not global_bypasser:
                return CacheStatsResponse(
                    cached_entries=0,
                    total_hostnames=0,
                    hostnames=[]
                )
            
            cache = global_bypasser.cookie_cache.cache
            active_entries = sum(1 for cached in cache.values() if not cached.is_expired())
            expired_entries = len(cache) - active_entries
            
            logger.info(f"Cache stats: {active_entries} active, {expired_entries} expired, {len(cache)} total")
            
            return CacheStatsResponse(
                cached_entries=active_entries,
                total_hostnames=len(cache),
                hostnames=list(cache.keys())
            )
        except Exception as e:
            logger.error(f"Error getting cache stats: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to get cache stats: {str(e)}")