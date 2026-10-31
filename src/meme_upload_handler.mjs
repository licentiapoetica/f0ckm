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

export const handleMemeUpload = async (req, res) => {
    console.log('[BOOT] [MEME HANDLER] Started');

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
        console.log('[MEME HANDLER] Unauthorized');
        return sendJson(res, { success: false, message: 'Unauthorized' }, 403);
    }

    req.session = user[0];

    // CSRF validation
    if (req.session.csrf_token) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken || csrfToken !== req.session.csrf_token) {
            console.warn(`[CSRF] Blocked meme upload for user ${req.session.user}. Invalid token.`);
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

        const template_id = (parts.template_id || '').trim().toLowerCase();
        const name = (parts.name || '').trim();
        const category = (parts.category || '').trim() || 'General';
        let url = (parts.url || '').trim();

        if (!template_id || !name) {
            return sendJson(res, { success: false, message: 'Template ID and Name are required' }, 400);
        }

        if (!/^[a-z0-9-]+$/.test(template_id)) {
            return sendJson(res, { success: false, message: 'Invalid ID. Use lowercase a-z, 0-9, - only.' }, 400);
        }

        const file = parts.file;
        if (file && file.data && file.data.length > 0) {
            const extMatch = file.filename.match(/\.([a-z0-9]+)$/i);
            const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
            const filename = `${template_id}_${Math.random().toString(36).substring(7)}.${ext}`;

            const filePath = path.join(cfg.paths.memes, filename);
            console.error(`[BOOT] [MEME HANDLER] Writing file to: ${filePath} (Size: ${file.data.length})`);
            await fs.writeFile(filePath, file.data);
            
            const exists = (await fs.stat(filePath)).size > 0;
            console.error(`[BOOT] [MEME HANDLER] Write verify: ${exists ? 'SUCCESS' : 'FAILURE'}`);
            
            if (exists) {
                url = `/memes/${filename}`;
            } else {
                throw new Error("File was written but verify failed (size 0 or not found)");
            }
        }

        if (!url) {
            return sendJson(res, { success: false, message: 'Either image URL or File is required' }, 400);
        }

        const newMeme = await db`
            INSERT INTO meme_templates (template_id, name, url, category) 
            VALUES (${template_id}, ${name}, ${url}, ${category})
            RETURNING id, template_id, name, url, category
        `;

        return sendJson(res, { success: true, meme: newMeme[0] });

    } catch (err) {
        console.error('[MEME HANDLER ERROR]', err);
        return sendJson(res, { success: false, message: err.message }, 500);
    }
};

export const handleMemeEdit = async (req, res) => {
    console.log('[BOOT] [MEME HANDLER] Edit Started');

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
        console.log('[MEME HANDLER] Unauthorized');
        return sendJson(res, { success: false, message: 'Unauthorized' }, 403);
    }

    req.session = user[0];

    // CSRF validation
    if (req.session.csrf_token) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken || csrfToken !== req.session.csrf_token) {
            console.warn(`[CSRF] Blocked meme edit for user ${req.session.user}. Invalid token.`);
            return sendJson(res, { success: false, message: 'Invalid CSRF token' }, 403);
        }
    }

    const id = req.params.id;

    try {
        // Fetch existing template first
        const currentMeme = await db`SELECT * FROM meme_templates WHERE id = ${id}`;
        if (currentMeme.length === 0) {
            return sendJson(res, { success: false, message: 'Meme template not found' }, 404);
        }

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

        const template_id = (parts.template_id || '').trim().toLowerCase();
        const name = (parts.name || '').trim();
        const category = (parts.category || '').trim() || 'General';
        let url = (parts.url || '').trim();

        if (!template_id || !name) {
            return sendJson(res, { success: false, message: 'Template ID and Name are required' }, 400);
        }

        if (!/^[a-z0-9-]+$/.test(template_id)) {
            return sendJson(res, { success: false, message: 'Invalid ID. Use lowercase a-z, 0-9, - only.' }, 400);
        }

        // Ensure template_id is unique
        const existing = await db`SELECT id FROM meme_templates WHERE template_id = ${template_id} AND id != ${id}`;
        if (existing.length > 0) {
            return sendJson(res, { success: false, message: 'Template ID is already in use by another template' }, 400);
        }

        const file = parts.file;
        if (file && file.data && file.data.length > 0) {
            const extMatch = file.filename.match(/\.([a-z0-9]+)$/i);
            const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
            const filename = `${template_id}_${Math.random().toString(36).substring(7)}.${ext}`;

            const filePath = path.join(cfg.paths.memes, filename);
            console.error(`[BOOT] [MEME HANDLER] Writing file to: ${filePath} (Size: ${file.data.length})`);
            await fs.writeFile(filePath, file.data);
            
            const exists = (await fs.stat(filePath)).size > 0;
            console.error(`[BOOT] [MEME HANDLER] Write verify: ${exists ? 'SUCCESS' : 'FAILURE'}`);
            
            if (exists) {
                url = `/memes/${filename}`;
            } else {
                throw new Error("File was written but verify failed (size 0 or not found)");
            }
        }

        // If no file uploaded and no URL input provided, keep the existing one
        if (!url) {
            url = currentMeme[0].url;
        }

        await db`
            UPDATE meme_templates
            SET template_id = ${template_id}, name = ${name}, category = ${category}, url = ${url}
            WHERE id = ${id}
        `;

        return sendJson(res, { success: true });

    } catch (err) {
        console.error('[MEME HANDLER ERROR]', err);
        return sendJson(res, { success: false, message: err.message }, 500);
    }
};

