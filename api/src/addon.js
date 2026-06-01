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
const MAX_FILES_TO_LINK = Number(process.env.MAX_FILES_TO_LINK || 12);
const MAX_TRAVERSAL_DEPTH = Number(process.env.MAX_TRAVERSAL_DEPTH || 3);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v']);

const showboxAPI = new ShowboxAPI();
const febboxAPI = new FebboxAPI();
const cache = new Map();

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

function streamSortRank(link) {
  const quality = String(link?.quality || '').toLowerCase();
  if (quality === '1080p') return 10;
  if (quality === '720p') return 20;
  if (quality === '480p') return 30;
  if (quality === '360p') return 40;
  if (quality === 'org') return 90;
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

async function linksForFile(shareKey, file) {
  const links = await febboxAPI.getLinks(shareKey, file.fid);
  return (Array.isArray(links) ? links : [])
    .filter((link) => link?.url)
    .sort((a, b) => streamSortRank(a) - streamSortRank(b))
    .map((link) => ({
      name: 'Showbox Febbox',
      title: streamTitle(link, file),
      url: link.url,
      behaviorHints: {
        bingeGroup: `showbox-febbox-${link.quality || 'auto'}`
      }
    }));
}

async function resolveStreams(type, id) {
  const parsedId = parseStremioId(id);
  if (!/^tt\d+/.test(parsedId.imdbId)) return [];

  const cacheKey = `streams:${type}:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const meta = await getMeta(type, parsedId.imdbId);
  if (!meta) return cacheSet(cacheKey, [], 10 * 60 * 1000);

  console.log(`[ShowboxFebbox] Looking up ${meta.title} (${meta.year || 'year unknown'})`);
  const item = await findShowboxItem(meta);
  if (!item) return cacheSet(cacheKey, [], 10 * 60 * 1000);

  const shareKey = await showboxAPI.getFebBoxId(item.id, item.box_type);
  if (!shareKey) return cacheSet(cacheKey, [], 10 * 60 * 1000);

  const files = selectFiles(await collectFiles(shareKey), parsedId);
  const streams = [];

  for (const file of files) {
    if (streams.length >= MAX_FILES_TO_LINK) break;
    try {
      streams.push(...await linksForFile(shareKey, file));
    } catch (error) {
      console.warn(`[ShowboxFebbox] link extraction failed for ${fileName(file)}: ${error.message}`);
      streams.push({
        name: "Showbox Febbox",
        title: `Open Febbox\n${fileName(file)}\n${error.message}`,
        externalUrl: `https://www.febbox.com/share/${shareKey}`
      });
    }
  }

  return cacheSet(cacheKey, streams);
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
