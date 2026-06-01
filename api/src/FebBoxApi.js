import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import dotenv from 'dotenv';

dotenv.config();

function parseCookiePool(...values) {
    return [...new Set(values
        .flatMap(value => String(value || '').split(/[\n,]+/))
        .map(value => value.trim())
        .filter(Boolean)
        .map(value => value.replace(/^ui=/, ''))
    )];
}

const FEBBOX_UI_COOKIES = parseCookiePool(process.env.FEBBOX_UI_COOKIE, process.env.FEBBOX_UI_COOKIES);

class FebboxAPI {
    constructor() {
        this.baseUrl = 'https://www.febbox.com';
        this.headers = this._getDefaultHeaders();
        this.cookies = FEBBOX_UI_COOKIES;
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
        if (!response.ok) throw new Error('Error fetching data from ' + url + ': ' + response.statusText);

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

        const cookieAttempts = authFirst ? this.cookies : [null, ...this.cookies];
        let lastError = null;

        for (const candidateCookie of cookieAttempts) {
            try {
                return await this._fetchJsonOnce(url, candidateCookie);
            } catch (error) {
                lastError = error;
                if (!/FEBBOX_UI_COOKIE|Login - FEB|Unexpected token/.test(error.message)) throw error;
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
