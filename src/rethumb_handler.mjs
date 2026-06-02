import cfg from "./inc/config.mjs";
import path from "path";
import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";
import queue from "./inc/queue.mjs";

const execFile = promisify(_execFile);

const sendJson = (res, data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

export const handleRethumbUpload = async (req, res, itemId) => {
    console.log('[RETHUMB HANDLER] Upload started for item:', itemId);

    // Manual Session Lookup
    let user = [];
    if (req.cookies && req.cookies.session) {
        user = await db`
            select "user".id, "user".login, "user".user, "user".admin, "user".is_moderator, "user_sessions".id as sess_id, "user_sessions".csrf_token, "user_options".*
            from "user_sessions"
            left join "user" on "user".id = "user_sessions".user_id
            left join "user_options" on "user_options".user_id = "user_sessions".user_id
            where "user_sessions".session = ${lib.sha256(req.cookies.session)}
            limit 1
          `;
    }

    if (user.length === 0) {
        return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
    }

    req.session = user[0];

    // CSRF validation
    if (req.session.csrf_token) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken || csrfToken !== req.session.csrf_token) {
            console.warn(`[CSRF] Blocked rethumb upload for user ${req.session.user}. Invalid token.`);
            return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
        }
    }

    // Verify Item exists and permissions
    let item;
    try {
        const items = await db`select id, username, mime, active from items where id = ${+itemId} limit 1`;
        if (items.length === 0) {
            return sendJson(res, { success: false, msg: 'Item not found' }, 404);
        }
        item = items[0];
    } catch (e) {
        console.error('[RETHUMB HANDLER] Database error:', e);
        return sendJson(res, { success: false, msg: 'Database error' }, 500);
    }

    // Permission check
    if (!req.session.admin && !req.session.is_moderator && req.session.user !== item.username) {
        return sendJson(res, { success: false, msg: 'Insufficient permissions' }, 403);
    }

    // Must be a Flash file (only flash files allow custom thumbnail reuploads currently)
    if (item.mime !== 'application/x-shockwave-flash' && item.mime !== 'application/vnd.adobe.flash.movie') {
        return sendJson(res, { success: false, msg: 'Only Flash uploads support custom thumbnails at this time' }, 400);
    }

    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)$/);

        if (!boundaryMatch) {
            return sendJson(res, { success: false, msg: 'Invalid content type' }, 400);
        }

        const body = await collectBody(req);
        const parts = parseMultipart(body, boundaryMatch[1]);
        const file = parts.file;

        if (!file || !file.data) {
            return sendJson(res, { success: false, msg: 'No file provided' }, 400);
        }

        // Validate file size (5MB max)
        const maxSize = 5 * 1024 * 1024;
        if (file.data.length > maxSize) {
            return sendJson(res, {
                success: false,
                msg: `File too large. Maximum size is 5MB, got ${(file.data.length / 1024 / 1024).toFixed(2)}MB`
            }, 400);
        }

        const allowedMimes = ['image/gif', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        let mime = file.contentType.toLowerCase();
        if (!allowedMimes.includes(mime)) {
            return sendJson(res, {
                success: false,
                msg: `Invalid file type. Allowed: gif, jpg, jpeg, png, webp. Got: ${mime}`
            }, 400);
        }

        // Save to tmp for verification
        const raw = (await db`select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') as uuid`)[0].uuid;
        const uuid = raw.substring(0, 48);
        const tmpPath = path.join(cfg.paths.tmp, `rethumb_${uuid}_${itemId}`);

        await fs.mkdir(cfg.paths.tmp, { recursive: true });
        await fs.writeFile(tmpPath, file.data);

        // Verify MIME
        const { stdout: actualMime } = await execFile('file', ['--mime-type', '-b', tmpPath]);
        const allowedActualMimes = ['image/gif', 'image/jpeg', 'image/png', 'image/webp'];

        if (!allowedActualMimes.includes(actualMime.trim())) {
            await fs.unlink(tmpPath).catch(() => {});
            return sendJson(res, {
                success: false,
                msg: `Invalid file type detected: ${actualMime.trim()}`
            }, 400);
        }

        // Generate the thumbnail
        const tDir = item.active ? cfg.paths.t : path.join(cfg.paths.pending, 't');
        const finalPath = path.join(tDir, `${item.id}.webp`);
        const thumbSpec = '512x512';

        try {
            await execFile('magick', [tmpPath, '-coalesce', '-resize', `${thumbSpec}^`, '-gravity', 'center', '-crop', `${thumbSpec}+0+0`, '+repage', finalPath]);
            
            // Generate blurred thumbnail
            await queue.genBlurredThumbnail(item.id, !item.active);

        } catch (err) {
            console.error('[RETHUMB HANDLER] Magick error:', err);
            await fs.unlink(tmpPath).catch(() => {});
            return sendJson(res, { success: false, msg: 'Failed to process image' }, 500);
        }

        await fs.unlink(tmpPath).catch(() => {});

        try {
            await db`SELECT pg_notify('rethumb', ${JSON.stringify({ item_id: item.id })})`;
        } catch (err) {
            console.error('[RETHUMB HANDLER] SSE notify error:', err);
        }

        console.log('[RETHUMB HANDLER] Custom thumbnail applied to item', item.id);
        return sendJson(res, {
            success: true,
            msg: 'Thumbnail updated successfully'
        }, 200);

    } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') {
            return sendJson(res, { success: false, msg: 'File too large (5 MB max)' }, 413);
        }
        console.error('[RETHUMB HANDLER ERROR]', err);
        return sendJson(res, { success: false, msg: lib.logError(err, 'Thumbnail Upload failed') }, 500);
    }
};
