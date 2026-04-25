// user_hall_image_handler.mjs
// Handles multipart upload of custom images for user-owned halls.
// Mirrors the pattern used in hall_image_handler.mjs.

import cfg from "./inc/config.mjs";
import path from "path";
import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

const HALL_CUSTOM_DIR = path.join(cfg.paths.s, '../hall_custom');
const HALL_CACHE_DIR  = path.join(cfg.paths.s, '../hall_cache');

const sendJson = (res, data, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const lookupSession = async (req) => {
  if (!req.cookies?.session) return null;
  const users = await db`
    SELECT "user".id, "user".user, "user".admin, "user".is_moderator,
           "user_sessions".id as sess_id, "user_sessions".csrf_token
    FROM "user_sessions"
    LEFT JOIN "user" ON "user".id = "user_sessions".user_id
    WHERE "user_sessions".session = ${lib.sha256(req.cookies.session)}
    LIMIT 1
  `;
  return users.length > 0 ? users[0] : null;
};

const clearUserHallCache = async (userId, slug) => {
  const { createHash } = await import('crypto');
  for (const mode of [0, 1, 2]) {
    const hash = createHash('md5').update(`uh_${userId}_${slug}_${mode}`).digest('hex');
    await fs.unlink(path.join(HALL_CACHE_DIR, hash + '.webp')).catch(() => {});
  }
};

// Called by the bypass middleware in index.mjs for POST /api/v2/me/halls/:slug/image
export const handleUserHallImageUpload = async (req, res, slug) => {
  const session = await lookupSession(req);
  if (!session) return sendJson(res, { success: false, msg: 'Unauthorized' }, 403);

  // CSRF check
  const token = req.headers['x-csrf-token'];
  if (!token || token !== session.csrf_token) {
    return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
  }

  // Look up the hall (must be owned by this user)
  const hall = (await db`
    SELECT id FROM user_halls
    WHERE user_id = ${session.id} AND slug = ${slug}
    LIMIT 1
  `)[0];
  if (!hall) return sendJson(res, { success: false, msg: 'Hall not found' }, 404);

  try {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    if (!boundaryMatch) return sendJson(res, { success: false, msg: 'Invalid content type' }, 400);

    let boundary = boundaryMatch[1].trim();
    if (boundary.startsWith('"') && boundary.endsWith('"')) boundary = boundary.slice(1, -1);

    const body = await collectBody(req);
    const parts = parseMultipart(body, boundary);
    const file = parts.file;

    if (!file?.data) return sendJson(res, { success: false, msg: 'No file provided' }, 400);
    if (file.data.length > 10 * 1024 * 1024) return sendJson(res, { success: false, msg: 'File too large (10 MB max)' }, 400);

    const allowedMimes = ['image/gif', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const fileMime = (file.contentType || '').toLowerCase().trim();
    if (!allowedMimes.includes(fileMime))
      return sendJson(res, { success: false, msg: 'Invalid file type: ' + fileMime }, 400);

    await fs.mkdir(HALL_CUSTOM_DIR, { recursive: true });

    const tmpPath = path.join(cfg.paths.tmp || '/tmp', `uhall_${session.id}_${slug}_tmp`);
    const finalPath = path.join(HALL_CUSTOM_DIR, `u_${session.id}_${slug}.webp`);

    await fs.writeFile(tmpPath, file.data);

    // Verify with file magic
    const { stdout: actualMime } = await execFile('file', ['--mime-type', '-b', tmpPath]);
    if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(actualMime.trim())) {
      await fs.unlink(tmpPath).catch(() => {});
      return sendJson(res, { success: false, msg: 'Invalid file type: ' + actualMime.trim() }, 400);
    }

    // Resize to 600x300 webp
    try {
      await execFile('magick', [tmpPath, '-coalesce', '-resize', '600x300^', '-gravity', 'center', '-extent', '600x300', '-quality', '85', finalPath]);
    } catch (err) {
      console.error('[USER_HALL_IMG] Magick error:', err.stderr || err.message);
      await fs.unlink(tmpPath).catch(() => {});
      return sendJson(res, { success: false, msg: 'Failed to process image' }, 500);
    }

    await fs.unlink(tmpPath).catch(() => {});
    await clearUserHallCache(session.id, slug);
    await db`UPDATE user_halls SET custom_image = true WHERE id = ${hall.id}`;

    console.log('[USER_HALL_IMG] Uploaded custom image for:', slug, 'by user:', session.id);
    return sendJson(res, { success: true });
  } catch (err) {
    console.error('[USER_HALL_IMG] Upload error:', err);
    return sendJson(res, { success: false, msg: err.message || 'Upload failed' }, 500);
  }
};
