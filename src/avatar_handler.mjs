import cfg from "./inc/config.mjs";
import path from "path";
import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

// Multi-part parsing logic removed, using shared imports

// Helper for JSON response
const sendJson = (res, data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

// Generate UUID using the same method as video uploads
const genuuid = async () => {
    const raw = (await db`select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') as uuid`)[0].uuid;
    return raw.substring(0, 48);
};

export const handleAvatarUpload = async (req, res) => {
    console.log('[AVATAR HANDLER] Upload started');

    // Manual Session Lookup
    let user = [];
    if (req.cookies && req.cookies.session) {
        user = await db`
            select "user".id, "user".login, "user".user, "user".admin, "user_sessions".id as sess_id, "user_sessions".csrf_token, "user_options".*
            from "user_sessions"
            left join "user" on "user".id = "user_sessions".user_id
            left join "user_options" on "user_options".user_id = "user_sessions".user_id
            where "user_sessions".session = ${lib.sha256(req.cookies.session)}
            limit 1
          `;
    }

    if (user.length === 0) {
        console.log('[AVATAR HANDLER] Unauthorized - No valid session found');
        return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
    }

    req.session = user[0];
    console.log('[AVATAR HANDLER] Authorized:', req.session.user);

    // CSRF validation — must happen after session lookup since flummpress middlewares run in parallel
    if (req.session.csrf_token) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken || csrfToken !== req.session.csrf_token) {
            console.warn(`[CSRF] Blocked avatar upload for user ${req.session.user}. Invalid token.`);
            return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
        }
    }

    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)$/);

        if (!boundaryMatch) {
            console.log('[AVATAR HANDLER] No boundary');
            return sendJson(res, { success: false, msg: 'Invalid content type' }, 400);
        }

        console.log('[AVATAR HANDLER] Collecting body...');
        const body = await collectBody(req);
        console.log('[AVATAR HANDLER] Body collected, size:', body.length);

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

        // Allowed MIME types
        const allowedMimes = [
            'image/gif',
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/webp'
        ];

        // Validate MIME type from content-type header
        let mime = file.contentType.toLowerCase();
        if (!allowedMimes.includes(mime)) {
            return sendJson(res, {
                success: false,
                msg: `Invalid file type. Allowed: gif, jpg, jpeg, png, webp. Got: ${mime}`
            }, 400);
        }

        // Save to tmp and verify with file magic
        const uuid = await genuuid();
        const tmpPath = path.join(cfg.paths.tmp, `avatar_${uuid}_tmp`);
        const finalFilename = `${uuid}.webp`;
        const finalPath = path.join(cfg.paths.a, finalFilename);

        await fs.mkdir(cfg.paths.tmp, { recursive: true });
        await fs.mkdir(cfg.paths.a, { recursive: true });

        await fs.writeFile(tmpPath, file.data);

        // Verify MIME with file magic
        const { stdout: actualMime } = await execFile('file', ['--mime-type', '-b', tmpPath]);
        const allowedActualMimes = [
            'image/gif',
            'image/jpeg',
            'image/png',
            'image/webp'
        ];

        if (!allowedActualMimes.includes(actualMime.trim())) {
            await fs.unlink(tmpPath).catch(() => { });
            return sendJson(res, {
                success: false,
                msg: `Invalid file type detected: ${actualMime.trim()}`
            }, 400);
        }

        // Get current avatar_file to delete old one
        const currentAvatar = (await db`
            select avatar_file from user_options where user_id = ${+req.session.id}
        `)[0]?.avatar_file;

        // Convert to webp using ImageMagick with coalesce for GIF handling
        try {
            await execFile('magick', [tmpPath, '-coalesce', '-resize', '256x256^', '-gravity', 'center', '-background', 'none', '-extent', '256x256', '-quality', '50', finalPath]);
        } catch (err) {
            console.error('[AVATAR HANDLER] Magick error:', err);
            await fs.unlink(tmpPath).catch(() => { });
            return sendJson(res, { success: false, msg: 'Failed to process image' }, 500);
        }

        // Clean up tmp file
        await fs.unlink(tmpPath).catch(() => { });

        // Delete old avatar file if exists (except default.png)
        if (currentAvatar && currentAvatar !== 'default.png') {
            const oldPath = path.join(cfg.paths.a, currentAvatar);
            await fs.unlink(oldPath).catch(() => { });
        }

        // Update database — clear item-based avatar so custom file takes priority
        await db`
            update user_options 
            set avatar_file = ${finalFilename},
                avatar = NULL
            where user_id = ${+req.session.id}
        `;

        const payloadStr = JSON.stringify({
            user_id: req.session.id,
            user: req.session.user,
            avatar_file: finalFilename,
            avatar: null
        });
        await db`select pg_notify('profile_update', ${payloadStr})`;

        console.log('[AVATAR HANDLER] Upload complete:', finalFilename);
        return sendJson(res, {
            success: true,
            avatar_file: finalFilename,
            msg: 'Avatar uploaded successfully'
        }, 200);

    } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') {
            return sendJson(res, { success: false, msg: 'File too large (5 MB max for avatars)' }, 413);
        }
        console.error('[AVATAR HANDLER ERROR]', err);
        return sendJson(res, { success: false, msg: lib.logError(err, 'Avatar Upload failed') }, 500);
    }
};

export const handleAvatarDelete = async (req, res) => {
    console.log('[AVATAR HANDLER] Delete started');

    // Manual Session Lookup
    let user = [];
    if (req.cookies && req.cookies.session) {
        user = await db`
            select "user".id, "user".login, "user".user, "user".admin, "user_sessions".id as sess_id, "user_sessions".csrf_token, "user_options".*
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

    // CSRF validation — must happen after session lookup since flummpress middlewares run in parallel
    if (req.session.csrf_token) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken || csrfToken !== req.session.csrf_token) {
            console.warn(`[CSRF] Blocked avatar delete for user ${req.session.user}. Invalid token.`);
            return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
        }
    }

    try {
        const currentAvatar = (await db`
            select avatar_file from user_options where user_id = ${+req.session.id}
        `)[0]?.avatar_file;

        if (currentAvatar && currentAvatar !== 'default.png') {
            const oldPath = path.join(cfg.paths.a, currentAvatar);
            await fs.unlink(oldPath).catch(() => { });
        }

        await db`
            update user_options 
            set avatar_file = null
            where user_id = ${+req.session.id}
        `;

        const payloadStr = JSON.stringify({
            user_id: req.session.id,
            user: req.session.user,
            avatar_file: null
        });
        await db`select pg_notify('profile_update', ${payloadStr})`;

        console.log('[AVATAR HANDLER] Delete complete');
        return sendJson(res, { success: true, msg: 'Custom avatar removed' }, 200);
    } catch (err) {
        console.error('[AVATAR DELETE ERROR]', err);
        return sendJson(res, { success: false, msg: 'Failed to remove avatar' }, 500);
    }
};
