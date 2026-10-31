import cfg from "./inc/config.mjs";
import path from "path";
import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";
import audit from "./inc/audit.mjs";
import { getBrandImageUrl, setBrandImageUrl } from "./inc/settings.mjs";

const execFile = promisify(_execFile);

const sendJson = (res, data, code = 200) => {
    const body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
};

/** Shared admin session + CSRF lookup */
async function getAdminSession(req, res) {
    if (!req.cookies || !req.cookies.session) {
        sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
        return null;
    }

    const user = await db`
        SELECT "user".id, "user".login, "user".user, "user".admin,
               "user_sessions".id AS sess_id, "user_sessions".csrf_token
        FROM "user_sessions"
        LEFT JOIN "user" ON "user".id = "user_sessions".user_id
        WHERE "user_sessions".session = ${lib.sha256(req.cookies.session)}
        LIMIT 1
    `;

    if (user.length === 0 || !user[0].admin) {
        sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
        return null;
    }

    const session = user[0];

    // CSRF validation via header
    if (session.csrf_token) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!csrfToken || csrfToken !== session.csrf_token) {
            console.warn(`[CSRF] Blocked brand image request for user ${session.user}. Invalid token.`);
            sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
            return null;
        }
    }

    return session;
}

/** Delete the physical file for a stored brand image URL (if any) */
async function deleteOldBrandFile() {
    const current = getBrandImageUrl();
    if (!current) return;
    // Strip query string to get the bare filename
    const urlPath = current.split('?')[0];
    // Only delete files that live under our navbar img dir
    if (!urlPath.startsWith('/s/img/navbar/brand.')) return;
    const filename = path.basename(urlPath);
    const filePath = path.join(cfg.paths.s, 'img', 'navbar', filename);
    await fs.unlink(filePath).catch(() => {});
}

/** Persist brand image URL to site_settings DB and in-memory setting */
async function persistBrandImage(url) {
    setBrandImageUrl(url);
    await db`
        INSERT INTO site_settings (key, value)
        VALUES ('brand_image_url', ${url})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
}

// ── Upload ─────────────────────────────────────────────────────────────────
export const handleBrandImageUpload = async (req, res) => {
    console.log('[BRAND UPLOAD] Started');

    const session = await getAdminSession(req, res);
    if (!session) return;

    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)$/);
        if (!boundaryMatch) {
            return sendJson(res, { success: false, msg: 'Invalid content type — multipart boundary missing' }, 400);
        }

        const body = await collectBody(req, 10 * 1024 * 1024); // 10 MB request body cap
        const parts = parseMultipart(body, boundaryMatch[1]);
        const file = parts.file;

        if (!file || !file.data || file.data.length === 0) {
            return sendJson(res, { success: false, msg: 'No file provided' }, 400);
        }

        // 5 MB cap
        const maxSize = 5 * 1024 * 1024;
        if (file.data.length > maxSize) {
            return sendJson(res, {
                success: false,
                msg: `File too large. Maximum is 5 MB, got ${(file.data.length / 1024 / 1024).toFixed(2)} MB`
            }, 400);
        }

        const allowedMimes = ['image/gif', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/svg+xml'];
        const mime = (file.contentType || '').toLowerCase().split(';')[0].trim();
        if (!allowedMimes.includes(mime)) {
            return sendJson(res, {
                success: false,
                msg: `Invalid file type. Allowed: gif, jpg, png, webp, svg. Got: ${mime}`
            }, 400);
        }

        const imgDir = path.join(cfg.paths.s, 'img', 'navbar');
        await fs.mkdir(imgDir, { recursive: true });
        await fs.mkdir(cfg.paths.tmp, { recursive: true });

        const isSvg = mime === 'image/svg+xml';
        const ts = Date.now();
        // Timestamp baked into the filename — every upload is a unique file
        const outFilename = isSvg ? `brand.${ts}.svg` : `brand.${ts}.webp`;
        const tmpPath = path.join(cfg.paths.tmp, `brand_tmp_${ts}`);
        const finalPath = path.join(imgDir, outFilename);

        await fs.writeFile(tmpPath, file.data);

        if (!isSvg) {
            // Verify actual MIME with file(1)
            try {
                const { stdout: actualMime } = await execFile('file', ['--mime-type', '-b', tmpPath]);
                const safeActual = ['image/gif', 'image/jpeg', 'image/png', 'image/webp'];
                if (!safeActual.includes(actualMime.trim())) {
                    await fs.unlink(tmpPath).catch(() => {});
                    return sendJson(res, { success: false, msg: `Invalid file type detected: ${actualMime.trim()}` }, 400);
                }
            } catch (_) {
                // file(1) not available — skip magic check
            }

            // Convert to WebP via ImageMagick
            try {
                await execFile('magick', [tmpPath, '-coalesce', '-quality', '85', finalPath]);
            } catch (err) {
                console.error('[BRAND UPLOAD] ImageMagick error:', err);
                await fs.unlink(tmpPath).catch(() => {});
                return sendJson(res, { success: false, msg: 'Failed to process image (ImageMagick required)' }, 500);
            }
        } else {
            // SVG: copy as-is
            await fs.copyFile(tmpPath, finalPath);
        }

        await fs.unlink(tmpPath).catch(() => {});

        // Delete the previous brand file from disk
        await deleteOldBrandFile();

        const publicUrl = `/s/img/navbar/${outFilename}`;

        await persistBrandImage(publicUrl);
        await db`SELECT pg_notify('brand_image', ${JSON.stringify({ url: publicUrl })})`.catch(() => {});
        await audit.log(session.id, 'update_brand_image', 'system', 0, { url: publicUrl });

        console.log('[BRAND UPLOAD] Done:', publicUrl);
        return sendJson(res, { success: true, url: publicUrl, msg: 'Brand image updated' });

    } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') {
            return sendJson(res, { success: false, msg: 'File too large (5 MB max)' }, 413);
        }
        console.error('[BRAND UPLOAD ERROR]', err);
        return sendJson(res, { success: false, msg: 'Upload failed: ' + err.message }, 500);
    }
};

// ── Delete ─────────────────────────────────────────────────────────────────
export const handleBrandImageDelete = async (req, res) => {
    console.log('[BRAND DELETE] Started');

    const session = await getAdminSession(req, res);
    if (!session) return;

    try {
        // Delete the physical file before clearing the setting
        await deleteOldBrandFile();

        await persistBrandImage('');
        await db`SELECT pg_notify('brand_image', ${JSON.stringify({ url: null })})`.catch(() => {});
        await audit.log(session.id, 'delete_brand_image', 'system', 0, {});

        console.log('[BRAND DELETE] Done');
        return sendJson(res, { success: true, msg: 'Brand image removed' });
    } catch (err) {
        console.error('[BRAND DELETE ERROR]', err);
        return sendJson(res, { success: false, msg: 'Delete failed: ' + err.message }, 500);
    }
};
