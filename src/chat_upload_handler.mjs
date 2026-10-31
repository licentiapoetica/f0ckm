/**
 * chat_upload_handler.mjs — Temporary public file hosting for external chat clients.
 *
 * Auth is a dedicated upload-only key from the upload_api_keys table (not a user API key),
 * managed with scripts/chat-upload-key.mjs. Files live in cfg.paths.cu and always expire.
 *
 * Routes (registered as bypass middlewares in index.mjs):
 *   GET    /api/chat/upload            — allowed types and limits, X-API-Key required
 *   POST   /api/chat/upload            — raw file as request body, X-API-Key required
 *   DELETE /api/chat/upload/:slug      — X-Delete-Token (returned by the upload) required
 *   GET    /cu/:slug[/:name]           — public download, Range supported
 *
 * Allowed types follow the normal upload rules: cfg.allowedMimes categories resolved against
 * cfg.mimes, overridable with websrv.chat_upload_mimes (same format as fileupload_comments_mimes).
 *
 * Upload request headers:
 *   X-API-Key        upload key
 *   Content-Type     client mime type; rejected early if not allowed, then verified with `file`
 *   X-Filename       original file name (URI-encoded)
 *   X-Upload-Expiry  optional lifetime: seconds, or 30m / 1h / 24h / 7d / 30d; clamped to the max
 */

import { promises as fs, createReadStream, createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import db from './inc/sql.mjs';
import lib from './inc/lib.mjs';
import cfg from './inc/config.mjs';

// ─── Config ──────────────────────────────────────────────────────────────────

const UPLOAD_DIR = cfg.paths.cu;

const isEnabled     = () => cfg.websrv.chat_uploads !== false;
const maxBytes      = () => parseInt(cfg.websrv.chat_upload_max_bytes, 10) || 100 * 1024 * 1024;
const defaultExpiry = () => (parseInt(cfg.websrv.chat_upload_expiry_days, 10) || 30) * 86400;
const maxExpiry     = () => (parseInt(cfg.websrv.chat_upload_max_expiry_days, 10) || 30) * 86400;
const ratePerMinute = () => parseInt(cfg.websrv.chat_upload_rate_per_minute, 10) || 30;

// Same resolution as upload_handler: categories ("image") or exact types ("application/pdf")
export function getAllowedChatMimes() {
    const src = Array.isArray(cfg.websrv.chat_upload_mimes) ? cfg.websrv.chat_upload_mimes
        : Array.isArray(cfg.allowedMimes) ? cfg.allowedMimes : null;
    const all = Object.keys(cfg.mimes || {});
    if (!src) return all;
    const cats = src.map(c => String(c).toLowerCase());
    return all.filter(m => cats.some(cat => cat.includes('/') ? m === cat : m.startsWith(`${cat}/`)));
}

// Authoritative type check, the same `file` call the other upload handlers use
function detectMime(filePath) {
    return new Promise(resolve => {
        execFile('file', ['--mime-type', '-b', filePath], (err, stdout) => resolve(err ? '' : stdout.trim()));
    });
}

fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(e =>
    console.error('[CHAT_UP] Failed to create upload dir:', e.message)
);

// ─── Expiry cleanup ───────────────────────────────────────────────────────────

export async function cleanupExpiredChatUploads() {
    try {
        const expired = await db`SELECT id, slug FROM chat_uploads WHERE expires_at < now()`;
        if (!expired.length) return;
        for (const row of expired) {
            await fs.unlink(path.join(UPLOAD_DIR, row.slug)).catch(() => {});
        }
        await db`DELETE FROM chat_uploads WHERE id = ANY(${expired.map(r => r.id)})`;
        console.log(`[CHAT_UP] Cleanup: removed ${expired.length} expired upload(s)`);
    } catch (e) {
        console.error('[CHAT_UP] Cleanup error:', e.message);
    }
}

// Run once at startup, then hourly
cleanupExpiredChatUploads();
setInterval(cleanupExpiredChatUploads, 60 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res, data, code = 200) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// Sliding one-minute window per key id
const rateBuckets = new Map();
function rateLimited(keyId) {
    const now = Date.now();
    const hits = (rateBuckets.get(keyId) || []).filter(t => now - t < 60000);
    const limited = hits.length >= ratePerMinute();
    if (!limited) hits.push(now);
    rateBuckets.set(keyId, hits);
    return limited;
}

async function resolveKey(req) {
    const key = req.headers['x-api-key'];
    if (!key || typeof key !== 'string' || key.length > 200) return null;
    const rows = await db`
        SELECT id, name, max_bytes FROM upload_api_keys
        WHERE key_hash = ${lib.sha256(key)} AND revoked = false
        LIMIT 1
    `;
    return rows[0] || null;
}

export function parseExpiry(val) {
    if (!val) return defaultExpiry();
    const m = String(val).trim().toLowerCase().match(/^(\d+)\s*([smhdw]?)$/);
    if (!m) return defaultExpiry();
    const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2]];
    const secs = parseInt(m[1], 10) * mult;
    if (!secs) return defaultExpiry();
    return Math.min(Math.max(secs, 60), maxExpiry());
}

// Media plays in the browser; everything else (pdf, archives, flash) is served as a download
const isInlineMime = mime => /^(image|video|audio)\//.test(mime) && mime !== 'image/svg+xml';

function sanitizeName(raw) {
    let name;
    try { name = decodeURIComponent(String(raw || '')); } catch { name = String(raw || ''); }
    name = path.basename(name).replace(/[\x00-\x1f\x7f"\\/]/g, '').trim().slice(0, 120);
    return name || 'file';
}

// ─── Info ─────────────────────────────────────────────────────────────────────

const keyLimit = key => Math.min(maxBytes(), key.max_bytes ? Number(key.max_bytes) : Infinity);

export async function authKey(req, res) {
    if (!isEnabled()) { sendJson(res, { success: false, msg: 'Not found' }, 404); return null; }
    let key;
    try { key = await resolveKey(req); } catch (e) {
        console.error('[CHAT_UP] Key lookup error:', e.message);
        sendJson(res, { success: false, msg: 'Server error' }, 500);
        return null;
    }
    if (!key) sendJson(res, { success: false, msg: 'Invalid API key' }, 401);
    return key;
}

// Lets clients validate files before uploading (and doubles as a key check)
export async function handleChatUploadInfo(req, res) {
    const key = await authKey(req, res);
    if (!key) return;
    const mimes = getAllowedChatMimes();
    return sendJson(res, {
        success:            true,
        allowed_mimes:      mimes,
        allowed_extensions: [...new Set(mimes.map(m => cfg.mimes[m]).filter(Boolean))],
        max_bytes:          keyLimit(key),
        default_expiry:     defaultExpiry(),
        max_expiry:         maxExpiry()
    });
}

// ─── Upload ───────────────────────────────────────────────────────────────────

export async function handleChatUpload(req, res) {
    const key = await authKey(req, res);
    if (!key) return;
    if (rateLimited(key.id)) return sendJson(res, { success: false, msg: 'Rate limit exceeded' }, 429);

    const limit = keyLimit(key);
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > limit) return sendJson(res, { success: false, msg: 'File too large', max_bytes: limit }, 413);

    // Cheap early reject on the client-declared type; the real type is checked after writing
    const allowed = getAllowedChatMimes();
    const hint = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase().slice(0, 100);
    if (hint && hint !== 'application/octet-stream' && !allowed.includes(hint)) {
        req.resume();
        return sendJson(res, { success: false, msg: `File type not allowed: ${hint}` }, 415);
    }

    const slug = crypto.randomBytes(9).toString('base64url');
    const filePath = path.join(UPLOAD_DIR, slug);
    const name = sanitizeName(req.headers['x-filename']);

    // Stream to disk, counting bytes
    let size = 0;
    let tooLarge = false;
    try {
        await new Promise((resolve, reject) => {
            const out = createWriteStream(filePath);
            req.on('data', chunk => {
                size += chunk.length;
                if (size > limit && !tooLarge) {
                    tooLarge = true;
                    req.unpipe(out);
                    out.destroy();
                    req.resume();
                    reject(new Error('BODY_TOO_LARGE'));
                }
            });
            req.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
            req.pipe(out);
        });
    } catch (e) {
        await fs.unlink(filePath).catch(() => {});
        if (tooLarge) return sendJson(res, { success: false, msg: 'File too large', max_bytes: limit }, 413);
        console.error('[CHAT_UP] Write error:', e.message);
        return sendJson(res, { success: false, msg: 'Upload failed' }, 500);
    }

    if (!size) {
        await fs.unlink(filePath).catch(() => {});
        return sendJson(res, { success: false, msg: 'Empty body' }, 400);
    }

    const mime = await detectMime(filePath);
    if (!allowed.includes(mime)) {
        await fs.unlink(filePath).catch(() => {});
        return sendJson(res, { success: false, msg: `File type not allowed: ${mime || 'unknown'}` }, 415);
    }
    const lifetime = parseExpiry(req.headers['x-upload-expiry']);
    const expiresAt = new Date(Date.now() + lifetime * 1000);
    const deleteToken = crypto.randomBytes(24).toString('base64url');

    try {
        await db`
            INSERT INTO chat_uploads ${db({
                slug,
                key_id:            key.id,
                original_name:     name,
                mime,
                mime_hint:         hint,
                size_bytes:        size,
                delete_token_hash: lib.sha256(deleteToken),
                expires_at:        expiresAt
            })}
        `;
        await db`UPDATE upload_api_keys SET last_used_at = now() WHERE id = ${key.id}`;
    } catch (e) {
        await fs.unlink(filePath).catch(() => {});
        console.error('[CHAT_UP] DB error:', e.message);
        return sendJson(res, { success: false, msg: 'Server error' }, 500);
    }

    const base = (cfg.main?.url?.full || '').replace(/\/+$/, '');
    return sendJson(res, {
        success:      true,
        slug,
        url:          `${base}/cu/${slug}/${encodeURIComponent(name)}`,
        name,
        mime,
        inline:       isInlineMime(mime),
        size,
        expires_at:   ~~(expiresAt.getTime() / 1000),
        delete_token: deleteToken
    });
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function handleChatUploadDelete(req, res, slug) {
    if (!isEnabled()) return sendJson(res, { success: false, msg: 'Not found' }, 404);
    const token = req.headers['x-delete-token'];
    if (!token) return sendJson(res, { success: false, msg: 'Delete token required' }, 401);

    const rows = await db`
        DELETE FROM chat_uploads
        WHERE slug = ${slug} AND delete_token_hash = ${lib.sha256(String(token))}
        RETURNING id
    `;
    if (!rows.length) return sendJson(res, { success: false, msg: 'Not found' }, 404);
    await fs.unlink(path.join(UPLOAD_DIR, slug)).catch(() => {});
    return sendJson(res, { success: true });
}

// ─── Download ─────────────────────────────────────────────────────────────────

export async function handleChatUploadServe(req, res, slug) {
    const notFound = () => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 - file not found.');
    };
    if (!isEnabled()) return notFound();

    const rows = await db`
        SELECT original_name, mime, expires_at FROM chat_uploads
        WHERE slug = ${slug} AND expires_at > now()
        LIMIT 1
    `;
    if (!rows.length) return notFound();
    const row = rows[0];
    const filePath = path.join(UPLOAD_DIR, slug);

    let stat;
    try { stat = await fs.stat(filePath); } catch { return notFound(); }

    const inline = isInlineMime(row.mime);
    const ttl = Math.max(0, ~~((new Date(row.expires_at).getTime() - Date.now()) / 1000));
    const headers = {
        'Content-Type':                  row.mime,
        'Accept-Ranges':                 'bytes',
        'Cache-Control':                 `public, max-age=${Math.min(ttl, 86400)}`,
        'Content-Disposition':           `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
        'X-Content-Type-Options':        'nosniff',
        'Content-Security-Policy':       "default-src 'none'; sandbox",
        'Access-Control-Allow-Origin':   '*',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition',
        'Cross-Origin-Resource-Policy':  'cross-origin'
    };

    let start = 0, end = stat.size - 1, code = 200;
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && stat.size > 0 && (range[1] !== '' || range[2] !== '')) {
        if (range[1] === '') {
            start = Math.max(0, stat.size - parseInt(range[2], 10));
        } else {
            start = parseInt(range[1], 10);
            if (range[2] !== '') end = Math.min(parseInt(range[2], 10), end);
        }
        if (start > end || start >= stat.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
            return res.end();
        }
        code = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = String(stat.size ? end - start + 1 : 0);

    res.writeHead(code, headers);
    if (req.method === 'HEAD' || !stat.size) return res.end();

    await new Promise(resolve => {
        const stream = createReadStream(filePath, { start, end });
        stream.on('error', () => { res.destroy(); resolve(); });
        stream.on('end', resolve);
        res.on('close', () => { stream.destroy(); resolve(); });
        stream.pipe(res);
    });
}
