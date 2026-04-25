import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import cfg from "./inc/config.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";
import path from "path";

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
            const extMatch = file.filename.match(/\.([a-z0-9]+)$/i);
            const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
            const filename = `${name}_${Math.random().toString(36).substring(7)}.${ext}`;

            // Emojis go to public/s/emojis
            const filePath = path.join(cfg.paths.emojis, filename);
            console.error(`[BOOT] [EMOJI HANDLER] Writing file to: ${filePath} (Size: ${file.data.length})`);
            await fs.writeFile(filePath, file.data);
            
            // Verify write
            const exists = (await fs.stat(filePath)).size > 0;
            if (!exists) throw new Error("File write verification failed");
            
            url = `/s/emojis/${filename}`;
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
