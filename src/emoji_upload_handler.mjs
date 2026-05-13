import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import cfg from "./inc/config.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

// Custom IM policy that raises list-length from 128 → 65536 to handle large animated GIFs.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGICK_POLICY_PATH = path.resolve(__dirname, '../config/magick-policy');
const magickEnv = { ...process.env, MAGICK_CONFIGURE_PATH: MAGICK_POLICY_PATH };

const sendJson = (res, data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

export const handleEmojiUpload = async (req, res) => {
    console.error('[BOOT] [EMOJI HANDLER] Started');

    // Manual Session Lookup
    let user = [];
    if (req.cookies && req.cookies.session) {
        user = await db`
            select "user".id, "user".login, "user".user, "user".admin, "user".is_moderator, "user_sessions".id as sess_id, "user_sessions".csrf_token
            from "user_sessions"
            left join "user" on "user".id = "user_sessions".user_id
            where "user_sessions".session = ${lib.sha256(req.cookies.session)}
            limit 1
          `;
    }

    if (user.length === 0 || !user[0].admin) {
        console.error('[BOOT] [EMOJI HANDLER] Unauthorized');
        return sendJson(res, { success: false, message: 'Unauthorized' }, 403);
    }

    req.session = user[0];

    // CSRF validation
    if (req.session.csrf_token) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken || csrfToken !== req.session.csrf_token) {
            console.warn(`[CSRF] Blocked emoji upload for user ${req.session.user}. Invalid token.`);
            return sendJson(res, { success: false, message: 'Invalid CSRF token' }, 403);
        }
    }

    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=([^;]+)/);

        if (!boundaryMatch) {
            return sendJson(res, { success: false, message: 'Invalid content type' }, 400);
        }

        let boundary = boundaryMatch[1].trim();
        if (boundary.startsWith('"') && boundary.endsWith('"')) {
            boundary = boundary.substring(1, boundary.length - 1);
        }

        const bodyBuffer = await collectBody(req);
        const parts = parseMultipart(bodyBuffer, boundary);

        const name = (parts.name || '').trim().toLowerCase();
        let url = (parts.url || '').trim();

        if (!name) {
            return sendJson(res, { success: false, message: 'Emoji name is required' }, 400);
        }

        if (!/^[a-z0-9_-]+$/.test(name)) {
            return sendJson(res, { success: false, message: 'Invalid name. Use lowercase a-z, 0-9, _, - only.' }, 400);
        }

        const file = parts.file;
        if (file && file.data && file.data.length > 0) {
            const randSuffix = Math.random().toString(36).substring(7);
            const extMatch = file.filename.match(/\.([a-z0-9]+)$/i);
            const originalExt = extMatch ? extMatch[1].toLowerCase() : 'png';

            const webpFilename = `${name}_${randSuffix}.webp`;
            const webpPath = path.join(cfg.paths.emojis, webpFilename);

            if (originalExt === 'webp') {
                // Already WebP — write directly
                console.error(`[BOOT] [EMOJI HANDLER] Writing WebP directly to: ${webpPath} (Size: ${file.data.length})`);
                await fs.writeFile(webpPath, file.data);
            } else {
                // Write original to a temp file, then convert to WebP via magick
                const tmpFilename = `${name}_${randSuffix}_tmp.${originalExt}`;
                const tmpPath = path.join(cfg.paths.emojis, tmpFilename);
                console.error(`[BOOT] [EMOJI HANDLER] Writing temp file: ${tmpPath} (Size: ${file.data.length})`);
                await fs.writeFile(tmpPath, file.data);
                try {
                    // -coalesce handles animated GIFs; quality 80 = lossy WebP (good visual quality, ~50-70% smaller than GIF)
                    await execFile('magick', [tmpPath, '-coalesce', '-quality', '80', webpPath], { env: magickEnv });
                    console.error(`[BOOT] [EMOJI HANDLER] Converted to WebP: ${webpPath}`);
                } finally {
                    await fs.unlink(tmpPath).catch(() => {});
                }
            }

            // Verify write
            const stat = await fs.stat(webpPath);
            if (!stat || stat.size === 0) throw new Error("File write/conversion verification failed");

            url = `/s/emojis/${webpFilename}`;
        }

        if (!url) {
            return sendJson(res, { success: false, message: 'Either image URL or File is required' }, 400);
        }

        const newEmoji = await db`
            INSERT INTO custom_emojis (name, url) 
            VALUES (${name}, ${url})
            RETURNING id, name, url
        `;

        console.error(`[BOOT] [EMOJI HANDLER] Success: ${name}`);
        await db`NOTIFY emojis_updated, '{}'`;
        return sendJson(res, { success: true, emoji: newEmoji[0] });

    } catch (err) {
        if (err.code === '23505') {
            return sendJson(res, { success: false, message: 'Emoji name already exists' }, 400);
        }
        console.error('[EMOJI HANDLER ERROR]', err);
        return sendJson(res, { success: false, message: err.message }, 500);
    }
};
