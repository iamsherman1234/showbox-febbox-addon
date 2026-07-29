import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createRequire } from 'module';
import ShowboxAPI from './ShowboxAPI.js';
import FebboxAPI from './FebBoxApi.js';

dotenv.config();

const require = createRequire(import.meta.url);
const { addonBuilder } = require('stremio-addon-sdk');
const getRouter = require('stremio-addon-sdk/src/getRouter');

const PORT = Number(process.env.PORT || process.env.API_PORT || 7019);
const ADDON_BASE_URL = (process.env.ADDON_BASE_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const NEGATIVE_STREAM_CACHE_TTL_MS = Number(process.env.NEGATIVE_STREAM_CACHE_TTL_MS || 2 * 60 * 1000);
const SHARE_KEY_CACHE_TTL_MS = Number(process.env.SHARE_KEY_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const SHARE_KEY_CACHE_FILE = process.env.SHARE_KEY_CACHE_FILE || path.join(process.cwd(), 'cache', 'share-keys.json');
const MAX_FILES_TO_LINK = Number(process.env.MAX_FILES_TO_LINK || 12);
const MAX_TRAVERSAL_DEPTH = Number(process.env.MAX_TRAVERSAL_DEPTH || 3);
const TARGET_STREAM_COUNT = Number(process.env.TARGET_STREAM_COUNT || MAX_FILES_TO_LINK);
const MIN_STREAM_RESOLUTION = parseResolution(process.env.MIN_STREAM_QUALITY || '0');
const INCLUDE_ORIGINAL_STREAMS = process.env.INCLUDE_ORIGINAL_STREAMS !== '0';
const USE_MEDIAFLOW_PROXY = process.env.USE_MEDIAFLOW_PROXY === '1';
const MEDIAFLOW_URL = (process.env.MEDIAFLOW_URL || 'https://proxy.sudolocal.qzz.io').replace(/\/+$/, '');
const MEDIAFLOW_PASSWORD = process.env.MEDIAFLOW_PASSWORD || '';
const SECONDARY_MEDIAFLOW_URL = (process.env.SECONDARY_MEDIAFLOW_URL || '').replace(/\/+$/, '');
const SECONDARY_MEDIAFLOW_PASSWORD = process.env.SECONDARY_MEDIAFLOW_PASSWORD || '';
const PROXY_ORIGINAL_STREAMS = process.env.PROXY_ORIGINAL_STREAMS === '1';
const CONFIGURED_PROXY_COUNT = [
  Boolean(MEDIAFLOW_URL && MEDIAFLOW_PASSWORD),
  Boolean(SECONDARY_MEDIAFLOW_URL)
].filter(Boolean).length;
const STREAM_VARIANT_MULTIPLIER = USE_MEDIAFLOW_PROXY ? Math.max(1, CONFIGURED_PROXY_COUNT) : 1;
const FEBBOX_CLIENT_ID = String(process.env.FEBBOX_CLIENT_ID || '').trim();
const FEBBOX_AUTH_SECRET = String(process.env.FEBBOX_AUTH_SECRET || '');
const FEBBOX_AUTH_STATE_TTL_MS = Number(process.env.FEBBOX_AUTH_STATE_TTL_MS || 10 * 60 * 1000);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v']);

const showboxAPI = new ShowboxAPI();
const febboxAPI = new FebboxAPI();
const cache = new Map();
const febboxAuthStates = new Map();
const persistentShareKeyCache = loadPersistentShareKeyCache();

const manifest = {
  id: 'org.showbox.febbox.addon',
  version: '0.1.0',
  name: 'Showbox Febbox',
  description: 'Streams Showbox media through Febbox direct links.',
  types: ['movie', 'series'],
  resources: ['stream'],
  catalogs: [],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

function loadPersistentShareKeyCache() {
  try {
    if (!fs.existsSync(SHARE_KEY_CACHE_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(SHARE_KEY_CACHE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (error) {
    console.warn('[ShowboxFebbox] failed to load share-key cache: ' + error.message);
    return {};
  }
}

function savePersistentShareKeyCache() {
  try {
    fs.mkdirSync(path.dirname(SHARE_KEY_CACHE_FILE), { recursive: true });
    fs.writeFileSync(SHARE_KEY_CACHE_FILE, JSON.stringify(persistentShareKeyCache, null, 2));
  } catch (error) {
    console.warn('[ShowboxFebbox] failed to save share-key cache: ' + error.message);
  }
}

function persistentShareKeyGet(key) {
  const entry = persistentShareKeyCache[key];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    delete persistentShareKeyCache[key];
    savePersistentShareKeyCache();
    return null;
  }
  return entry.value || null;
}

function persistentShareKeySet(key, value, ttl = SHARE_KEY_CACHE_TTL_MS) {
  persistentShareKeyCache[key] = { value, expiresAt: Date.now() + ttl };
  savePersistentShareKeyCache();
  return value;
}

function titleYear(value) {
  return String(value || '').match(/\b(19|20)\d{2}\b/)?.[0] || '';
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseResolution(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === '4k') return 2160;
  const match = normalized.match(/(\d{3,4})p?/);
  return match ? Number(match[1]) : 0;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function parseStremioId(id) {
  const [imdbId, season, episode] = String(id || '').split(':');
  return {
    imdbId,
    season: season ? Number(season) : null,
    episode: episode ? Number(episode) : null
  };
}

async function getMeta(type, imdbId) {
  const key = `meta:${type}:${imdbId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await fetchJson(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
  const meta = data?.meta;
  if (!meta?.name) return cacheSet(key, null, 5 * 60 * 1000);

  return cacheSet(key, {
    imdbId,
    type,
    title: meta.name,
    titles: unique([meta.name, meta.originalName, meta.imdb_id && meta.name]),
    year: String(meta.year || titleYear(meta.released) || meta.releaseInfo || '')
  });
}

function scoreSearchResult(result, meta) {
  const wantedTitles = meta.titles.map(normalizeTitle);
  const candidate = normalizeTitle(result.title || result.name);
  if (!candidate) return 0;

  let score = 0;
  if (wantedTitles.includes(candidate)) score += 100;
  if (wantedTitles.some((title) => title && (candidate.includes(title) || title.includes(candidate)))) score += 50;
  if (meta.year && String(result.year || '') === meta.year) score += 25;
  return score;
}

async function findShowboxItem(meta) {
  const key = `showbox:${meta.type}:${meta.imdbId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const searchType = meta.type === 'series' ? 'tv' : 'movie';
  const candidates = [];

  for (const title of meta.titles) {
    try {
      const results = await showboxAPI.search(title, searchType, 1, 10);
      if (Array.isArray(results)) candidates.push(...results);
    } catch (error) {
      console.warn(`[ShowboxFebbox] search failed for ${title}: ${error.message}`);
    }
  }

  candidates.sort((a, b) => scoreSearchResult(b, meta) - scoreSearchResult(a, meta));
  const best = candidates[0] && scoreSearchResult(candidates[0], meta) >= 60 ? candidates[0] : null;
  return cacheSet(key, best, best ? CACHE_TTL_MS : 10 * 60 * 1000);
}

function isVideoFile(file) {
  const name = String(file?.file_name || file?.name || '');
  const ext = name.split('.').pop()?.toLowerCase();
  return !file?.is_dir && (!ext || VIDEO_EXTENSIONS.has(ext));
}

function fileName(file) {
  return String(file?.file_name || file?.name || file?.title || '').trim();
}

function episodeScore(file, wantedSeason, wantedEpisode, context = '') {
  if (!wantedSeason || !wantedEpisode) return 1;

  const text = `${context} ${fileName(file)}`.toLowerCase();
  const season = String(wantedSeason).padStart(2, '0');
  const episode = String(wantedEpisode).padStart(2, '0');
  const patterns = [
    new RegExp(`s0?${wantedSeason}[^0-9]?e0?${wantedEpisode}\\b`, 'i'),
    new RegExp(`\\b0?${wantedSeason}x0?${wantedEpisode}\\b`, 'i'),
    new RegExp(`season\\s*0?${wantedSeason}.*episode\\s*0?${wantedEpisode}\\b`, 'i')
  ];

  if (patterns.some((pattern) => pattern.test(text))) return 100;
  if (text.includes(`s${season}`) && text.includes(`e${episode}`)) return 90;
  if (new RegExp(`\\bepisode\\s*0?${wantedEpisode}\\b`, 'i').test(text)) return 45;
  return 0;
}

async function collectFiles(shareKey, parentId = 0, depth = 0, context = '') {
  if (depth > MAX_TRAVERSAL_DEPTH) return [];

  const files = await febboxAPI.getFileList(shareKey, parentId);
  const collected = [];

  for (const file of Array.isArray(files) ? files : []) {
    const name = fileName(file);
    if (file?.is_dir) {
      try {
        const nested = await collectFiles(shareKey, file.fid, depth + 1, `${context} ${name}`.trim());
        collected.push(...nested);
      } catch (error) {
        console.warn(`[ShowboxFebbox] folder traversal failed for ${name}: ${error.message}`);
      }
    } else if (isVideoFile(file)) {
      collected.push({ ...file, context });
    }
  }

  return collected;
}

function selectFiles(files, parsedId) {
  if (!parsedId.season || !parsedId.episode) return files.slice(0, MAX_FILES_TO_LINK);

  return files
    .map((file) => ({ file, score: episodeScore(file, parsedId.season, parsedId.episode, file.context) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILES_TO_LINK)
    .map((item) => item.file);
}

function streamResolution(link) {
  const quality = String(link?.quality || '').toLowerCase();
  if (quality === 'org') return Infinity;
  if (quality.includes('4k')) return 2160;
  return parseResolution(quality);
}

function shouldKeepStream(link) {
  const quality = String(link?.quality || '').toLowerCase();
  if (quality === 'org') return INCLUDE_ORIGINAL_STREAMS;
  return streamResolution(link) >= MIN_STREAM_RESOLUTION;
}

function streamSortRank(link) {
  const quality = String(link?.quality || '').toLowerCase();
  const resolution = streamResolution(link);
  if (quality === 'org') return 90;
  if (resolution >= 2160) return 5;
  if (resolution >= 1080) return 10;
  if (resolution >= 720) return 20;
  if (resolution >= 480) return 30;
  if (resolution >= 360) return 40;
  return 50;
}

function streamTitle(link, file) {
  const parts = [
    link.quality || '',
    link.size || file.file_size || '',
    fileName(file)
  ].filter(Boolean);
  return parts.join('\n');
}


function isOriginalStream(link) {
  return String(link?.quality || '').toLowerCase() === 'org';
}

function mediaflowProxyUrl(link, proxyUrl, password = '') {
  const originalUrl = link?.url;
  if (!proxyUrl || !originalUrl) return originalUrl;
  const passwordQuery = password ? '&api_password=' + encodeURIComponent(password) : '';

  if (isOriginalStream(link)) {
    if (!PROXY_ORIGINAL_STREAMS) return originalUrl;
    return proxyUrl + '/proxy/stream?url=' + encodeURIComponent(originalUrl) + passwordQuery;
  }

  return proxyUrl + '/proxy/hls/manifest.m3u8?d=' + encodeURIComponent(originalUrl) + passwordQuery;
}

function mediaflowProxyVariants(link) {
  const originalUrl = link?.url;
  if (!USE_MEDIAFLOW_PROXY || !originalUrl || (isOriginalStream(link) && !PROXY_ORIGINAL_STREAMS)) {
    return [{ label: 'Direct', key: 'direct', url: originalUrl }];
  }

  const proxies = [
    { label: 'S10+', key: 'S10+', url: MEDIAFLOW_URL, password: MEDIAFLOW_PASSWORD, enabled: Boolean(MEDIAFLOW_URL && MEDIAFLOW_PASSWORD) },
    { label: 'Render', key: 'Render', url: SECONDARY_MEDIAFLOW_URL, password: SECONDARY_MEDIAFLOW_PASSWORD, enabled: Boolean(SECONDARY_MEDIAFLOW_URL) }
  ].filter(proxy => proxy.enabled);

  if (!proxies.length) return [{ label: 'Direct', key: 'direct', url: originalUrl }];

  const seen = new Set();
  return proxies
    .map(proxy => ({
      label: proxy.label,
      key: proxy.key,
      url: mediaflowProxyUrl(link, proxy.url, proxy.password)
    }))
    .filter(proxy => proxy.url && !seen.has(proxy.url) && seen.add(proxy.url));
}

async function linksForFile(shareKey, file) {
  const links = await febboxAPI.getLinks(shareKey, file.fid);
  return (Array.isArray(links) ? links : [])
    .filter((link) => link?.url && shouldKeepStream(link))
    .sort((a, b) => streamSortRank(a) - streamSortRank(b))
    .flatMap(link => mediaflowProxyVariants(link).map(proxy => ({
      name: proxy.key === 'direct' ? 'Showbox Febbox' : `Showbox Febbox ${proxy.label}`,
      title: proxy.key === 'direct' ? streamTitle(link, file) : `${proxy.label}\n${streamTitle(link, file)}`,
      url: proxy.url,
      behaviorHints: {
        bingeGroup: `showbox-febbox-${proxy.key}-${link.quality || 'auto'}`
      }
    })));
}

async function getShareKey(item) {
  const cacheKey = `share-key:${item.box_type}:${item.id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const persistent = persistentShareKeyGet(cacheKey);
  if (persistent) return cacheSet(cacheKey, persistent, SHARE_KEY_CACHE_TTL_MS);

  const shareKey = await showboxAPI.getFebBoxId(item.id, item.box_type);
  if (!shareKey) return cacheSet(cacheKey, null, 10 * 60 * 1000);
  persistentShareKeySet(cacheKey, shareKey, SHARE_KEY_CACHE_TTL_MS);
  return cacheSet(cacheKey, shareKey, SHARE_KEY_CACHE_TTL_MS);
}

async function resolveStreams(type, id) {
  const parsedId = parseStremioId(id);
  if (!/^tt\d+/.test(parsedId.imdbId)) return [];

  const proxyMode = USE_MEDIAFLOW_PROXY
    ? `mediaflow:${PROXY_ORIGINAL_STREAMS ? 'all' : 'hls'}:${MEDIAFLOW_URL}:${SECONDARY_MEDIAFLOW_URL}`
    : 'direct';
  const cacheKey = `streams:${proxyMode}:${type}:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const meta = await getMeta(type, parsedId.imdbId);
  if (!meta) return cacheSet(cacheKey, [], 10 * 60 * 1000);

  console.log(`[ShowboxFebbox] Looking up ${meta.title} (${meta.year || 'year unknown'})`);
  const item = await findShowboxItem(meta);
  if (!item) return cacheSet(cacheKey, [], 10 * 60 * 1000);

  const shareKey = await getShareKey(item);
  if (!shareKey) return cacheSet(cacheKey, [], 10 * 60 * 1000);

  const files = selectFiles(await collectFiles(shareKey), parsedId);
  const streams = (await Promise.all(files.map(async (file) => {
    try {
      return await linksForFile(shareKey, file);
    } catch (error) {
      console.warn(`[ShowboxFebbox] link extraction failed for ${fileName(file)}: ${error.message}`);
      return [{
        name: "Showbox Febbox",
        title: `Open Febbox\n${fileName(file)}\n${error.message}`,
        externalUrl: `https://www.febbox.com/share/${shareKey}`
      }];
    }
  }))).flat().slice(0, TARGET_STREAM_COUNT * STREAM_VARIANT_MULTIPLIER);

  return cacheSet(cacheKey, streams, streams.length ? CACHE_TTL_MS : NEGATIVE_STREAM_CACHE_TTL_MS);
}

builder.defineStreamHandler(async ({ type, id }) => {
  if (!['movie', 'series'].includes(type)) return { streams: [] };

  try {
    return { streams: await resolveStreams(type, id) };
  } catch (error) {
    console.warn(`[ShowboxFebbox] stream handler failed for ${type}/${id}: ${error.message}`);
    return { streams: [] };
  }
});

function requestBaseUrl(req) {
  if (ADDON_BASE_URL) return ADDON_BASE_URL;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function secretsMatch(receivedValue) {
  const expected = Buffer.from(FEBBOX_AUTH_SECRET);
  const received = Buffer.from(String(receivedValue || ''));
  return expected.length > 0
    && expected.length === received.length
    && crypto.timingSafeEqual(expected, received);
}

function requestCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(valueParts.join('='));
    } catch {
      return valueParts.join('=');
    }
  }
  return '';
}

function pruneFebboxAuthStates() {
  const now = Date.now();
  for (const [state, expiresAt] of febboxAuthStates) {
    if (expiresAt <= now) febboxAuthStates.delete(state);
  }
}

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false, limit: '8kb' }));

app.get('/auth/febbox', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const callbackUrl = requestBaseUrl(req) + '/auth/febbox/callback';

  if (!FEBBOX_CLIENT_ID || !FEBBOX_AUTH_SECRET) {
    return res.status(503).type('html').send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Febbox authorization unavailable</title></head>
<body>
  <h1>Febbox authorization is not configured</h1>
  <p>Set FEBBOX_CLIENT_ID and FEBBOX_AUTH_SECRET in the addon environment.</p>
</body>
</html>`);
  }

  const successMsg = req.query.success || '';
  const errorMsg = req.query.error || '';
  const accounts = febboxAPI.getAccountsInfo();

  const accountsHtml = accounts.length > 0
    ? accounts.map(acc => `
      <div class="card ${acc.expired ? 'expired' : ''}">
        <div class="card-header">
          <span class="avatar">${acc.uid.toString().slice(-3) || 'FB'}</span>
          <div>
            <div class="uid">UID: ${acc.uid}</div>
            <div class="expiry">Expires: ${acc.expiresAt}</div>
          </div>
        </div>
        <div class="card-body">
          <span class="badge ${acc.expired ? 'badge-expired' : 'badge-active'}">
            ${acc.expired ? 'Expired' : 'Active'}
          </span>
          <form class="delete-form" method="post" action="/auth/febbox/delete" onsubmit="return confirmDelete('${acc.uid}')">
            <input type="hidden" name="uid" value="${acc.uid}">
            <input type="password" name="secret" placeholder="Secret Admin PW" required autocomplete="current-password">
            <button type="submit" class="btn-danger">Remove</button>
          </form>
        </div>
      </div>
    `).join('')
    : `<div class="no-accounts">No active Febbox accounts connected yet. Connect an account on the right to get started!</div>`;

  return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Febbox Account Manager - Showbox Febbox Addon</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient-start: #08080c;
      --bg-gradient-end: #12121c;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.08);
      --success: #10b981;
      --danger: #ef4444;
      --input-bg: rgba(0, 0, 0, 0.25);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', sans-serif;
      background: linear-gradient(135deg, var(--bg-gradient-start), var(--bg-gradient-end));
      color: var(--text);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 2rem;
    }
    
    .container {
      width: 100%;
      max-width: 900px;
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 3rem;
      backdrop-filter: blur(25px);
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.4);
    }
    
    h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      background: linear-gradient(to right, #a5b4fc, #6366f1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-align: center;
    }
    
    .subtitle {
      color: var(--text-muted);
      text-align: center;
      margin-bottom: 3rem;
      font-size: 1.15rem;
    }
    
    .section-title {
      font-size: 1.3rem;
      font-weight: 600;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 0.75rem;
      color: #e5e7eb;
    }
    
    .grid {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 3rem;
    }
    
    @media (max-width: 850px) {
      .grid {
        grid-template-columns: 1fr;
        gap: 2.5rem;
      }
    }
    
    .accounts-list {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      max-height: 450px;
      overflow-y: auto;
      padding-right: 0.75rem;
    }
    
    .accounts-list::-webkit-scrollbar {
      width: 6px;
    }
    
    .accounts-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.12);
      border-radius: 3px;
    }
    
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 1.5rem;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .card:hover {
      transform: translateY(-2px);
      border-color: rgba(99, 102, 241, 0.45);
      background: rgba(255, 255, 255, 0.05);
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    }
    
    .card.expired {
      border-color: rgba(239, 68, 68, 0.3);
    }
    
    .card-header {
      display: flex;
      align-items: center;
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }
    
    .avatar {
      width: 46px;
      height: 46px;
      background: linear-gradient(135deg, #4f46e5, #818cf8);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 1rem;
      color: #fff;
      box-shadow: 0 4px 12px rgba(79, 70, 229, 0.35);
    }
    
    .uid {
      font-weight: 600;
      font-size: 1.15rem;
      color: #f9fafb;
    }
    
    .expiry {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 0.2rem;
    }
    
    .card-body {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    
    .badge {
      font-size: 0.8rem;
      font-weight: 600;
      padding: 0.35rem 0.85rem;
      border-radius: 50px;
      letter-spacing: 0.025em;
    }
    
    .badge-active {
      background: rgba(16, 185, 129, 0.12);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.25);
    }
    
    .badge-expired {
      background: rgba(239, 68, 68, 0.12);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.25);
    }
    
    .no-accounts {
      color: var(--text-muted);
      text-align: center;
      padding: 4rem 1.5rem;
      border: 2px dashed var(--card-border);
      border-radius: 16px;
      font-style: italic;
      line-height: 1.6;
    }
    
    form {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    
    label {
      font-size: 0.95rem;
      color: var(--text-muted);
      font-weight: 500;
    }
    
    input[type="password"] {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 0.85rem 1.15rem;
      color: #fff;
      font-family: inherit;
      outline: none;
      font-size: 0.95rem;
      transition: all 0.2s;
    }
    
    input[type="password"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }
    
    button {
      font-family: inherit;
      font-weight: 600;
      border: none;
      border-radius: 12px;
      padding: 0.85rem 1.75rem;
      cursor: pointer;
      font-size: 0.95rem;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), #4338ca);
      color: #fff;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.35);
    }
    
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.45);
      background: linear-gradient(135deg, var(--accent-hover), #3730a3);
    }
    
    .delete-form {
      display: flex;
      flex-direction: row;
      gap: 0.6rem;
      align-items: center;
    }
    
    .delete-form input[type="password"] {
      width: 130px;
      padding: 0.45rem 0.85rem;
      font-size: 0.85rem;
      border-radius: 8px;
    }
    
    .btn-danger {
      background: rgba(239, 68, 68, 0.1);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.2);
      font-size: 0.85rem;
      padding: 0.45rem 1rem;
      border-radius: 8px;
    }
    
    .btn-danger:hover {
      background: var(--danger);
      color: #fff;
      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.35);
    }
    
    .notification {
      padding: 1rem 1.5rem;
      border-radius: 14px;
      margin-bottom: 2.5rem;
      text-align: center;
      font-size: 1rem;
      font-weight: 500;
    }
    
    .success-alert {
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
    }
    
    .danger-alert {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
  </style>
  <script>
    function confirmDelete(uid) {
      return confirm('Are you sure you want to remove the Febbox account with UID ' + uid + '?');
    }
  </script>
</head>
<body>
  <div class="container">
    <h1>Febbox Account Manager</h1>
    <div class="subtitle">Securely connect and rotate multiple accounts for stream generation</div>
    
    ${successMsg ? `<div class="notification success-alert">${successMsg}</div>` : ''}
    ${errorMsg ? `<div class="notification danger-alert">${errorMsg}</div>` : ''}
    
    <div class="grid">
      <div>
        <div class="section-title">
          <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
          Connected Accounts (${accounts.length})
        </div>
        <div class="accounts-list">
          ${accountsHtml}
        </div>
      </div>
      
      <div>
        <div class="section-title">
          <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"></path></svg>
          Add / Renew Account
        </div>
        
        <div class="instructions" style="margin-bottom: 2rem; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--card-border); padding: 1.25rem; border-radius: 16px; font-size: 0.9rem; line-height: 1.5; text-align: left;">
          <h4 style="font-weight: 600; color: #fff; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            How to Connect a New Account:
          </h4>
          <ol style="padding-left: 1.1rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 0.4rem;">
            <li>Log in to your new Google/Febbox account on <a href="https://www.febbox.com" target="_blank" style="color: var(--accent); text-decoration: none;">febbox.com</a>.</li>
            <li>Go to <a href="https://www.febbox.com/open/clients" target="_blank" style="color: var(--accent); text-decoration: none;">febbox.com/open/clients</a> and click **Create Client**.</li>
            <li>Use this exact **Redirect URI / Jump URL**:
              <code style="display: block; background: rgba(0,0,0,0.3); padding: 0.4rem; border-radius: 8px; margin-top: 0.25rem; font-family: monospace; word-break: break-all; color: #a5b4fc; font-size: 0.8rem;">${callbackUrl}</code>
            </li>
            <li>Copy the generated **Client ID** and paste it below.</li>
          </ol>
        </div>

        <form method="post" action="/auth/febbox">
          <div class="form-group">
            <label for="client_id">Febbox Client ID (for this account)</label>
            <input type="password" id="client_id" name="client_id" placeholder="Paste generated Client ID (or leave blank for default)">
          </div>
          <div class="form-group">
            <label for="secret">Admin authorization password</label>
            <input type="password" id="secret" name="secret" required placeholder="Enter administration secret">
          </div>
          <button type="submit" class="btn-primary">Connect via Febbox/Google</button>
        </form>
      </div>
    </div>
  </div>
</body>
</html>`);
});

app.post('/auth/febbox/delete', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!secretsMatch(req.body?.secret)) {
    return res.status(403).redirect('/auth/febbox?error=Invalid+authorization+password');
  }

  const { uid } = req.body;
  if (!uid) {
    return res.status(400).redirect('/auth/febbox?error=Account+UID+is+required');
  }

  try {
    febboxAPI.removeCookie(uid);
    cache.clear();
    console.log(`[ShowboxFebbox] Febbox account ${uid} removed successfully`);
    return res.redirect(302, '/auth/febbox?success=Account+removed+successfully');
  } catch (error) {
    console.error('[ShowboxFebbox] failed to remove Febbox account: ' + error.message);
    return res.status(500).redirect('/auth/febbox?error=Failed+to+remove+account');
  }
});

app.post('/auth/febbox', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!FEBBOX_CLIENT_ID || !FEBBOX_AUTH_SECRET) {
    return res.status(503).send('Febbox authorization is not configured');
  }
  if (!secretsMatch(req.body?.secret)) {
    return res.status(403).redirect('/auth/febbox?error=Invalid+authorization+password');
  }

  pruneFebboxAuthStates();
  const state = crypto.randomBytes(32).toString('hex');
  febboxAuthStates.set(state, Date.now() + FEBBOX_AUTH_STATE_TTL_MS);
  res.cookie('showbox_febbox_auth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: FEBBOX_AUTH_STATE_TTL_MS,
    path: '/'
  });

  const customClientId = String(req.body?.client_id || '').trim();
  const clientIdToUse = customClientId || FEBBOX_CLIENT_ID;

  const callbackUrl = requestBaseUrl(req) + '/auth/febbox/callback';
  const authorizeUrl = new URL('https://www.febbox.com/login/google');
  authorizeUrl.searchParams.set('client_id', clientIdToUse);
  authorizeUrl.searchParams.set('jump', callbackUrl);
  authorizeUrl.searchParams.set('prompt', 'select_account');
  return res.redirect(302, authorizeUrl.toString());
});

app.get('/auth/febbox/callback', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const state = requestCookie(req, 'showbox_febbox_auth_state');
  const expiresAt = febboxAuthStates.get(state);
  febboxAuthStates.delete(state);
  res.clearCookie('showbox_febbox_auth_state', { path: '/' });

  if (!state || !expiresAt || expiresAt <= Date.now()) {
    return res.status(400).redirect('/auth/febbox?error=Invalid+or+expired+Febbox+authorization+attempt');
  }

  const authToken = String(req.query.auth_token || req.query.auto_token || '')
    .trim()
    .replace(/^ui=/, '');
  if (!authToken || authToken.length > 8192) {
    return res.status(400).redirect('/auth/febbox?error=Febbox+did+not+return+a+valid+authorization+token');
  }

  try {
    febboxAPI.replaceCookies([authToken]);
    cache.clear();
    console.log('[ShowboxFebbox] Febbox authorization renewed successfully');
  } catch (error) {
    console.error('[ShowboxFebbox] failed to store Febbox authorization: ' + error.message);
    return res.status(500).redirect('/auth/febbox?error=Failed+to+store+Febbox+authorization');
  }

  return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorization Renewed - Showbox Febbox Addon</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Outfit', sans-serif;
      background: linear-gradient(135deg, #08080c, #12121c);
      color: #f3f4f6;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 2rem;
      margin: 0;
    }
    .card {
      width: 100%;
      max-width: 480px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      padding: 3rem;
      backdrop-filter: blur(25px);
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.4);
      text-align: center;
    }
    .icon {
      width: 64px;
      height: 64px;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.25);
      color: #10b981;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem auto;
      box-shadow: 0 8px 20px rgba(16, 185, 129, 0.15);
    }
    h1 {
      font-size: 1.85rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
      color: #fff;
    }
    p {
      color: #9ca3af;
      font-size: 1rem;
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    .btn {
      display: inline-block;
      font-family: inherit;
      font-weight: 600;
      border: none;
      border-radius: 12px;
      padding: 0.85rem 2rem;
      font-size: 0.95rem;
      text-decoration: none;
      background: linear-gradient(135deg, #6366f1, #4338ca);
      color: #fff;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.35);
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.45);
      background: linear-gradient(135deg, #4f46e5, #3730a3);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path></svg>
    </div>
    <h1>Authorization Successful</h1>
    <p>The new Febbox account has been connected and is active immediately. You may now close this window or return to the manager.</p>
    <a href="/auth/febbox" class="btn">Back to Manager</a>
  </div>
</body>
</html>`);
});

app.use('/', getRouter(builder.getInterface()));

app.get('/', (req, res) => {
  const baseUrl = requestBaseUrl(req);
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Showbox Febbox - Stremio Addon</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient-start: #08080c;
      --bg-gradient-end: #12121c;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.08);
      --input-bg: rgba(0, 0, 0, 0.25);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', sans-serif;
      background: linear-gradient(135deg, var(--bg-gradient-start), var(--bg-gradient-end));
      color: var(--text);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 2rem;
    }
    
    .container {
      width: 100%;
      max-width: 800px;
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--card-border);
      border-radius: 28px;
      padding: 3.5rem;
      backdrop-filter: blur(25px);
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.4);
      text-align: center;
    }
    
    .logo-container {
      margin-bottom: 2rem;
      display: inline-flex;
      justify-content: center;
      align-items: center;
      width: 80px;
      height: 80px;
      border-radius: 20px;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      box-shadow: 0 10px 30px rgba(99, 102, 241, 0.35);
      color: white;
    }

    h1 {
      font-size: 2.8rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
      background: linear-gradient(to right, #a5b4fc, #6366f1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.02em;
    }
    
    .subtitle {
      color: var(--text-muted);
      margin-bottom: 3rem;
      font-size: 1.2rem;
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
      line-height: 1.6;
    }

    .btn-group {
      display: flex;
      justify-content: center;
      gap: 1.25rem;
      margin-bottom: 3.5rem;
      flex-wrap: wrap;
    }

    .btn {
      font-family: inherit;
      font-weight: 600;
      font-size: 1rem;
      border: none;
      border-radius: 14px;
      padding: 0.9rem 1.8rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      text-decoration: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--accent), #4338ca);
      color: #fff;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.35);
    }
    
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.45);
      background: linear-gradient(135deg, var(--accent-hover), #3730a3);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      border: 1px solid var(--card-border);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.08);
      transform: translateY(-2px);
    }

    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.5rem;
      text-align: left;
    }

    .feature-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 18px;
      padding: 1.5rem;
      transition: all 0.3s ease;
    }

    .feature-card:hover {
      border-color: rgba(99, 102, 241, 0.35);
      background: rgba(255, 255, 255, 0.05);
      transform: translateY(-2px);
    }

    .feature-icon {
      color: var(--accent);
      margin-bottom: 1rem;
      display: flex;
    }

    .feature-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: #f3f4f6;
      margin-bottom: 0.5rem;
    }

    .feature-desc {
      font-size: 0.9rem;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .manifest-input-container {
      margin-top: 3rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--input-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 0.5rem 0.5rem 0.5rem 1rem;
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
    }

    .manifest-url {
      font-family: monospace;
      font-size: 0.9rem;
      color: #a5b4fc;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex-grow: 1;
      text-align: left;
    }

    .btn-copy {
      font-size: 0.85rem;
      padding: 0.5rem 1rem;
      border-radius: 8px;
    }
  </style>
  <script>
    function copyManifestLink(url) {
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.textContent = 'Copied!';
        btn.style.background = '#10b981';
        btn.style.color = '#fff';
        setTimeout(() => {
          btn.textContent = 'Copy Link';
          btn.style.background = '';
          btn.style.color = '';
        }, 2000);
      });
    }
  </script>
</head>
<body>
  <div class="container">
    <div class="logo-container">
      <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7 4v16M17 4v16M3 8h18M3 16h18"></path>
      </svg>
    </div>
    <h1>Showbox Febbox Addon</h1>
    <div class="subtitle">Stream high-quality torrents and cloud links directly in Stremio. Fast resolution, multiple account management, and integrated proxy support.</div>
    
    <div class="btn-group">
      <a href="stremio://${baseUrl.replace(/^https?:\/\//, '')}/manifest.json" class="btn btn-primary">
        <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
        Install to Stremio
      </a>
      <a href="/auth/febbox" class="btn btn-secondary">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        Configure Accounts
      </a>
    </div>

    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-icon">
          <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        </div>
        <div class="feature-title">High Speed Streaming</div>
        <div class="feature-desc">Streams media files directly from your Febbox secure cloud storage with minimal latency.</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">
          <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
        </div>
        <div class="feature-title">Cloudflare Bypass</div>
        <div class="feature-desc">Integrated Python scraper automatically resolves Showbox Cloudflare challenge pages seamlessly.</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">
          <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18.2M7 9h.01M17 15h.01M12 12h.01m-4.01 4h8.02M8 8h8a2 2 0 012 2v8a2 2 0 01-2 2H8a2 2 0 01-2-2v-8a2 2 0 012-2z"/></svg>
        </div>
        <div class="feature-title">Account Rotation</div>
        <div class="feature-desc">Dynamically rotates between multiple connected Febbox accounts to split traffic and avoid rate limits.</div>
      </div>
    </div>

    <div class="manifest-input-container">
      <div class="manifest-url">${baseUrl}/manifest.json</div>
      <button id="copyBtn" class="btn btn-secondary btn-copy" onclick="copyManifestLink('${baseUrl}/manifest.json')">Copy Link</button>
    </div>
  </div>
</body>
</html>`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: manifest.name, version: manifest.version });
});

app.listen(PORT, () => {
  console.log(`[ShowboxFebbox] Stremio addon listening on http://127.0.0.1:${PORT}`);
});
