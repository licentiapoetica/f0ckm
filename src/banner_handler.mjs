import cfg from "./inc/config.mjs";
import path from "path";
import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

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

export const handleBannerUpload = async (req, res) => {
    console.log('[BANNER HANDLER] Upload started');

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
        console.log('[BANNER HANDLER] Unauthorized - No valid session found');
        return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
    }

    req.session = user[0];
    console.log('[BANNER HANDLER] Authorized:', req.session.user);

    // CSRF validation
    if (req.session.csrf_token) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken || csrfToken !== req.session.csrf_token) {
            console.warn(`[CSRF] Blocked banner upload for user ${req.session.user}. Invalid token.`);
            return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
        }
    }

    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)$/);

        if (!boundaryMatch) {
            console.log('[BANNER HANDLER] No boundary');
            return sendJson(res, { success: false, msg: 'Invalid content type' }, 400);
        }

        console.log('[BANNER HANDLER] Collecting body...');
        const body = await collectBody(req);
        console.log('[BANNER HANDLER] Body collected, size:', body.length);

        console.log('[BANNER HANDLER] Parsing multipart...');
        const parts = parseMultipart(body, boundaryMatch[1]);
        const file = parts.file;
        console.log('[BANNER HANDLER] Parsed, file present:', !!file, 'keys:', Object.keys(parts));

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
        let mime = (file.contentType || '').toLowerCase().split(';')[0].trim();
        console.log('[BANNER HANDLER] File MIME from header:', mime);
        if (!allowedMimes.includes(mime)) {
            return sendJson(res, {
                success: false,
                msg: `Invalid file type. Allowed: gif, jpg, jpeg, png, webp. Got: ${mime}`
            }, 400);
        }

        // Save to tmp and verify with file magic
        console.log('[BANNER HANDLER] Generating UUID...');
        const uuid = await genuuid();
        const tmpPath = path.join(cfg.paths.tmp, `banner_${uuid}_tmp`);
        const finalFilename = `banner_${uuid}.webp`;
        const finalPath = path.join(cfg.paths.a, finalFilename);

        await fs.mkdir(cfg.paths.tmp, { recursive: true });
        await fs.mkdir(cfg.paths.a, { recursive: true });

        console.log('[BANNER HANDLER] Writing tmp file:', tmpPath);
        await fs.writeFile(tmpPath, file.data);

        // Verify MIME with file magic
        console.log('[BANNER HANDLER] Checking MIME with file magic...');
        const { stdout: actualMime } = await execFile('file', ['--mime-type', '-b', tmpPath]);
        console.log('[BANNER HANDLER] Actual MIME:', actualMime.trim());
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

        // Convert to webp using ImageMagick — landscape banner crop (1200x400)
        // NOTE: [0] frame selector must be appended to the input path, not a separate arg
        console.log('[BANNER HANDLER] Running magick...');
        try {
            await execFile('magick', [`${tmpPath}[0]`, '-resize', '3840x3840>', '-quality', '85', finalPath]);
        } catch (err) {
            console.error('[BANNER HANDLER] Magick error:', err.message, err.stderr);
            await fs.unlink(tmpPath).catch(() => { });
            return sendJson(res, { success: false, msg: 'Failed to process image: ' + err.message }, 500);
        }
        console.log('[BANNER HANDLER] Magick done, output:', finalPath);

        // Get current banner_file to delete old one (after magick succeeds)
        let currentBanner = null;
        try {
            currentBanner = (await db`
                select banner_file from user_options where user_id = ${+req.session.id}
            `)[0]?.banner_file;
        } catch (dbErr) {
            console.error('[BANNER HANDLER] Could not fetch current banner (column may not exist yet):', dbErr.message);
        }

        // Clean up tmp file
        await fs.unlink(tmpPath).catch(() => { });

        // Delete old banner file if exists
        if (currentBanner) {
            const oldPath = path.join(cfg.paths.a, currentBanner);
            await fs.unlink(oldPath).catch(() => { });
        }

        // Update database
        console.log('[BANNER HANDLER] Updating database...');
        try {
            await db`
                update user_options 
                set banner_file = ${finalFilename},
                    banner_position = ${parts.banner_position || 'center'},
                    banner_size = ${parts.banner_size || 'cover'}
                where user_id = ${+req.session.id}
            `;
        } catch (dbErr) {
            console.error('[BANNER HANDLER] DB update failed:', dbErr.message);
            await fs.unlink(finalPath).catch(() => {});
            return sendJson(res, { success: false, msg: 'DB error — did you run the migration? ' + dbErr.message }, 500);
        }

        console.log('[BANNER HANDLER] Upload complete:', finalFilename);
        return sendJson(res, {
            success: true,
            banner_file: finalFilename,
            msg: 'Banner uploaded successfully'
        }, 200);

    } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') {
            return sendJson(res, { success: false, msg: 'File too large (5 MB max for banners)' }, 413);
        }
        console.error('[BANNER HANDLER ERROR]', err.message, err.stack);
        try {
            return sendJson(res, { success: false, msg: err.message || 'Banner upload failed' }, 500);
        } catch (_) {}
    }
};

export const handleBannerDelete = async (req, res) => {
    console.log('[BANNER HANDLER] Delete started');

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

    // CSRF validation
    if (req.session.csrf_token) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken || csrfToken !== req.session.csrf_token) {
            console.warn(`[CSRF] Blocked banner delete for user ${req.session.user}. Invalid token.`);
            return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
        }
    }

    try {
        const currentBanner = (await db`
            select banner_file from user_options where user_id = ${+req.session.id}
        `)[0]?.banner_file;

        if (currentBanner) {
            const oldPath = path.join(cfg.paths.a, currentBanner);
            await fs.unlink(oldPath).catch(() => { });
        }

        await db`
            update user_options 
            set banner_file = null
            where user_id = ${+req.session.id}
        `;

        console.log('[BANNER HANDLER] Delete complete');
        return sendJson(res, { success: true, msg: 'Custom banner removed' }, 200);
    } catch (err) {
        console.error('[BANNER DELETE ERROR]', err);
        return sendJson(res, { success: false, msg: 'Failed to remove banner' }, 500);
    }
};
