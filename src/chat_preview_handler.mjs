/**
 * chat_preview_handler.mjs — Link previews for external chat clients.
 *
 * The server fetches the linked page instead of the client, so people posting links cannot
 * learn chat participants' IP addresses. Preview images are proxied through signed URLs.
 *
 * Routes (registered as bypass middlewares in index.mjs):
 *   GET /api/chat/preview?url=...                 — page metadata, X-API-Key (upload key) required
 *   GET /api/chat/preview/image?url=...&sig=...   — proxied preview image, signature required
 *
 * Fetches refuse private, loopback and link-local addresses (checked again on every redirect),
 * are size and time limited, and results are cached.
 */

import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';
import crypto from 'crypto';
import cfg from './inc/config.mjs';
import { authKey } from './chat_upload_handler.mjs';

const isEnabled = () => cfg.websrv.chat_uploads !== false && cfg.websrv.chat_link_previews !== false;

const USER_AGENT = 'Mozilla/5.0 (compatible; f0ckm-linkpreview/1.0)';
const TIMEOUT_MS = 6000;
const MAX_HTML = 768 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const CACHE_TTL = 6 * 3600 * 1000;
const FAIL_TTL = 30 * 60 * 1000;
const CACHE_MAX = 2000;

// Signs image URLs so the image route cannot be used as an open proxy
const SECRET = crypto.randomBytes(32);
const sign = url => crypto.createHmac('sha256', SECRET).update(url).digest('base64url').slice(0, 32);

const cache = new Map();

function sendJson(res, data, code = 200) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// ─── Private address guard ────────────────────────────────────────────────────

function isPrivateV4(ip) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

export function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) return isPrivateV4(ip);
    const v6 = ip.toLowerCase();
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateV4(mapped[1]);
    return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

// DNS lookup that only returns public addresses; the socket connects to exactly these
function safeLookup(hostname, options, callback) {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
        if (err) return callback(err);
        const ok = addresses.filter(a => !isPrivateAddress(a.address));
        if (!ok.length) return callback(new Error('Refusing private address'));
        if (options?.all) return callback(null, ok);
        callback(null, ok[0].address, ok[0].family);
    });
}

// GET with redirects, each hop validated; resolves with the response stream
function safeGet(rawUrl, accept, hops = 0) {
    return new Promise((resolve, reject) => {
        let url;
        try { url = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }
        if (!/^https?:$/.test(url.protocol)) return reject(new Error('Unsupported protocol'));
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (net.isIP(host) && isPrivateAddress(host)) return reject(new Error('Refusing private address'));

        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.get(url, {
            lookup: safeLookup,
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT, 'Accept': accept, 'Accept-Language': 'en,*;q=0.5' }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (hops >= MAX_REDIRECTS) return reject(new Error('Too many redirects'));
                return resolve(safeGet(new URL(res.headers.location, url).href, accept, hops + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            res.finalUrl = url.href;
            resolve(res);
        });
        req.on('timeout', () => req.destroy(new Error('Timed out')));
        req.on('error', reject);
    });
}

function readLimited(res, max, stopAt) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const timer = setTimeout(() => res.destroy(new Error('Timed out')), TIMEOUT_MS);
        res.on('data', chunk => {
            chunks.push(chunk);
            size += chunk.length;
            // Metadata lives in <head>; stop reading once it is complete
            if (size > max || (stopAt && chunk.toString('latin1').toLowerCase().includes(stopAt))) res.destroy();
        });
        const done = () => { clearTimeout(timer); resolve(Buffer.concat(chunks).subarray(0, max)); };
        res.on('end', done);
        res.on('close', done);
        res.on('error', e => { clearTimeout(timer); chunks.length ? done() : reject(e); });
    });
}

// ─── Metadata parsing ─────────────────────────────────────────────────────────

const decodeEntities = s => s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const clean = (s, max) => {
    if (!s) return '';
    const t = decodeEntities(s).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

export function parsePreview(html, pageUrl) {
    const head = html.split(/<\/head>/i)[0];
    const meta = {};
    for (const [, attrs] of head.matchAll(/<meta\s+([^>]+?)\/?>/gi)) {
        const a = {};
        for (const m of attrs.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
            a[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
        }
        const key = (a.property || a.name || '').toLowerCase();
        if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
    }
    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
    const abs = u => { try { const x = new URL(decodeEntities(u), pageUrl); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
    const image = abs(meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'] || '');
    const color = /^#[0-9a-f]{3,8}$/i.test(meta['theme-color'] ?? '') ? meta['theme-color'] : '';
    return {
        title: clean(meta['og:title'] || meta['twitter:title'] || titleTag, 200),
        description: clean(meta['og:description'] || meta['twitter:description'] || meta['description'], 400),
        site: clean(meta['og:site_name'] || new URL(pageUrl).hostname.replace(/^www\./, ''), 80),
        image,
        large: meta['twitter:card'] === 'summary_large_image' || Number(meta['og:image:width']) >= 600,
        color
    };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

async function buildPreview(url) {
    const res = await safeGet(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1');
    const type = String(res.headers['content-type'] || '');
    if (!/text\/html|application\/xhtml/i.test(type)) {
        res.resume();
        throw new Error('Not an HTML page');
    }
    const charset = /charset=([\w-]+)/i.exec(type)?.[1]?.toLowerCase() || 'utf-8';
    const body = await readLimited(res, MAX_HTML, '</head>');
    let html;
    try { html = new TextDecoder(charset).decode(body); } catch { html = body.toString('utf8'); }
    const p = parsePreview(html, res.finalUrl);
    if (!p.title && !p.description) throw new Error('No preview data');
    return { ...p, url: res.finalUrl };
}

export async function handleChatPreview(req, res) {
    if (!isEnabled()) return sendJson(res, { success: false, msg: 'Not found' }, 404);
    const key = await authKey(req, res);
    if (!key) return;
    const url = String(req.url.qs?.url || new URLSearchParams(req.url.search || '').get('url') || '').slice(0, 2048);
    if (!/^https?:\/\//i.test(url)) return sendJson(res, { success: false, msg: 'Invalid URL' }, 400);

    const hit = cache.get(url);
    let result;
    if (hit && hit.expires > Date.now()) {
        result = hit.value;
    } else {
        try {
            result = { success: true, ...(await buildPreview(url)) };
            cache.set(url, { value: result, expires: Date.now() + CACHE_TTL });
        } catch (e) {
            result = { success: false, msg: e.message };
            cache.set(url, { value: result, expires: Date.now() + FAIL_TTL });
        }
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    if (!result.success) return sendJson(res, result, 200);

    const base = (cfg.main?.url?.full || '').replace(/\/+$/, '');
    const image = result.image ? `${base}/api/chat/preview/image?url=${encodeURIComponent(result.image)}&sig=${sign(result.image)}` : '';
    return sendJson(res, { ...result, image });
}

export async function handleChatPreviewImage(req, res) {
    const fail = (code = 404) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end('Not available'); };
    if (!isEnabled()) return fail();
    const params = new URLSearchParams(req.url.search || '');
    const url = String(req.url.qs?.url || params.get('url') || '');
    const sig = String(req.url.qs?.sig || params.get('sig') || '');
    const expected = sign(url);
    if (!url || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return fail(403);

    try {
        const up = await safeGet(url, 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9');
        const type = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) { up.resume(); return fail(415); }
        const body = await readLimited(up, MAX_IMAGE + 1);
        if (body.length > MAX_IMAGE) return fail(413);
        res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': String(body.length),
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin'
        });
        res.end(body);
    } catch {
        return fail(502);
    }
}
