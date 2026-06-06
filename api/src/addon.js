import fs from 'fs';
import path from 'path';
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
const PROXY_ORIGINAL_STREAMS = process.env.PROXY_ORIGINAL_STREAMS === '1';
const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v']);

const showboxAPI = new ShowboxAPI();
const febboxAPI = new FebboxAPI();
const cache = new Map();
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

function mediaflowProxyUrl(link) {
  const originalUrl = link?.url;
  if (!USE_MEDIAFLOW_PROXY || !MEDIAFLOW_PASSWORD || !originalUrl) return originalUrl;

  if (isOriginalStream(link)) {
    if (!PROXY_ORIGINAL_STREAMS) return originalUrl;
    return MEDIAFLOW_URL + '/proxy/stream?url=' + encodeURIComponent(originalUrl) + '&api_password=' + encodeURIComponent(MEDIAFLOW_PASSWORD);
  }

  return MEDIAFLOW_URL + '/proxy/hls/manifest.m3u8?d=' + encodeURIComponent(originalUrl) + '&api_password=' + encodeURIComponent(MEDIAFLOW_PASSWORD);
}

async function linksForFile(shareKey, file) {
  const links = await febboxAPI.getLinks(shareKey, file.fid);
  return (Array.isArray(links) ? links : [])
    .filter((link) => link?.url && shouldKeepStream(link))
    .sort((a, b) => streamSortRank(a) - streamSortRank(b))
    .map((link) => ({
      name: 'Showbox Febbox',
      title: streamTitle(link, file),
      url: mediaflowProxyUrl(link),
      behaviorHints: {
        bingeGroup: `showbox-febbox-${link.quality || 'auto'}`
      }
    }));
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

  const proxyMode = USE_MEDIAFLOW_PROXY ? `mediaflow:${PROXY_ORIGINAL_STREAMS ? 'all' : 'hls'}:${MEDIAFLOW_URL}` : 'direct';
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
  }))).flat().slice(0, TARGET_STREAM_COUNT);

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

const app = express();
app.use(cors());
app.use('/', getRouter(builder.getInterface()));

app.get('/', (req, res) => {
  const baseUrl = requestBaseUrl(req);
  res.type('html').send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Showbox Febbox Stremio Addon</title></head>
<body>
  <h1>Showbox Febbox Stremio Addon</h1>
  <p>Install manifest: <a href="${baseUrl}/manifest.json">${baseUrl}/manifest.json</a></p>
</body>
</html>`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: manifest.name, version: manifest.version });
});

app.listen(PORT, () => {
  console.log(`[ShowboxFebbox] Stremio addon listening on http://127.0.0.1:${PORT}`);
});
