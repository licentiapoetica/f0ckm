/**
 * dm_attachment_handler.mjs — Server-side handler for encrypted DM attachments.
 *
 * All uploaded content is opaque AES-GCM ciphertext — the server cannot read it.
 * Files are stored at /e/<id> (configured via DM_ATTACHMENT_DIR env or /e/).
 *
 * Routes (registered as bypass middlewares in index.mjs):
 *   POST   /api/dm/attachment/upload/:recipientId  — receive ciphertext blob, store on disk
 *   GET    /api/dm/attachment/:id                  — stream ciphertext back (auth required)
 *   DELETE /api/dm/attachment/:id                  — delete (sender only or admin)
 */

import { promises as fs } from 'fs';
import path from 'path';
import db from './inc/sql.mjs';
import lib from './inc/lib.mjs';
import cfg from './inc/config.mjs';
import { collectBody } from './inc/multipart.mjs';
import { getDmAttachments } from './inc/settings.mjs';

// ─── Config ──────────────────────────────────────────────────────────────────

const ATTACHMENT_DIR = process.env.DM_ATTACHMENT_DIR || cfg.paths.e;
const MAX_BYTES      = 50 * 1024 * 1024; // 50 MB plaintext; ciphertext is ~1.33× due to base64url

// Ensure storage dir exists at startup
fs.mkdir(ATTACHMENT_DIR, { recursive: true }).catch(e =>
    console.error('[DM_ATT] Failed to create attachment dir:', e.message)
);

// ─── Expiry cleanup ───────────────────────────────────────────────────────────

export async function cleanupExpiredAttachments() {
    try {
        const expired = await db`
            SELECT id, file_path FROM dm_attachments
            WHERE expires_at < now()
        `;
        if (!expired.length) return;

        let deleted = 0;
        for (const row of expired) {
            await fs.unlink(row.file_path).catch(() => {}); // ignore already-missing files
            deleted++;
        }

        const ids = expired.map(r => r.id);
        await db`DELETE FROM dm_attachments WHERE id = ANY(${ids})`;

        console.log(`[DM_ATT] Cleanup: removed ${deleted} expired attachment(s)`);
    } catch (e) {
        console.error('[DM_ATT] Cleanup error:', e.message);
    }
}

// Run once at startup, then every 6 hours
cleanupExpiredAttachments();
setInterval(cleanupExpiredAttachments, 6 * 60 * 60 * 1000);


// ─── Session helper ───────────────────────────────────────────────────────────

async function resolveSession(req) {
    if (!req.cookies?.session) return null;
    try {
        const rows = await db`
            SELECT u.id, u.login, u.user, u.admin, u.is_moderator, s.csrf_token
            FROM user_sessions s
            LEFT JOIN "user" u ON u.id = s.user_id
            WHERE s.session = ${lib.sha256(req.cookies.session)}
            LIMIT 1
        `;
        return rows.length ? rows[0] : null;
    } catch { return null; }
}

function sendJson(res, data, code = 200) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function validateCsrf(req, session) {
    const token = req.headers['x-csrf-token'];
    return session?.csrf_token && token && token === session.csrf_token;
}

// ─── Multipart parser (minimal — only parses fields + one binary file part) ───

function parseAttachmentMultipart(buffer, boundary) {
    const boundaryBuf = Buffer.from(`--${boundary}`);
    const segments = [];
    let start = 0, idx;
    while ((idx = buffer.indexOf(boundaryBuf, start)) !== -1) {
        if (start !== 0) segments.push(buffer.slice(start, idx - 2));
        start = idx + boundaryBuf.length + 2;
    }

    const result = { fields: {}, file: null };
    for (const seg of segments) {
        const hdrEnd = seg.indexOf('\r\n\r\n');
        if (hdrEnd === -1) continue;
        const headers = seg.slice(0, hdrEnd).toString();
        const body    = seg.slice(hdrEnd + 4);
        const nameM   = headers.match(/name="([^"]+)"/);
        if (!nameM) continue;
        const hasFile = headers.includes('filename=') || headers.includes('filename*=');
        if (hasFile && !result.file) {
            const ctM = headers.match(/Content-Type:\s*([^\r\n]+)/i);
            result.file = {
                data:        body,
                contentType: ctM ? ctM[1].trim() : 'application/octet-stream'
            };
        } else if (!hasFile) {
            result.fields[nameM[1]] = body.toString().trim();
        }
    }
    return result;
}

// ─── Upload handler ───────────────────────────────────────────────────────────

export async function handleDmAttachmentUpload(req, res, recipientId) {
    if (!getDmAttachments()) return sendJson(res, { success: false, msg: 'Not found' }, 404);

    const session = await resolveSession(req);
    if (!session) return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
    if (!validateCsrf(req, session)) return sendJson(res, { success: false, msg: 'CSRF mismatch' }, 403);

    const rid = parseInt(recipientId, 10);
    if (!rid || rid === session.id) return sendJson(res, { success: false, msg: 'Invalid recipient' }, 400);

    // Check recipient exists
    const recip = await db`SELECT id FROM "user" WHERE id = ${rid} LIMIT 1`;
    if (!recip.length) return sendJson(res, { success: false, msg: 'Recipient not found' }, 404);

    const ct   = req.headers['content-type'] || '';
    const bndM = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!ct.includes('multipart/form-data') || !bndM) {
        return sendJson(res, { success: false, msg: 'Expected multipart/form-data' }, 400);
    }

    let rawBody;
    try {
        // MAX_BYTES * 1.4 overhead for base64url encoding + multipart framing
        rawBody = await collectBody(req, Math.ceil(MAX_BYTES * 1.4) + 4096);
    } catch (e) {
        if (e.code === 'BODY_TOO_LARGE') return sendJson(res, { success: false, msg: 'Attachment too large (max 50 MB)' }, 413);
        throw e;
    }

    const boundary = bndM[1] || bndM[2];
    const { fields, file } = parseAttachmentMultipart(rawBody, boundary);

    if (!file) return sendJson(res, { success: false, msg: 'No file part found' }, 400);

    const iv           = (fields.iv || '').trim();
    const originalName = (fields.original_name || '').slice(0, 255);
    const mimeHint     = (fields.mime_hint || '').slice(0, 100);
    const sizeBytes    = parseInt(fields.size_bytes || '0', 10) || 0;

    if (!iv || iv.length > 32) return sendJson(res, { success: false, msg: 'Missing or invalid iv' }, 400);
    if (file.data.length > Math.ceil(MAX_BYTES * 1.4)) {
        return sendJson(res, { success: false, msg: 'Attachment too large (max 50 MB)' }, 413);
    }

    try {
        // Insert DB record first to get an ID
        const [row] = await db`
            INSERT INTO dm_attachments ${db({
                sender_id:     session.id,
                recipient_id:  rid,
                iv,
                file_path:     '',
                original_name: originalName,
                mime_hint:     mimeHint,
                size_bytes:    sizeBytes
            })}
            RETURNING id
        `;

        const filePath = path.join(ATTACHMENT_DIR, String(row.id));
        await fs.writeFile(filePath, file.data);

        // Update file_path now that we know the ID
        await db`UPDATE dm_attachments SET file_path = ${filePath} WHERE id = ${row.id}`;

        return sendJson(res, { success: true, id: String(row.id) });
    } catch (err) {
        console.error('[DM_ATT] Upload error:', err);
        return sendJson(res, { success: false, msg: 'Server error' }, 500);
    }
}

// ─── Download handler ─────────────────────────────────────────────────────────

export async function handleDmAttachmentDownload(req, res, attachmentId) {
    const session = await resolveSession(req);
    if (!session) return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);

    const id = parseInt(attachmentId, 10);
    if (!id) return sendJson(res, { success: false, msg: 'Invalid id' }, 400);

    const rows = await db`
        SELECT id, sender_id, recipient_id, iv, file_path, original_name, mime_hint
        FROM dm_attachments
        WHERE id = ${id}
        LIMIT 1
    `;
    if (!rows.length) return sendJson(res, { success: false, msg: 'Not found' }, 404);

    const att = rows[0];
    // Only sender or recipient may download
    if (att.sender_id !== session.id && att.recipient_id !== session.id && !session.admin) {
        return sendJson(res, { success: false, msg: 'Forbidden' }, 403);
    }

    try {
        const data = await fs.readFile(att.file_path);
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(data.length),
            'Cache-Control': 'private, no-store',
            'X-DM-IV': att.iv,
            'X-Original-Name': encodeURIComponent(att.original_name || 'attachment'),
            'X-Mime-Hint': att.mime_hint || ''
        });
        res.end(data);
    } catch (err) {
        console.error('[DM_ATT] Download error:', err);
        return sendJson(res, { success: false, msg: 'File not found on disk' }, 404);
    }
}

// ─── Delete handler ───────────────────────────────────────────────────────────

export async function handleDmAttachmentDelete(req, res, attachmentId) {
    const session = await resolveSession(req);
    if (!session) return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
    if (!validateCsrf(req, session)) return sendJson(res, { success: false, msg: 'CSRF mismatch' }, 403);

    const id = parseInt(attachmentId, 10);
    if (!id) return sendJson(res, { success: false, msg: 'Invalid id' }, 400);

    const rows = await db`SELECT id, sender_id, file_path FROM dm_attachments WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return sendJson(res, { success: false, msg: 'Not found' }, 404);

    const att = rows[0];
    if (att.sender_id !== session.id && !session.admin) {
        return sendJson(res, { success: false, msg: 'Forbidden' }, 403);
    }

    try {
        await fs.unlink(att.file_path).catch(() => {});
        await db`DELETE FROM dm_attachments WHERE id = ${id}`;
        return sendJson(res, { success: true });
    } catch (err) {
        console.error('[DM_ATT] Delete error:', err);
        return sendJson(res, { success: false, msg: 'Server error' }, 500);
    }
}
