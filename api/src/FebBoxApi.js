import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

function parseCookiePool(...values) {
    return [...new Set(values
        .flatMap(value => String(value || '').split(/[\n,]+/))
        .map(value => value.trim())
        .filter(Boolean)
        .map(value => value.replace(/^ui=/, ''))
    )];
}

const COOKIE_FILE = process.env.FEBBOX_COOKIE_FILE || path.join(process.cwd(), 'data', 'febbox-ui-cookies.json');
const COOKIE_EXPIRY_SKEW_SECONDS = Number(process.env.FEBBOX_COOKIE_EXPIRY_SKEW_SECONDS || 24 * 60 * 60);
const RETRYABLE_STATUSES = new Set([401, 403, 408, 429, 500, 502, 503, 504]);

function loadStoredCookies() {
    try {
        if (!fs.existsSync(COOKIE_FILE)) return [];
        const stored = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
        return parseCookiePool(Array.isArray(stored) ? stored : stored?.cookies);
    } catch (error) {
        console.warn('[ShowboxFebbox] failed to load Febbox cookie file: ' + error.message);
        return [];
    }
}

function jwtExpiresSoon(cookie) {
    try {
        const payload = JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url').toString('utf8'));
        return Number(payload.exp) > 0
            && Number(payload.exp) <= Math.floor(Date.now() / 1000) + COOKIE_EXPIRY_SKEW_SECONDS;
    } catch {
        return false;
    }
}

class FebboxAPI {
    constructor() {
        this.baseUrl = 'https://www.febbox.com';
        this.headers = this._getDefaultHeaders();
        this.cookies = parseCookiePool(
            loadStoredCookies(),
            process.env.FEBBOX_UI_COOKIE,
            process.env.FEBBOX_UI_COOKIES
        );
    }

    replaceCookies(values) {
        const cookies = parseCookiePool(values);
        if (!cookies.length) throw new Error('Cannot save an empty Febbox cookie pool');

        const directory = path.dirname(COOKIE_FILE);
        const temporaryFile = COOKIE_FILE + '.tmp-' + process.pid;
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(temporaryFile, JSON.stringify({ cookies }, null, 2), { mode: 0o600 });
        fs.chmodSync(temporaryFile, 0o600);
        fs.renameSync(temporaryFile, COOKIE_FILE);
        fs.chmodSync(COOKIE_FILE, 0o600);
        this.cookies = cookies;
    }

    _usableCookies() {
        return this.cookies.filter(cookie => !jwtExpiresSoon(cookie));
    }

    _getDefaultHeaders() {
        return {
            'x-requested-with': 'XMLHttpRequest',
            'accept': 'application/json, text/javascript, */*; q=0.01',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        };
    }

    _setReferer(shareKey) {
        this.headers.referer = this.baseUrl + '/share/' + shareKey;
    }

    _authHeaders(cookie = null) {
        return {
            ...this.headers,
            ...(cookie ? { cookie: 'ui=' + cookie } : {})
        };
    }

    async _fetchJsonOnce(url, cookie = null) {
        const response = await fetch(url, { headers: this._authHeaders(cookie) });
        const text = await response.text();
        if (!response.ok) {
            const error = new Error('Error fetching data from ' + url + ': ' + response.status + ' ' + response.statusText);
            error.status = response.status;
            throw error;
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            if (text.includes('<title>Login - FEB</title>')) {
                throw new Error('Febbox direct links require FEBBOX_UI_COOKIE or FEBBOX_UI_COOKIES');
            }
            throw error;
        }
    }

    async _fetchJson(url, cookie = null, { authFirst = false } = {}) {
        if (cookie) return this._fetchJsonOnce(url, cookie);

        const usableCookies = this._usableCookies();
        if (authFirst && !usableCookies.length) {
            throw new Error('Febbox authentication expired; renew it at /auth/febbox');
        }

        const cookieAttempts = authFirst ? usableCookies : [null, ...usableCookies];
        let lastError = null;

        for (const candidateCookie of cookieAttempts) {
            try {
                return await this._fetchJsonOnce(url, candidateCookie);
            } catch (error) {
                lastError = error;
                const retryable = RETRYABLE_STATUSES.has(error.status)
                    || /FEBBOX_UI_COOKIE|Login - FEB|Unexpected token/.test(error.message);
                if (!retryable) throw error;
            }
        }

        throw lastError || new Error('Febbox request failed');
    }

    async getFileList(shareKey, parentId = 0, cookie = null) {
        const url = this.baseUrl + '/file/file_share_list?share_key=' + shareKey + '&pwd=&parent_id=' + parentId + '&is_html=0';
        this._setReferer(shareKey);

        const data = await this._fetchJson(url, cookie);
        return data.data.file_list;
    }

    async getLinks(shareKey, fid, cookie = null) {
        const url = this.baseUrl + '/console/video_quality_list?fid=' + fid;
        this._setReferer(shareKey);

        const data = await this._fetchJson(url, cookie, { authFirst: true });
        const htmlResponse = data.html;

        const dom = new JSDOM(htmlResponse);
        const doc = dom.window.document;

        return this._extractFileQualities(doc);
    }

    _extractFileQualities(doc) {
        return Array.from(doc.querySelectorAll('.file_quality')).map(fileDiv => {
            const url = fileDiv.getAttribute('data-url');
            const quality = fileDiv.getAttribute('data-quality');
            const name = fileDiv.querySelector('.name')?.textContent.trim();
            const speed = fileDiv.querySelector('.speed span')?.textContent.trim();
            const size = fileDiv.querySelector('.size')?.textContent.trim();

            return { url, quality, name, speed, size };
        });
    }
}

export default FebboxAPI;
