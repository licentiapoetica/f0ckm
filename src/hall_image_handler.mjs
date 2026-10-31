import cfg from "./inc/config.mjs";
import path from "path";
import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import audit from "./inc/audit.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

const HALL_IMG_DIR = path.join(cfg.paths.s, '../hall_custom');
const HALL_CACHE_DIR = path.join(cfg.paths.s, '../hall_cache');

const sendJson = (res, data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

// Direct DB session lookup — same pattern as emoji_upload_handler.mjs
const lookupSession = async (req) => {
    if (!req.cookies || !req.cookies.session) return null;
    const users = await db`
        select "user".id, "user".login, "user".user, "user".admin, "user".is_moderator,
               "user_sessions".id as sess_id, "user_sessions".csrf_token
        from "user_sessions"
        left join "user" on "user".id = "user_sessions".user_id
        where "user_sessions".session = ${lib.sha256(req.cookies.session)}
        limit 1
    `;
    return users.length > 0 ? users[0] : null;
};

const clearHallCache = async (hallSlug) => {
    const { createHash } = await import('crypto');
    for (const mode of [0, 1, 2]) {
        const hash = createHash('md5').update(hallSlug + '_' + mode).digest('hex');
        await fs.unlink(path.join(HALL_CACHE_DIR, hash + '.webp')).catch(() => {});
    }
};

// POST /api/v2/admin/halls/:slug/image — upload a custom image for a hall
export const handleHallImageUpload = async (req, res) => {
    console.error('[BOOT] [HALL IMG] Upload started');

    const session = await lookupSession(req);
    if (!session || (!session.admin && !session.is_moderator)) {
        console.error('[BOOT] [HALL IMG] Unauthorized');
        return sendJson(res, { success: false, msg: 'Unauthorized' }, 403);
    }

    // CSRF check
    const token = req.headers['x-csrf-token'] || req.url?.qs?.csrf_token;
    if (!token || token !== session.csrf_token) {
        return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
    }

    const hallSlug = req.params && req.params.slug;
    if (!hallSlug) return sendJson(res, { success: false, msg: 'Missing hall slug' }, 400);

    const hall = await db`SELECT id, custom_image FROM halls WHERE slug = ${hallSlug} LIMIT 1`;
    if (!hall.length) return sendJson(res, { success: false, msg: 'Hall not found' }, 404);

    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=([^;]+)/);
        if (!boundaryMatch) return sendJson(res, { success: false, msg: 'Invalid content type' }, 400);

        let boundary = boundaryMatch[1].trim();
        if (boundary.startsWith('"') && boundary.endsWith('"')) boundary = boundary.slice(1, -1);

        const body = await collectBody(req);
        const parts = parseMultipart(body, boundary);
        const file = parts.file;

        if (!file || !file.data) return sendJson(res, { success: false, msg: 'No file provided' }, 400);
        if (file.data.length > 10 * 1024 * 1024) return sendJson(res, { success: false, msg: 'File too large (10 MB max)' }, 400);

        const allowedMimes = ['image/gif', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        const fileMime = (file.contentType || '').toLowerCase().trim();
        if (!allowedMimes.includes(fileMime))
            return sendJson(res, { success: false, msg: 'Invalid file type: ' + fileMime }, 400);

        await fs.mkdir(HALL_IMG_DIR, { recursive: true });

        const tmpPath = path.join(cfg.paths.tmp || '/tmp', 'hall_img_' + hallSlug + '_tmp');
        const finalFilename = hallSlug + '.webp';
        const finalPath = path.join(HALL_IMG_DIR, finalFilename);

        await fs.writeFile(tmpPath, file.data);

        // Verify with file magic
        const { stdout: actualMime } = await execFile('file', ['--mime-type', '-b', tmpPath]);
        if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(actualMime.trim())) {
            await fs.unlink(tmpPath).catch(() => {});
            return sendJson(res, { success: false, msg: 'Invalid file type: ' + actualMime.trim() }, 400);
        }

        // Resize to 600x300 webp
        // -coalesce is required for animated GIFs: it composites delta frames into full frames
        // before resizing, preventing heavy artifacts. Output is animated WebP for GIFs.
        try {
            await execFile('magick', [tmpPath, '-coalesce', '-resize', '600x300^', '-gravity', 'center', '-background', 'none', '-extent', '600x300', '-quality', '85', finalPath]);
        } catch (err) {
            console.error('[HALL IMG] Magick error:', err.stderr || err.message);
            await fs.unlink(tmpPath).catch(() => {});
            return sendJson(res, { success: false, msg: 'Failed to process image' }, 500);
        }
        await fs.unlink(tmpPath).catch(() => {});

        await db`UPDATE halls SET custom_image = ${finalFilename} WHERE slug = ${hallSlug}`;
        await clearHallCache(hallSlug);

        console.error('[BOOT] [HALL IMG] Uploaded custom image for:', hallSlug);
        return sendJson(res, { success: true, msg: 'Image uploaded', file: finalFilename });

    } catch (err) {
        console.error('[HALL IMG] Upload error:', err);
        return sendJson(res, { success: false, msg: err.message || 'Upload failed' }, 500);
    }
};

// DELETE /api/v2/admin/halls/:slug/image — remove custom image
export const handleHallImageDelete = async (req, res) => {
    const session = await lookupSession(req);
    if (!session || (!session.admin && !session.is_moderator)) return sendJson(res, { success: false, msg: 'Unauthorized' }, 403);
    const token = req.headers['x-csrf-token'] || req.url?.qs?.csrf_token;
    if (!token || token !== session.csrf_token) return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);

    const hallSlug = req.params && req.params.slug;
    if (!hallSlug) return sendJson(res, { success: false, msg: 'Missing hall slug' }, 400);

    const hall = await db`SELECT id, custom_image FROM halls WHERE slug = ${hallSlug} LIMIT 1`;
    if (!hall.length) return sendJson(res, { success: false, msg: 'Hall not found' }, 404);

    // Always delete the canonical {slug}.webp from disk regardless of DB value
    const filePath = path.join(HALL_IMG_DIR, hallSlug + '.webp');
    try {
        await fs.unlink(filePath);
        console.error('[HALL IMG] Deleted file:', filePath);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.error('[HALL IMG] Failed to delete file:', filePath, e.message);
        }
        // ENOENT = already gone, that's fine
    }

    // Also delete whatever the DB says (in case it differs)
    if (hall[0].custom_image && hall[0].custom_image !== hallSlug + '.webp') {
        await fs.unlink(path.join(HALL_IMG_DIR, hall[0].custom_image)).catch((e) => {
            if (e.code !== 'ENOENT') console.error('[HALL IMG] Failed to delete legacy file:', e.message);
        });
    }

    await db`UPDATE halls SET custom_image = NULL WHERE slug = ${hallSlug}`;
    await clearHallCache(hallSlug);

    return sendJson(res, { success: true, msg: 'Custom image removed' });
};

// DELETE /api/v2/admin/halls/:slug — delete a hall entirely
export const handleHallDelete = async (req, res) => {
    const session = await lookupSession(req);
    if (!session || (!session.admin && !session.is_moderator)) return sendJson(res, { success: false, msg: 'Unauthorized' }, 403);
    const token = req.headers['x-csrf-token'] || req.url?.qs?.csrf_token;
    if (!token || token !== session.csrf_token) return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);

    const hallSlug = req.params && req.params.slug;
    if (!hallSlug) return sendJson(res, { success: false, msg: 'Missing hall slug' }, 400);

    await db`DELETE FROM halls_assign WHERE hall_id = (SELECT id FROM halls WHERE slug = ${hallSlug})`.catch(() => {});
    await db`DELETE FROM halls WHERE slug = ${hallSlug}`;

    await fs.unlink(path.join(HALL_IMG_DIR, hallSlug + '.webp')).catch(() => {});
    await clearHallCache(hallSlug);

    console.error('[BOOT] [HALL] Deleted hall:', hallSlug);
    return sendJson(res, { success: true, msg: 'Hall deleted' });
};

// PATCH /api/v2/admin/halls/:slug — update name/description/slug
export const handleHallUpdate = async (req, res) => {
    const session = await lookupSession(req);
    if (!session || (!session.admin && !session.is_moderator)) return sendJson(res, { success: false, msg: 'Unauthorized' }, 403);
    const token = req.headers['x-csrf-token'] || req.url?.qs?.csrf_token;
    if (!token || token !== session.csrf_token) return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);

    const hallSlug = req.params && req.params.slug;
    if (!hallSlug) return sendJson(res, { success: false, msg: 'Missing slug' }, 400);

    // For PATCH requests, parse body manually since this is a bypass handler
    let body = {};
    try {
        const raw = await collectBody(req);
        body = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        body = req.post || {};
    }

    const { name, description } = body;
    const rawRating = body.rating;
    const rating = ['sfw', 'nsfw', 'nsfl'].includes(rawRating) ? rawRating : null;
    const rawSlug = body.slug;

    // Handle slug rename
    if (rawSlug !== undefined) {
        const newSlug = rawSlug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (!newSlug) return sendJson(res, { success: false, msg: 'Slug cannot be empty' }, 400);

        if (newSlug !== hallSlug) {
            // Check for conflict with another hall
            const conflict = await db`SELECT id FROM halls WHERE slug = ${newSlug} LIMIT 1`;
            if (conflict.length > 0) {
                return sendJson(res, { success: false, msg: 'A hall with that slug already exists' }, 409);
            }

            // Rename custom image file on disk
            const oldFile = path.join(HALL_IMG_DIR, hallSlug + '.webp');
            const newFile = path.join(HALL_IMG_DIR, newSlug + '.webp');
            try {
                await fs.rename(oldFile, newFile);
                console.error('[HALL IMG] Renamed image:', hallSlug + '.webp', '->', newSlug + '.webp');
            } catch (e) {
                if (e.code !== 'ENOENT') console.error('[HALL IMG] Failed to rename image:', e.message);
            }

            // Update slug in DB and fix custom_image filename if set
            await db`
                UPDATE halls
                SET slug = ${newSlug},
                    custom_image = CASE WHEN custom_image IS NOT NULL THEN ${newSlug + '.webp'} ELSE NULL END
                WHERE slug = ${hallSlug}
            `;

            await clearHallCache(hallSlug);
            await clearHallCache(newSlug);

            // Update name/description/rating under the new slug
            if (name !== undefined && name.trim()) {
                await db`UPDATE halls SET name = ${name.trim()} WHERE slug = ${newSlug}`;
            }
            if (description !== undefined) {
                await db`UPDATE halls SET description = ${description} WHERE slug = ${newSlug}`;
            }
            if (rating) {
                await db`UPDATE halls SET rating = ${rating} WHERE slug = ${newSlug}`;
            }

            await audit.log(session.id, 'rename_hall', 'hall', newSlug, { old_slug: hallSlug, new_slug: newSlug, name: name?.trim(), description });
            return sendJson(res, { success: true, msg: 'Hall updated', newSlug });
        }
    }

    // No slug change — just update name/description/rating
    if (name !== undefined && name.trim()) {
        await db`UPDATE halls SET name = ${name.trim()} WHERE slug = ${hallSlug}`;
    }
    if (description !== undefined) {
        await db`UPDATE halls SET description = ${description} WHERE slug = ${hallSlug}`;
    }
    if (rating) {
        await db`UPDATE halls SET rating = ${rating} WHERE slug = ${hallSlug}`;
    }

    await audit.log(session.id, 'update_hall', 'hall', hallSlug, { name: name?.trim(), description });
    return sendJson(res, { success: true, msg: 'Hall updated' });
};

// POST /api/v2/admin/halls — create a new hall
export const handleHallCreate = async (req, res) => {
    const session = await lookupSession(req);
    if (!session || (!session.admin && !session.is_moderator)) return sendJson(res, { success: false, msg: 'Unauthorized' }, 403);

    // CSRF check
    const token = req.headers['x-csrf-token'] || req.url?.qs?.csrf_token;
    if (!token || token !== session.csrf_token) {
        return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
    }

    let body = {};
    try {
        const raw = await collectBody(req);
        body = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        return sendJson(res, { success: false, msg: 'Invalid JSON body' }, 400);
    }

    const name = (body.name || '').trim();
    const slug = (body.slug || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const rawRating = body.rating;
    const rating = ['sfw', 'nsfw', 'nsfl'].includes(rawRating) ? rawRating : 'sfw';

    if (!name) return sendJson(res, { success: false, msg: 'Name is required' }, 400);
    if (!slug) return sendJson(res, { success: false, msg: 'Could not derive a valid slug from the name' }, 400);

    // Check for duplicate slug
    const existing = await db`SELECT id FROM halls WHERE slug = ${slug} LIMIT 1`;
    if (existing.length > 0) return sendJson(res, { success: false, msg: 'A hall with that slug already exists' }, 409);

    await db`INSERT INTO halls (name, slug, description, rating) VALUES (${name}, ${slug}, '', ${rating})`;

    await audit.log(session.id, 'create_hall', 'hall', slug, { name, slug });
    console.error('[HALL] Created hall:', slug, '-', name);
    return sendJson(res, { success: true, msg: 'Hall created', slug });
};
