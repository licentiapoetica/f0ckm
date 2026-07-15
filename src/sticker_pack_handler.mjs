import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import cfg from "./inc/config.mjs";
import { collectBody } from "./inc/multipart.mjs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fetch from "flumm-fetch"; // used for JSON API calls only
import https from "https";
import http from "http";

const execFile = promisify(_execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGICK_POLICY_PATH = path.resolve(__dirname, '../config/magick-policy');
const magickEnv = { ...process.env, MAGICK_CONFIGURE_PATH: MAGICK_POLICY_PATH };

const sendJson = (res, data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

const requireAdmin = async (req, res) => {
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
        sendJson(res, { success: false, message: 'Unauthorized' }, 403);
        return null;
    }
    const csrfToken = req.headers['x-csrf-token'];
    if (user[0].csrf_token && (!csrfToken || csrfToken !== user[0].csrf_token)) {
        sendJson(res, { success: false, message: 'Invalid CSRF token' }, 403);
        return null;
    }
    return user[0];
};

/**
 * Download a file from a URL and return it as a raw Buffer.
 * Uses Node's built-in https/http directly — flumm-fetch's .buffer() method
 * calls setEncoding('utf8') which corrupts binary image data.
 */
const downloadBuffer = (url) => {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https://') ? https : http;
        mod.get(url, (res) => {
            if (res.statusCode >= 400) {
                res.resume(); // drain the socket
                return reject(new Error('HTTP ' + res.statusCode + ' fetching ' + url));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
};

/**
 * Convert a buffer to WebP and write to the emojis dir.
 * Returns the relative URL path.
 */
const saveAsWebP = async (buffer, originalExt) => {
    const randSuffix = crypto.randomBytes(24).toString('hex');
    const webpFilename = randSuffix + '.webp';
    const webpPath = path.join(cfg.paths.emojis, webpFilename);

    if (originalExt === 'webp') {
        await fs.writeFile(webpPath, buffer);
    } else {
        const tmpFilename = randSuffix + '_tmp.' + originalExt;
        const tmpPath = path.join(cfg.paths.emojis, tmpFilename);
        await fs.writeFile(tmpPath, buffer);
        try {
            await execFile('magick', [tmpPath, '-coalesce', '-quality', '80', webpPath], { env: magickEnv });
        } finally {
            await fs.unlink(tmpPath).catch(() => {});
        }
    }

    const stat = await fs.stat(webpPath);
    if (!stat || stat.size === 0) throw new Error('WebP conversion produced empty file');

    return '/s/emojis/' + webpFilename;
};

/**
 * Save a raw buffer directly to the emojis dir with the given extension (no re-encoding).
 * Used for video stickers (.webm) which browsers can play natively.
 */
const saveRaw = async (buffer, ext) => {
    const randSuffix = crypto.randomBytes(24).toString('hex');
    const filename = randSuffix + '.' + ext;
    const filePath = path.join(cfg.paths.emojis, filename);
    await fs.writeFile(filePath, buffer);
    const stat = await fs.stat(filePath);
    if (!stat || stat.size === 0) throw new Error('Saved file is empty');
    return '/s/emojis/' + filename;
};

/**
 * Import a Telegram sticker pack given its name (short name from t.me/addstickers/<name>).
 * Creates a sticker_pack record and downloads all stickers as custom_emojis.
 */
export const handleImportTelegramPack = async (req, res) => {
    const user = await requireAdmin(req, res);
    if (!user) return;

    let body = {};
    try {
        const raw = await collectBody(req);
        body = JSON.parse(raw.toString());
    } catch (e) {
        return sendJson(res, { success: false, message: 'Invalid JSON body' }, 400);
    }

    const { pack_name, display_name } = body;
    if (!pack_name || typeof pack_name !== 'string') {
        return sendJson(res, { success: false, message: 'pack_name is required' }, 400);
    }

    // Get Telegram bot token
    const tgClient = cfg.clients.find(c => c.type === 'tg');
    if (!tgClient || !tgClient.token) {
        return sendJson(res, { success: false, message: 'Telegram bot not configured' }, 500);
    }
    const botToken = tgClient.token;

    const tgName = pack_name.trim().replace(/^https?:\/\/t\.me\/addstickers\//i, '');
    if (!tgName) {
        return sendJson(res, { success: false, message: 'Could not extract pack name from URL' }, 400);
    }

    console.log(`[STICKER PACK] Importing Telegram pack: ${tgName}`);

    // Check if pack already imported
    const existing = await db`SELECT id FROM sticker_packs WHERE tg_name = ${tgName} LIMIT 1`;
    if (existing.length > 0) {
        return sendJson(res, { success: false, message: `Pack "${tgName}" was already imported (ID ${existing[0].id})` }, 409);
    }

    // Call Telegram API
    let stickerSet;
    try {
        const apiRes = await fetch(`https://api.telegram.org/bot${botToken}/getStickerSet?name=${encodeURIComponent(tgName)}`);
        const apiData = await apiRes.json();
        if (!apiData.ok) {
            return sendJson(res, { success: false, message: `Telegram API error: ${apiData.description || 'unknown'}` }, 400);
        }
        stickerSet = apiData.result;
    } catch (e) {
        console.error('[STICKER PACK] Telegram API fetch failed:', e);
        return sendJson(res, { success: false, message: `Failed to contact Telegram API: ${e.message}` }, 500);
    }

    const packTitle = display_name?.trim() || stickerSet.title || tgName;
    const stickers = stickerSet.stickers || [];

    console.log(`[STICKER PACK] Found ${stickers.length} stickers in "${stickerSet.title}"`);

    // Create pack record
    const [newPack] = await db`
        INSERT INTO sticker_packs (name, tg_name, tg_title, sticker_count)
        VALUES (${packTitle}, ${tgName}, ${stickerSet.title}, ${stickers.length})
        RETURNING id, name, tg_name, tg_title
    `;

    // Generate a static WebP thumbnail for the pack from the first sticker's Telegram thumbnail.
    // Telegram always provides a static webp thumbnail for every sticker regardless of type.
    let packThumbUrl = null;
    const firstThumb = stickers[0]?.thumbnail;
    if (firstThumb && firstThumb.file_id) {
        try {
            const tRes  = await fetch('https://api.telegram.org/bot' + botToken + '/getFile?file_id=' + encodeURIComponent(firstThumb.file_id));
            const tData = await tRes.json();
            if (tData.ok && tData.result && tData.result.file_path) {
                const tBuf = await downloadBuffer('https://api.telegram.org/file/bot' + botToken + '/' + tData.result.file_path);
                const tExt = (tData.result.file_path.match(/\.([a-z0-9]+)$/i) || ['', 'webp'])[1].toLowerCase();
                packThumbUrl = await saveAsWebP(tBuf, tExt);
                await db`UPDATE sticker_packs SET thumb_url = ${packThumbUrl} WHERE id = ${newPack.id}`;
                console.log('[STICKER PACK] Pack thumbnail saved: ' + packThumbUrl);
            }
        } catch (e) {
            console.warn('[STICKER PACK] Could not save pack thumbnail:', e.message);
        }
    }
    let imported = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < stickers.length; i++) {
        const sticker = stickers[i];
        try {
            // Skip only animated TGS stickers (Lottie format — cannot be displayed as-is)
            const isAnimated = sticker.is_animated || false;
            const isVideo    = sticker.is_video    || false;
            if (isAnimated) {
                console.log('[STICKER PACK] Skipping animated (TGS) sticker ' + (i + 1));
                continue;
            }

            const fileId = sticker.file_id;

            // Resolve the download URL via getFile
            const fileRes  = await fetch('https://api.telegram.org/bot' + botToken + '/getFile?file_id=' + encodeURIComponent(fileId));
            const fileData = await fileRes.json();
            if (!fileData.ok || !fileData.result || !fileData.result.file_path) {
                throw new Error('getFile failed: ' + (fileData.description || 'no file_path'));
            }

            const filePath = fileData.result.file_path;
            const extMatch = filePath.match(/\.([a-z0-9]+)$/i);
            const ext      = extMatch ? extMatch[1].toLowerCase() : 'webp';

            const downloadUrl = 'https://api.telegram.org/file/bot' + botToken + '/' + filePath;
            const buffer = await downloadBuffer(downloadUrl);

            // Generate emoji name from pack name + index
            const safeName  = tgName.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
            const emojiName = safeName + '_' + String(i + 1).padStart(3, '0');

            // Check for name conflict
            const nameConflict = await db`SELECT id FROM custom_emojis WHERE name = ${emojiName} LIMIT 1`;
            const finalName = nameConflict.length > 0 ? emojiName + '_' + crypto.randomBytes(3).toString('hex') : emojiName;

            // Save: video stickers (.webm) stored as-is; static stickers converted to WebP
            let savedUrl;
            if (isVideo) {
                savedUrl = await saveRaw(buffer, ext);  // keeps original webm, no re-encoding
                console.log('[STICKER PACK] Saved video sticker ' + (i + 1) + ' as ' + ext);
            } else {
                savedUrl = await saveAsWebP(buffer, ext);
            }

            await db`
                INSERT INTO custom_emojis (name, url, pack_id)
                VALUES (${finalName}, ${savedUrl}, ${newPack.id})
            `;

            imported++;
            console.log('[STICKER PACK] Imported sticker ' + (i + 1) + '/' + stickers.length + ': ' + finalName + ' (' + (isVideo ? 'video' : 'static') + ')');

            // Small delay to avoid Telegram rate limits
            if (i < stickers.length - 1) await new Promise(function(resolve) { setTimeout(resolve, 50); });

        } catch (e) {
            console.error('[STICKER PACK] Failed sticker ' + (i + 1) + ':', e.message);
            errors.push('Sticker ' + (i + 1) + ': ' + e.message);
            failed++;
        }
    }

    // Update pack with actual imported count
    await db`UPDATE sticker_packs SET sticker_count = ${imported} WHERE id = ${newPack.id}`;

    // Notify clients that emojis changed
    await db`NOTIFY emojis_updated, '{}'`;

    console.log(`[STICKER PACK] Done. Imported: ${imported}, Failed: ${failed}`);

    return sendJson(res, {
        success: true,
        pack: { ...newPack, sticker_count: imported },
        imported,
        failed,
        errors
    });
};
