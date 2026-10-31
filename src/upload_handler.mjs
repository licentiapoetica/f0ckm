import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import cfg from "./inc/config.mjs";
import { applyWordFilter } from "./inc/wordfilter.mjs";
import queue from "./inc/queue.mjs";
import path from "path";
import https from "https";
import { getManualApproval, getMinTags, getTrustedUploads, getBypassDuplicateCheck, getEnablePdf, getEnableItemSlugs, canAnonDo, isAnonSession } from "./inc/settings.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";
import f0cklib from "./inc/routeinc/f0cklib.mjs";
import { calculateExpiresAt } from "./inc/routes/apiv2/upload.mjs";
import { addPrivateItem } from "./inc/private_items.mjs";
import { resolveAuditIP, logAnonActivity } from "./inc/anon_auth.mjs";
import { TRANSCODE_TO_MP4, transcodeToMp4 } from "./inc/transcode.mjs";
import { isSquareClickerActive } from "./inc/square_clicker.mjs";
import { readOsz, saveDiffs, setTitle } from "./inc/beatmap.mjs";


// Derive archive MIME types from cfg.mimes — any application/* that isn't swf or pdf.
// Adding a new archive type to config.json is sufficient; no code change needed.
const ARCHIVE_MIMES = new Set(
    Object.entries(cfg.mimes)
        .filter(([mime, ext]) => mime.startsWith('application/') && !['swf', 'pdf'].includes(ext))
        .map(([mime]) => mime)
);
const isArchiveMime = (mime) => ARCHIVE_MIMES.has(mime);

const autoTagsFromUrl = (urlString) => {
    const tags = [];
    try {
        const { hostname } = new URL(urlString);
        const host = hostname.replace(/:\d+$/, '').toLowerCase();
        const parts = host.split('.');
        const shortSlds = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne']);
        let domain;
        if (parts.length >= 3 && shortSlds.has(parts[parts.length - 2])) {
            domain = parts.slice(-3).join('.');
        } else {
            domain = parts.slice(-2).join('.');
        }
        if (/(?:youtube\.com|youtu\.be)$/i.test(domain) || /(?:youtube\.com|youtu\.be)$/i.test(host)) {
            tags.push('youtube');
        }
    } catch (e) {}
    return [...new Set(tags)];
};

// Helper for JSON response
const sendJson = (res, data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

// One-time migration: add original_filename column if it doesn't exist
db`ALTER TABLE items ADD COLUMN IF NOT EXISTS original_filename text`.catch(() => {});

// One-time migration: restore title column for backwards compatibility with old databases
db`ALTER TABLE items ADD COLUMN IF NOT EXISTS title text`.catch(() => {});

// One-time migration: add width/height columns for image and video dimension storage
db`ALTER TABLE items ADD COLUMN IF NOT EXISTS width integer`.catch(() => {});
db`ALTER TABLE items ADD COLUMN IF NOT EXISTS height integer`.catch(() => {});
db`ALTER TABLE items ADD COLUMN IF NOT EXISTS expires_at bigint DEFAULT NULL`.catch(() => {});


// One-time migration: widen checksum column to varchar(255) for SHA-256 + bypass suffix support
// (old schema had varchar(40), sized for SHA-1 — SHA-256 is 64 chars and bypass suffix adds more)
db`ALTER TABLE items ALTER COLUMN checksum TYPE character varying(255)`.catch(() => {});

// One-time migration: widen dest column to varchar(60) — UUID (32) + dot + extension can exceed 40 chars
db`ALTER TABLE items ALTER COLUMN dest TYPE character varying(60)`.catch(() => {});
db`ALTER TABLE comment_files ALTER COLUMN dest TYPE character varying(60)`.catch(() => {});

// One-time migration: fix NULL visibility values and ensure NOT NULL default going forward
db`UPDATE items SET visibility = 0 WHERE visibility IS NULL`.catch(() => {});
db`ALTER TABLE items ALTER COLUMN visibility SET DEFAULT 0`.catch(() => {});

export const handleUpload = async (req, res, self) => {
    // Manual session lookup is required here because this handler is called from a 
    // bypass middleware that runs in parallel with the main session middleware.
    if (req.cookies?.session) {
        try {
            const user = await db`
                select "user".id, "user".login, "user".user, "user".admin, "user".is_moderator, "user_sessions".id as sess_id, "user_sessions".csrf_token, "user_options".*
                from "user_sessions"
                left join "user" on "user".id = "user_sessions".user_id
                left join "user_options" on "user_options".user_id = "user_sessions".user_id
                where "user_sessions".session = ${lib.sha256(req.cookies.session)}
                limit 1
            `;
            if (user.length > 0) {
                req.session = user[0];
            }
        } catch (err) {
        }
    }

    // Fallback: authenticate via X-Api-Key header (upload-only; no CSRF required)
    if (!req.session && req.headers['x-api-key'] && cfg.websrv.enable_user_api_keys !== false) {
        const key = req.headers['x-api-key'];
        try {
            const rows = await db`
                SELECT u.id, u.user, u.login, u.admin, u.is_moderator, u.banned,
                       uo.*
                FROM user_api_keys k
                JOIN "user" u ON u.id = k.user_id
                LEFT JOIN user_options uo ON uo.user_id = u.id
                WHERE k.api_key = ${key}
                LIMIT 1
            `;
            if (rows.length > 0) {
                if (rows[0].banned) {
                    return sendJson(res, { success: false, msg: 'Account banned' }, 403);
                }
                req.session = { ...rows[0], api_key_auth: true };
            }
        } catch (err) {
            console.error('[UPLOAD] API key lookup error:', err);
        }
    }

    if (!req.session) {
        return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
    }

    if (isAnonSession(req.session)) {
        if (!canAnonDo('upload')) {
            return sendJson(res, { success: false, msg: 'Uploading requires a registered account or anonymous upload permission' }, 403);
        }
    }

    // CSRF validation — required for browser sessions, skipped for API key auth.
    if (!req.session.api_key_auth) {
        const csrfToken = req.headers['x-csrf-token'];
        if (!req.session.csrf_token || !csrfToken || csrfToken !== req.session.csrf_token) {
            return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
        }
    }

    try {
        const contentType = req.headers['content-type'] || '';
        let parts = {};

        // Determine max file size early for collectBody
        let effectiveMaxBytes = cfg.main.maxfilesize || (150 * 1024 * 1024);
        if (req.session?.admin) {
            effectiveMaxBytes = Math.floor(effectiveMaxBytes * (cfg.main.adminmultiplier || 10));
        }

        let body;
        try {
            body = await collectBody(req, effectiveMaxBytes);
        } catch (bodyErr) {
            throw bodyErr;
        }

        if (contentType.includes('multipart/form-data')) {
            const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
            if (!boundaryMatch) {
                return sendJson(res, { success: false, msg: 'Invalid multipart boundary' }, 400);
            }
            const boundary = boundaryMatch[1] || boundaryMatch[2];
            parts = parseMultipart(body, boundary);
        } else if (contentType.includes('application/json')) {
            try {
                parts = JSON.parse(body.toString());
            } catch (e) {
                return sendJson(res, { success: false, msg: 'Invalid JSON body' }, 400);
            }
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
            const params = new URLSearchParams(body.toString());
            for (const [key, value] of params.entries()) {
                parts[key] = value;
            }
        } else {
            return sendJson(res, { success: false, msg: 'Invalid content type' }, 400);
        }

        // Validate required fields
        let rawFiles = [];
        if (Array.isArray(parts.files)) rawFiles = parts.files;
        else if (Array.isArray(parts.file)) rawFiles = parts.file;
        else if (parts.files && typeof parts.files === 'object' && parts.files.data) rawFiles = [parts.files];
        else if (parts.file && typeof parts.file === 'object' && parts.file.data) rawFiles = [parts.file];

        let file = rawFiles[0] || null;
        let inputUrl = (typeof parts.url === 'string' && parts.url.trim()) ? parts.url.trim() : null;

        if (!inputUrl && typeof parts.file === 'string' && /^https?:\/\//i.test(parts.file.trim())) {
            inputUrl = parts.file.trim();
        }

        if (inputUrl) {
            file = null;
            rawFiles = [];
            try {
                const parsed = new URL(inputUrl);
                if (parsed.searchParams.has('igsh')) {
                    parsed.searchParams.delete('igsh');
                    inputUrl = parsed.toString();
                }
            } catch (e) {}
        }

        const rating = parts.rating;
        const tagsRaw = parts.tags;
        const comment = parts.comment ? String(parts.comment).trim() : '';
        const rawTitle = parts.title ? String(parts.title).trim() : '';
        let title = rawTitle.length > 0 ? rawTitle.substring(0, 500) : null;

        const is_oc = (parts.is_oc === true || parts.is_oc === 'true' || parts.is_oc === '1');

        // Collect URL items submitted as subf0ck_url_{i} fields (e.g. YouTube links in album mode)
        const albumUrlItems = [];
        for (let i = 0; i < 101; i++) {
            const urlVal = typeof parts[`subf0ck_url_${i}`] === 'string' ? parts[`subf0ck_url_${i}`].trim() : null;
            if (urlVal && /^https?:\/\//i.test(urlVal)) {
                albumUrlItems.push({ index: i, url: urlVal });
            }
        }

        const totalAlbumItems = rawFiles.length + albumUrlItems.length;
        const isAlbumRequested = (parts.is_album === true || parts.is_album === 'true' || parts.is_album === '1') || (totalAlbumItems > 1 && !parts.is_shitpost);
        const is_album = isAlbumRequested && totalAlbumItems > 1;
        const is_shitpost = !is_album && ((parts.is_shitpost === true || parts.is_shitpost === 'true' || parts.is_shitpost === '1') || cfg.websrv.shitpost_mode === true);

        const maxAlbumItems = cfg.websrv?.max_album_items || cfg.websrv?.max_album_images || 100;
        if (is_album && totalAlbumItems > maxAlbumItems) {
            return sendJson(res, { success: false, msg: `Album exceeds maximum limit of ${maxAlbumItems} items` }, 400);
        }

        if (!file && !inputUrl && albumUrlItems.length === 0) {
            return sendJson(res, { success: false, msg: 'No file or URL provided' }, 400);
        }

        // For URL-only albums: use the first URL as the primary inputUrl
        if (!file && !inputUrl && albumUrlItems.length > 0) {
            inputUrl = albumUrlItems[0].url;
        }

        if (inputUrl && cfg.websrv.web_url_upload === false) {
            return sendJson(res, { success: false, msg: 'URL uploads are disabled' }, 403);
        }

        // Parse visibility: Header 'X-Upload-Visibility' or body field 'visibility' or user default preference
        let targetVisibility = 0;
        if (cfg.enable_private_uploads !== false) {
            const sysDefault = (typeof cfg.default_upload_visibility === 'number')
                ? cfg.default_upload_visibility
                : (typeof cfg.websrv?.default_upload_visibility === 'number' ? cfg.websrv.default_upload_visibility : 0);

            const allowUserOverride = cfg.allow_user_upload_visibility !== false && cfg.websrv?.allow_user_upload_visibility !== false;

            if (!allowUserOverride) {
                targetVisibility = sysDefault;
            } else {
                const rawVisHeader = req.headers['x-upload-visibility'];
                const rawVisBody = parts.visibility;
                const visVal = (rawVisHeader || rawVisBody || '').toString().trim().toLowerCase();

                if (visVal === 'private' || visVal === '2') {
                    targetVisibility = 2;
                } else if (visVal === 'unlisted' || visVal === '1') {
                    targetVisibility = 1;
                } else if (visVal === 'public' || visVal === '0') {
                    targetVisibility = 0;
                } else {
                    targetVisibility = (req.session?.default_upload_visibility !== undefined && req.session?.default_upload_visibility !== null)
                        ? req.session.default_upload_visibility
                        : sysDefault;
                }
            }
        }

        const rawExpiry = req.headers['x-upload-expiry'] || parts.expiry || parts.expires_at;
        const nowStamp = ~~(Date.now() / 1000);
        const targetExpiresAt = calculateExpiresAt(rawExpiry, nowStamp);

        // Always generate a unique item slug for the database
        const itemSlug = lib.generateSlug(11);

        const maxLen = cfg.main.comment_max_length;
        if (comment && maxLen !== null && maxLen !== undefined && comment.length > maxLen) {
            return sendJson(res, { success: false, msg: `Comment too long (max ${maxLen} characters)` }, 400);
        }

        const effectiveRating = (rating && ['sfw', 'nsfw', 'nsfl'].includes(rating)) ? rating : null;

        // Admins uploading via API key (ShareX, f0ckm-uploader, …) may skip the rating in every mode; the post is then untagged
        const isAdminApiUpload = !!(req.session.api_key_auth && req.session.admin);
        if (!is_shitpost && !isAdminApiUpload && !effectiveRating) {
            return sendJson(res, { success: false, msg: 'Rating (sfw/nsfw/nsfl) is required' }, 400);
        }

        if (is_shitpost && !isAdminApiUpload && cfg.websrv.shitpost_require_rating === true && !effectiveRating) {
            return sendJson(res, { success: false, msg: 'Rating (sfw/nsfw/nsfl) is required for each item' }, 400);
        }

        if (effectiveRating === 'nsfl' && !cfg.enable_nsfl) {
            return sendJson(res, { success: false, msg: 'NSFL mode is currently disabled' }, 400);
        }

        const userTags = tagsRaw ? String(tagsRaw).split(',').map(t => t.trim()).filter(t => t.length > 0 && !['sfw', 'nsfw', 'nsfl'].includes(t.toLowerCase())) : [];
        const autoTags = (inputUrl && !file) ? autoTagsFromUrl(inputUrl) : [];
        const tags = [...new Set([...userTags, ...autoTags])];

        const minTags = getMinTags();
        const shitpostMinTags = is_shitpost ? (parseInt(cfg.websrv.shitpost_min_tags) || 0) : 0;
        if (!is_shitpost && minTags > 0 && userTags.length < minTags) {
            return sendJson(res, { success: false, msg: `At least ${minTags} tag${minTags !== 1 ? 's' : ''} required` }, 400);
        }
        if (is_shitpost && shitpostMinTags > 0 && userTags.length < shitpostMinTags) {
            return sendJson(res, { success: false, msg: `At least ${shitpostMinTags} tag${shitpostMinTags !== 1 ? 's' : ''} required` }, 400);
        }

        // Validate MIME type for attached file
        const allowedCats = Array.isArray(cfg.allowedMimes)
            ? cfg.allowedMimes.map(c => c.toLowerCase())
            : null;
        const allowedMimes = allowedCats
            ? Object.keys(cfg.mimes).filter(m =>
                allowedCats.some(cat =>
                    cat.includes('/') ? m === cat : m.startsWith(`${cat}/`)
                )
              )
            : Object.keys(cfg.mimes);

        if (file && !inputUrl) {
            let mime = file.contentType;
            if ((mime === 'application/octet-stream' || !mime || mime === 'application/x-www-form-urlencoded') &&
                file.filename && file.filename.toLowerCase().endsWith('.swf')) {
                mime = 'application/x-shockwave-flash';
            }
            // Beatmap sets (.osz) come as octet-stream; they are unpacked into an audio item further down
            const isBeatmapSet = isSquareClickerActive() && /\.osz$/i.test(file.filename || '');
            if (!allowedMimes.includes(mime) && !isBeatmapSet) {
                return sendJson(res, { success: false, msg: `Invalid file type: ${mime}` }, 400);
            }
        }

        if (is_album && rawFiles.length > 0) {
            for (let i = 0; i < rawFiles.length; i++) {
                const f = rawFiles[i];
                if (!f || !f.data || f.data.length === 0) {
                    return sendJson(res, { success: false, msg: `Album item #${i + 1} is empty` }, 400);
                }
            }
        }

        let manualApproval = getManualApproval();
        const trustedThreshold = getTrustedUploads();
        if (trustedThreshold > 0 && !req.session.admin && !req.session.is_moderator) {
            try {
                const totalUploads = await db`
                    SELECT count(*) as count 
                    FROM items 
                    WHERE username = ${req.session.user} 
                    AND is_deleted = false
                `;
                if (parseInt(totalUploads[0].count) < trustedThreshold) {
                    manualApproval = true;
                }
            } catch (err) {
                manualApproval = true; 
            }
        }

        if (!manualApproval && !req.session.admin && !req.session.is_moderator) {
            const twelveHoursAgo = ~~(Date.now() / 1000) - (12 * 3600);
            const uploadCount = await db`
                SELECT count(*) as count 
                FROM items 
                WHERE username = ${req.session.user} 
                AND stamp > ${twelveHoursAgo} 
                AND is_deleted = false
            `;
            const uploadLimit = cfg.main.upload_limit ?? 69;
            if (parseInt(uploadCount[0].count) >= uploadLimit) {
                return sendJson(res, {
                    success: false,
                    msg: `Rate limit exceeded. You can only upload ${uploadLimit} files every 12 hours.`
                }, 429);
            }
        }

        // Check for YouTube Embeds when url is provided without a file attachment
        const ytRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\?(?:\S*?&?v\=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;
        const ytMatch = (!file && inputUrl) ? inputUrl.match(ytRegex) : null;

        if (ytMatch && cfg.websrv.enable_youtube_upload !== false) {
            const videoId = ytMatch[1];
            const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const filename = `yt:${videoId}`;

            const auditIp = resolveAuditIP(req);
            const [{ id: itemid }] = await db`
                insert into items ${db({
                    src: ytUrl,
                    dest: filename,
                    mime: 'video/youtube',
                    size: 0,
                    checksum: `yt_${videoId}_${Date.now()}`,
                    phash: null,
                    username: req.session.user,
                    userchannel: 'web',
                    usernetwork: 'web',
                    stamp: nowStamp,
                    active: !manualApproval,
                    is_oc: !!is_oc,
                    title: title,
                    visibility: targetVisibility,
                    slug: itemSlug,
                    expires_at: targetExpiresAt,
                    uploader_ip: auditIp
                }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active', 'is_oc', 'title', 'visibility', 'slug', 'expires_at', 'uploader_ip')}
                RETURNING id
            `;

            if (req.session?.is_anon) {
                await logAnonActivity(req, {
                    action: 'upload',
                    targetId: itemid,
                    details: { type: 'youtube', videoId, slug: itemSlug }
                });
            }

            if (targetVisibility === 2) {
                addPrivateItem(itemid, filename, req.session.user);
            }

            if (cfg.enable_comments !== false) {
                try {
                    await db`INSERT INTO comment_subscriptions (user_id, item_id) VALUES (${req.session.id}, ${itemid}) ON CONFLICT DO NOTHING`;
                } catch (err) {}
            }

            try {
                await queue.genThumbnail(filename, 'video/youtube', itemid, ytUrl, manualApproval);
            } catch (err) {
                const tDir = manualApproval ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
                await queue.spawn('magick', ['-size', '128x128', 'xc:#1a1a1a', '-gravity', 'center', '-fill', '#666', '-pointsize', '20', '-annotate', '0', 'YouTube', path.join(tDir, `${itemid}.webp`)]).catch(() => {});
            }

            if (effectiveRating) {
                const ratingTagId = effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3));
                await db`insert into tags_assign ${db({ item_id: itemid, tag_id: ratingTagId, user_id: req.session.id })} on conflict do nothing`;
                await queue.genBlurredThumbnail(itemid, manualApproval).catch(() => {});
            }

            for (const tagName of tags) {
                let tagRow = await db`select id from tags where normalized = slugify(${tagName}) limit 1`;
                if (tagRow.length === 0) {
                    await db`insert into tags ${db({ tag: tagName }, 'tag')}`;
                    tagRow = await db`select id from tags where normalized = slugify(${tagName}) limit 1`;
                }
                await db`insert into tags_assign ${db({ item_id: itemid, tag_id: tagRow[0].id, user_id: req.session.id })} on conflict do nothing`;
            }

            if (comment && comment.length > 0) {
                try {
                    const filteredComment = await applyWordFilter(comment);
                    await db`INSERT INTO comments ${db({ item_id: itemid, user_id: req.session.id, content: filteredComment })}`;
                } catch (err) {}
            }

            if (is_oc) {
                const ocTags = ['oc', 'original content'];
                for (const ocName of ocTags) {
                    let tagRow = await db`select id from tags where normalized = slugify(${ocName}) limit 1`;
                    if (tagRow.length === 0) {
                        await db`insert into tags ${db({ tag: ocName }, 'tag')}`;
                        tagRow = await db`select id from tags where normalized = slugify(${ocName}) limit 1`;
                    }
                    await db`insert into tags_assign ${db({ item_id: itemid, tag_id: tagRow[0].id, user_id: req.session.id })} on conflict do nothing`;
                }
            }

            if (!manualApproval) {
                f0cklib.clearCountCache();
                try {
                    await db`SELECT pg_notify('new_item', ${JSON.stringify({
                        id: itemid,
                        dest: filename,
                        mime: 'video/youtube',
                        username: req.session.user,
                        display_name: req.session.display_name || null,
                        tag_id: effectiveRating ? (effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3))) : 0,
                        is_oc: !!is_oc,
                        slug: itemSlug,
                        visibility: targetVisibility,
                        is_album: !!is_album,
                        album_count: is_album ? totalAlbumItems : 0
                    })})`;
                } catch (err) {
                    console.error('[UPLOAD] YouTube new_item notify failed:', err);
                }
            }

            // If this is a URL-only album, insert cover into album_items and process remaining URL sub-items
            if (is_album && albumUrlItems.length > 0) {
                const coverSubSlug = lib.generateSlug(11);
                await db`
                    INSERT INTO album_items ${db({
                        item_id: itemid,
                        dest: filename,
                        mime: 'video/youtube',
                        size: 0,
                        checksum: `yt_${videoId}_cover_${Date.now()}`,
                        phash: null,
                        width: null,
                        height: null,
                        order_index: 0,
                        slug: coverSubSlug
                    }, 'item_id', 'dest', 'mime', 'size', 'checksum', 'phash', 'width', 'height', 'order_index', 'slug')}
                `;

                // Update the parent item to mark it as an album
                await db`UPDATE items SET is_album = true, album_count = ${totalAlbumItems} WHERE id = ${itemid}`;

                const ytRegexAlbum = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\?(?:\S*?&?v=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;
                for (let ui = 1; ui < albumUrlItems.length; ui++) {
                    const urlItem = albumUrlItems[ui];
                    const subYtMatch = urlItem.url.match(ytRegexAlbum);
                    if (!subYtMatch) continue;
                    const subVideoId = subYtMatch[1];
                    const subYtUrl = `https://www.youtube.com/watch?v=${subVideoId}`;
                    const subYtFilename = `yt:${subVideoId}`;
                    const subYtSlug = lib.generateSlug(11);

                    const insertedYtSub = await db`
                        INSERT INTO album_items ${db({
                            item_id: itemid,
                            dest: subYtFilename,
                            mime: 'video/youtube',
                            size: 0,
                            checksum: `yt_${subVideoId}_${Date.now()}_${ui}`,
                            phash: null,
                            width: null,
                            height: null,
                            order_index: ui,
                            slug: subYtSlug
                        }, 'item_id', 'dest', 'mime', 'size', 'checksum', 'phash', 'width', 'height', 'order_index', 'slug')}
                        RETURNING id
                    `;
                    const subYtItemId = insertedYtSub?.[0]?.id;
                    try {
                        await queue.genThumbnail(subYtFilename, 'video/youtube', subYtItemId || 0, subYtUrl, manualApproval);
                    } catch (_) {
                        const tDir = manualApproval ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
                        await queue.spawn('magick', ['-size', '128x128', 'xc:#1a1a1a', '-gravity', 'center', '-fill', '#666', '-pointsize', '20', '-annotate', '0', 'YouTube', path.join(tDir, `${subYtSlug}.webp`)]).catch(() => {});
                    }
                }
            }

            const itemRoute = itemSlug ? `/${itemSlug}` : `/${itemid}`;
            const successMsg = manualApproval ? 'Upload successful! Your upload is pending admin approval.' : 'Upload successful! Your upload is now live.';
            return sendJson(res, {
                success: true,
                msg: successMsg,
                itemid: itemid,
                slug: itemSlug,
                visibility: targetVisibility,
                manual_approval: manualApproval,
                redirect: !manualApproval ? itemRoute : null,
                url: !manualApproval ? `${cfg.main.url.full}${itemRoute}` : `${cfg.main.url.full}/pending#i${itemid}`,
                status: manualApproval ? 'pending' : 'live',
                status_url: `${cfg.main.url.full}/pending#i${itemid}`,
                status_api: `${cfg.main.url.full}/api/v2/uploads/${itemid}/status`,
                file_url: null,
                dest: filename,
                mime: 'video/youtube',
                tag_id: effectiveRating ? (effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3))) : 0,
                is_oc: !!is_oc,
                display_name: req.session.display_name || null,
                username: req.session.user,
                is_album: !!is_album,
                album_count: is_album ? totalAlbumItems : 0
            });
        }

        // Check repost link if uploading via URL (non-YouTube)
        if (!file && inputUrl && !getBypassDuplicateCheck()) {
            const repostLink = await queue.checkrepostlink(inputUrl);
            if (repostLink) {
                return sendJson(res, { success: false, msg: 'This URL has already been uploaded', repost: repostLink }, 409);
            }
        }

        // Generate UUID & Base Paths
        const uuid = await queue.genuuid();
        const tmpPath = path.join(cfg.paths.tmp, `${uuid}.tmp`);

        // Ensure directories exist
        await fs.mkdir(cfg.paths.tmp, { recursive: true });
        await fs.mkdir(path.join(cfg.paths.pending, 'b'), { recursive: true });
        await fs.mkdir(path.join(cfg.paths.pending, 't'), { recursive: true });
        await fs.mkdir(path.join(cfg.paths.pending, 'ca'), { recursive: true });

        if (file && file.data) {
            await fs.writeFile(tmpPath, file.data);
        } else if (inputUrl) {
            const proxyArgs = (cfg.main.socks && cfg.main.socks !== 'undefined') ? ['--proxy', cfg.main.socks] : [];
            const ytdlpArgs = ['--js-runtimes', 'node', '--geo-bypass', '--extractor-args', 'youtube:player-client=ios,web', '--newline', '--no-colors'];
            const isInstagram = /instagram\.com/i.test(inputUrl);
            let downloadedFile = null;

            try {
                const { stdout } = await queue.spawn('yt-dlp', [
                    ...proxyArgs, ...ytdlpArgs,
                    '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w',
                    inputUrl,
                    '--max-filesize', `${effectiveMaxBytes / 1024}k`,
                    '--postprocessor-args', 'ffmpeg:-bitexact',
                    '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`),
                    '--print', 'after_move:filepath',
                    '--merge-output-format', 'mp4'
                ], { quiet: true });
                downloadedFile = stdout.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0).pop();
            } catch (err1) {
                if (isInstagram) {
                    return sendJson(res, { success: false, msg: 'Failed to download Instagram URL' }, 400);
                }
                try {
                    const { stdout } = await queue.spawn('yt-dlp', [
                        ...proxyArgs, ...ytdlpArgs,
                        inputUrl,
                        '--max-filesize', `${effectiveMaxBytes / 1024}k`,
                        '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`),
                        '--print', 'after_move:filepath'
                    ], { quiet: true });
                    downloadedFile = stdout.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0).pop();
                } catch (err2) {
                    const fallbackTmp = path.join(cfg.paths.tmp, `${uuid}.curl_tmp`);
                    let referer = inputUrl;
                    try {
                        const parsedUrl = new URL(inputUrl);
                        let host = parsedUrl.hostname;
                        if (host.includes('imgur.com')) host = 'imgur.com';
                        referer = `${parsedUrl.protocol}//${host}/`;
                    } catch (e) {}

                    const curlArgs = [
                        '-s', '-S', '-f', '-L', inputUrl, '-o', fallbackTmp,
                        '--max-filesize', `${effectiveMaxBytes}`,
                        '--connect-timeout', '30',
                        '--max-time', '300',
                        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        '--referer', referer,
                        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        '-H', 'Accept-Language: en-US,en;q=0.9'
                    ];
                    if (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') {
                        const proxyHost = cfg.main.socks.includes('://') ? cfg.main.socks.split('://')[1] : cfg.main.socks;
                        curlArgs.push('--socks5-hostname', proxyHost);
                    }
                    try {
                        await queue.spawn('curl', curlArgs);
                        downloadedFile = fallbackTmp;
                    } catch (curlErr) {
                        return sendJson(res, { success: false, msg: 'Failed to download file from URL' }, 400);
                    }
                }
            }

            let exists = false;
            if (downloadedFile) {
                try {
                    await fs.access(downloadedFile);
                    exists = true;
                } catch (e) {}
            }
            if (!exists) {
                return sendJson(res, { success: false, msg: 'Failed to download file from URL' }, 400);
            }

            if (downloadedFile !== tmpPath) {
                await fs.rename(downloadedFile, tmpPath);
            }
        }

        // Verify actual MIME (second check after file-command detection)
        let actualMime = (await queue.spawn('file', ['--mime-type', '-b', tmpPath])).stdout.trim();

        // Beatmap set (a zip with .osu difficulties, usually .osz): the item becomes its song, the
        // background its cover art, and every standard-mode difficulty a Square Clicker map
        let beatmapSet = null;
        if (isSquareClickerActive() && !is_album && /zip/.test(actualMime)) {
            beatmapSet = await readOsz(await fs.readFile(tmpPath)).catch(e => { console.warn('[UPLOAD] Beatmap read failed:', e.message); return null; });
            if (beatmapSet) {
                const fail = (msg) => fs.unlink(tmpPath).catch(() => { }).then(() => sendJson(res, { success: false, msg }, 400));
                if (!beatmapSet.audio) return fail('This beatmap set has no audio file.');
                if (!beatmapSet.diffs.length) {
                    return fail('No playable difficulty in this beatmap set' + (beatmapSet.skipped.length ? ' (' + beatmapSet.skipped.map(d => d.version + ': ' + d.reason).join('; ') + ')' : '') + '.');
                }
                await fs.writeFile(tmpPath, beatmapSet.audio.data);
                actualMime = (await queue.spawn('file', ['--mime-type', '-b', tmpPath])).stdout.trim();
                // headerless mp3s are sometimes not recognised: trust the extension then
                if (!actualMime.startsWith('audio/')) {
                    const ext = (beatmapSet.audio.name.split('.').pop() || '').toLowerCase();
                    actualMime = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4' }[ext] || actualMime;
                }
                if (!title) {
                    const t = setTitle(beatmapSet.meta);
                    if (t) title = t.substring(0, 500);
                }
                console.log(`[UPLOAD] Beatmap set: ${beatmapSet.diffs.length} difficulties, audio ${beatmapSet.audio.name} (${actualMime})`);
            }
        }

        if (!allowedMimes.includes(actualMime)) {
            await fs.unlink(tmpPath).catch(() => { });
            return sendJson(res, { success: false, msg: `Invalid file type detected: ${actualMime}` }, 400);
        }

        if (actualMime === 'application/pdf' && !getEnablePdf()) {
            await fs.unlink(tmpPath).catch(() => { });
            return sendJson(res, { success: false, msg: 'PDF uploads are currently disabled.' }, 403);
        }

        if (isArchiveMime(actualMime) && cfg.websrv.enable_archive === false) {
            await fs.unlink(tmpPath).catch(() => { });
            return sendJson(res, { success: false, msg: 'Archive uploads are currently disabled.' }, 403);
        }

        // Video browsers can't play (MPEG-1/2 .mpg): re-encode to H.264 MP4 in place, before hashing,
        // duplicate checks and probing, so the rest of the pipeline sees a normal mp4
        if (TRANSCODE_TO_MP4.has(actualMime)) {
            const converted = tmpPath + '.mp4';
            try {
                await transcodeToMp4(queue, tmpPath, converted);
                await fs.rename(converted, tmpPath);
                actualMime = 'video/mp4';
            } catch (convErr) {
                console.error('[UPLOAD] Transcode to mp4 failed:', convErr.message);
                await fs.unlink(converted).catch(() => { });
                await fs.unlink(tmpPath).catch(() => { });
                return sendJson(res, { success: false, msg: 'Could not convert this video to a playable format.' }, 400);
            }
        }

        // ── Phase A: parallel analysis of tmpPath ─────────────────────────────
        // sha256sum, PHash, and dimension probing all just read the file —
        // none depends on the other, so run them concurrently.
        const needsPHash    = !isArchiveMime(actualMime);
        const needsDims     = !isArchiveMime(actualMime);
        const needsAudioMP4 = (actualMime === 'video/mp4' || actualMime === 'video/quicktime');

        const [
            checksumResult,
            phashResult,
            dimResult,
            audioMp4Result
        ] = await Promise.all([
            // 1. SHA-256 checksum
            queue.spawn('sha256sum', [tmpPath]).then(r => r.stdout.trim().split(' ')[0]),

            // 2. Perceptual hash (skip for archives)
            needsPHash
                ? queue.generatePHash(tmpPath).catch(e => { console.error('[UPLOAD] PHash error:', e); return null; })
                : Promise.resolve(null),

            // 3. Pixel dimensions (skip for archives)
            needsDims
                ? (async () => {
                    try {
                        if (actualMime.startsWith('image/')) {
                            const { stdout: magickOut } = await queue.spawn('magick', [
                                'identify', '-format', '%wx%h\n', tmpPath + '[0]'
                            ], { quiet: true, ignoreExitCode: true });
                            const line = magickOut.trim().split('\n')[0];
                            const match = line.match(/^(\d+)x(\d+)$/);
                            if (match) return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
                        } else if (actualMime.startsWith('video/') && actualMime !== 'video/youtube') {
                            const { stdout: probeOut } = await queue.spawn('ffprobe', [
                                '-v', 'error',
                                '-select_streams', 'v:0',
                                '-show_entries', 'stream=width,height',
                                '-of', 'csv=p=0',
                                tmpPath
                            ], { quiet: true, ignoreExitCode: true });
                            const dimParts = probeOut.trim().split(',');
                            if (dimParts.length >= 2) {
                                const w = parseInt(dimParts[0], 10);
                                const h = parseInt(dimParts[1], 10);
                                if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) return { width: w, height: h };
                            }
                        }
                    } catch (dimErr) {
                        console.warn(`[UPLOAD] Dimension probe failed for ${actualMime} (non-fatal):`, dimErr.message);
                    }
                    return null;
                })()
                : Promise.resolve(null),

            // 4. Audio-only MP4 reclassification probe (only when needed)
            needsAudioMP4
                ? (async () => {
                    const origExt = file?.filename ? file.filename.split('.').pop().toLowerCase() : (inputUrl ? inputUrl.split('?')[0].split('.').pop().toLowerCase() : '');
                    if (['m4a', 'aac'].includes(origExt)) {
                        return 'audio/mp4'; // Extension-based reclassification
                    }
                    try {
                        const probeResult = await queue.spawn('ffprobe', [
                            '-v', 'error', '-select_streams', 'v:0',
                            '-show_entries', 'stream=codec_type',
                            '-of', 'csv=p=0', tmpPath
                        ]);
                        if (!probeResult.stdout.trim()) return 'audio/mp4';
                    } catch (err) { /* ffprobe unavailable, keep original */ }
                    return null; // No reclassification needed
                })()
                : Promise.resolve(null),
        ]);

        const checksum = checksumResult;
        let phash = phashResult;
        const itemWidth  = dimResult?.width  ?? null;
        const itemHeight = dimResult?.height ?? null;

        // Apply audio/MP4 reclassification if detected
        if (audioMp4Result) {
            actualMime = audioMp4Result;
            console.log(`[UPLOAD] Reclassified to ${audioMp4Result}`);
        }

        // Resolve final filename now that actualMime is settled
        const ext = cfg.mimes[actualMime] || 'bin';
        const filename = `${uuid}.${ext}`;
        const destPath = path.join(cfg.paths.pending, 'b', filename);

        // ── Phase B: parallel duplicate checks ────────────────────────────────
        // Both are read-only DB queries — run them together.
        if (!getBypassDuplicateCheck()) {
            const [repostBySum, repostByPhash] = await Promise.all([
                queue.checkrepostsum(checksum),
                (phash ? queue.checkrepostphash(phash) : Promise.resolve(null)),
            ]);

            if (repostBySum) {
                await fs.unlink(tmpPath).catch(() => {});
                // The song of a beatmap set is already here: add the difficulties to that item instead
                if (beatmapSet) {
                    const [existing] = await db`SELECT id, mime FROM items WHERE id = ${repostBySum} AND is_deleted = false LIMIT 1`;
                    if (existing && /^audio\//.test(existing.mime || '')) {
                        const r = await saveDiffs({ itemId: existing.id, userId: req.session.id, diffs: beatmapSet.diffs });
                        return sendJson(res, { success: false, msg: `This song already exists: ${r.ids.length} beatmap difficult${r.ids.length === 1 ? 'y was' : 'ies were'} added to it`, repost: repostBySum, maps_added: r.ids.length }, 409);
                    }
                }
                return sendJson(res, { success: false, msg: 'This file already exists', repost: repostBySum }, 409);
            }
            if (repostByPhash) {
                await fs.unlink(tmpPath).catch(() => {});
                return sendJson(res, { success: false, msg: 'This file is a visual duplicate', repost: repostByPhash }, 409);
            }
        }

        // ─────────────────────────────────────────────────────────────────────

        // When bypass is active, symlink to the existing file if one already exists on disk.
        // We write the symlink straight into cfg.paths.b so we can skip the pending flow entirely.
        let linkedToExisting = false;
        if (getBypassDuplicateCheck()) {
            console.error(`[UPLOAD] bypass: looking up existing file for checksum ${checksum}`);
            const existing = await db`
                SELECT dest, checksum FROM items
                WHERE checksum = ${checksum} OR checksum LIKE ${checksum + '_bypass_%'}
                ORDER BY id DESC
                LIMIT 1
            `;
            console.error(`[UPLOAD] bypass: DB lookup found ${existing.length} row(s)`, existing.length ? existing[0].checksum : '');
            if (existing.length > 0) {
                const existingFile = existing[0].dest;
                const existingAbsPath = path.join(cfg.paths.b, existingFile);
                try {
                    // Resolve to the real file to avoid symlink chains
                    const realTargetAbsPath = await fs.realpath(existingAbsPath);
                    
                    // Determine where the symlink will live
                    // If manual approval is enabled, it lives in pending/b. Otherwise directly in public/b.
                    const symlinkPath = manualApproval ? destPath : path.join(cfg.paths.b, filename);
                    const symlinkDir = path.dirname(symlinkPath);
                    
                    // Calculate relative path for the symlink target
                    const relativeTarget = path.relative(symlinkDir, realTargetAbsPath);
                    
                    await fs.symlink(relativeTarget, symlinkPath);
                    linkedToExisting = true;
                    console.error(`[UPLOAD] bypass: symlinked ${symlinkPath} → ${relativeTarget}`);
                } catch (e) {
                    console.error(`[UPLOAD ERROR] bypass symlink failed:`, e);
                }
            } else {
                console.error(`[UPLOAD] bypass: no existing file found for ${checksum}`);
            }
        }

        if (!linkedToExisting) {
            // Normal path: copy tmp to pending/b, to be moved to public later
            await fs.copyFile(tmpPath, destPath);
        }
        await fs.unlink(tmpPath).catch(() => { });

        // When bypass is active the real checksum may already exist in the DB (unique constraint).
        // Suffix it so the INSERT can proceed — the file is genuinely a new item entry.
        const insertChecksum = getBypassDuplicateCheck() ? `${checksum}_bypass_${Date.now()}` : checksum;


        // Insert
        const size = (file?.data && !beatmapSet) ? file.data.length : (await fs.stat(destPath).then(s => s.size).catch(() => 0));
        let originalFilename = file ? (file.filename || null) : null;
        if (!originalFilename && inputUrl) {
            try {
                const parsedName = path.basename(new URL(inputUrl).pathname);
                if (parsedName && parsedName !== '/') originalFilename = parsedName;
            } catch (e) {}
        }

        const auditIp = resolveAuditIP(req);
        await db`
          insert into items ${db({
            src: inputUrl || '',
            dest: filename,
            mime: actualMime,
            size: size,
            checksum: insertChecksum,
            phash: phash,
            username: req.session.user,
            userchannel: 'web',
            usernetwork: 'web',
            stamp: nowStamp,
            active: !manualApproval,
            is_oc: is_oc,
            original_filename: originalFilename,
            title: title,
            width: itemWidth,
            height: itemHeight,
            visibility: targetVisibility,
            slug: itemSlug,
            expires_at: targetExpiresAt,
            uploader_ip: auditIp,
            is_album: !!is_album,
            album_count: is_album ? totalAlbumItems : 0
        }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active', 'is_oc', 'original_filename', 'title', 'width', 'height', 'visibility', 'slug', 'expires_at', 'uploader_ip', 'is_album', 'album_count')}
        `;

        const itemid = await queue.getItemID(filename);

        if (is_album) {
            // 1. Insert primary/cover image (file 0) as order_index 0
            const coverSubSlug = lib.generateSlug(11);
            await db`
                INSERT INTO album_items ${db({
                    item_id: itemid,
                    dest: filename,
                    mime: actualMime,
                    size: size,
                    checksum: insertChecksum,
                    phash: phash,
                    width: itemWidth,
                    height: itemHeight,
                    order_index: 0,
                    slug: coverSubSlug
                }, 'item_id', 'dest', 'mime', 'size', 'checksum', 'phash', 'width', 'height', 'order_index', 'slug')}
            `;

            // 2. Process and insert remaining album images (1 .. rawFiles.length - 1)
            for (let i = 1; i < rawFiles.length; i++) {
                const subFile = rawFiles[i];
                if (!subFile || !subFile.data) continue;
                const subUuid = await queue.genuuid();
                const subTmpPath = path.join(cfg.paths.tmp, `${subUuid}.tmp`);
                await fs.writeFile(subTmpPath, subFile.data);

                let subMime = (await queue.spawn('file', ['--mime-type', '-b', subTmpPath])).stdout.trim();
                const allowedMimesList = Object.keys(cfg.mimes || {});
                if (!allowedMimesList.includes(subMime) && subMime !== 'application/x-shockwave-flash' && subMime !== 'application/vnd.adobe.flash.movie') {
                    const extFromMime = cfg.mimes?.[subFile.contentType] ? subFile.contentType : null;
                    if (extFromMime) subMime = extFromMime;
                    else {
                        await fs.unlink(subTmpPath).catch(() => {});
                        continue;
                    }
                }

                const [subChecksum, subPhash, subDims] = await Promise.all([
                    queue.spawn('sha256sum', [subTmpPath]).then(r => r.stdout.trim().split(' ')[0]),
                    queue.generatePHash(subTmpPath).catch(() => null),
                    (async () => {
                        try {
                            if (subMime.startsWith('image/')) {
                                const { stdout: magickOut } = await queue.spawn('magick', [
                                    'identify', '-format', '%wx%h\n', subTmpPath + '[0]'
                                ], { quiet: true, ignoreExitCode: true });
                                const line = magickOut.trim().split('\n')[0];
                                const match = line.match(/^(\d+)x(\d+)$/);
                                if (match) return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
                            } else if (subMime.startsWith('video/')) {
                                const { stdout: probeOut } = await queue.spawn('ffprobe', [
                                    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', subTmpPath
                                ], { quiet: true, ignoreExitCode: true });
                                const line = probeOut.trim().split('\n')[0];
                                const match = line.match(/^(\d+)x(\d+)$/);
                                if (match) return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
                            }
                        } catch (e) {}
                        return null;
                    })()
                ]);

                const subExt = cfg.mimes[subMime] || 'webp';
                const subFilename = `${subUuid}.${subExt}`;
                const subDestPath = manualApproval ? path.join(cfg.paths.pending, 'b', subFilename) : path.join(cfg.paths.b, subFilename);

                await fs.copyFile(subTmpPath, subDestPath);
                await fs.unlink(subTmpPath).catch(() => {});

                const subWidth = subDims?.width ?? null;
                const subHeight = subDims?.height ?? null;
                const subSize = subFile.data.length;
                const subItemSlug = lib.generateSlug(11);

                const insertedSub = await db`
                    INSERT INTO album_items ${db({
                        item_id: itemid,
                        dest: subFilename,
                        mime: subMime,
                        size: subSize,
                        checksum: subChecksum,
                        phash: subPhash,
                        width: subWidth,
                        height: subHeight,
                        order_index: i,
                        slug: subItemSlug
                    }, 'item_id', 'dest', 'mime', 'size', 'checksum', 'phash', 'width', 'height', 'order_index', 'slug')}
                    RETURNING id
                `;
                const subItemId = insertedSub?.[0]?.id;

                // Process any per-subf0ck tags passed in parts
                const rawSubTags = parts[`subf0ck_tags_${i}`] || parts[`subtags_${i}`];
                if (subItemId && rawSubTags) {
                    const parsedSubTags = String(rawSubTags)
                        .split(/[,;\n]+/)
                        .map(t => t.trim())
                        .filter(t => t.length > 0 && t.length <= 85 && !['sfw', 'nsfw', 'nsfl'].includes(t.toLowerCase()));

                    for (const sTag of parsedSubTags) {
                        try {
                            let tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${sTag}) LIMIT 1`;
                            if (tagRow.length === 0) {
                                await db`INSERT INTO tags ${db({ tag: sTag }, 'tag')}`;
                                tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${sTag}) LIMIT 1`;
                            }
                            if (tagRow.length > 0) {
                                const sTagId = tagRow[0].id;
                                await db`
                                    INSERT INTO album_items_tags_assign (album_item_id, tag_id, user_id)
                                    VALUES (${subItemId}, ${sTagId}, ${req.session.id})
                                    ON CONFLICT DO NOTHING
                                `;
                                await db`
                                    INSERT INTO tags_assign (item_id, tag_id, user_id)
                                    VALUES (${itemid}, ${sTagId}, ${req.session.id})
                                    ON CONFLICT DO NOTHING
                                `;
                            }
                        } catch (stErr) {
                            console.warn(`[UPLOAD] Error assigning tag "${sTag}" to subf0ck ${subItemId}:`, stErr.message);
                        }
                    }
                } else if (subItemId && tags && tags.length > 0) {
                    // Backfill initial post tags to cover subf0ck
                    for (const sTag of tags) {
                        try {
                            let tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${sTag}) LIMIT 1`;
                            if (tagRow.length > 0) {
                                await db`
                                    INSERT INTO album_items_tags_assign (album_item_id, tag_id, user_id)
                                    VALUES (${subItemId}, ${tagRow[0].id}, ${req.session.id})
                                    ON CONFLICT DO NOTHING
                                `;
                            }
                        } catch (_) {}
                    }
                }

                // Generate thumbnail for album item filmstrip
                try {
                    const tDir = manualApproval ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
                    const thumbDest = path.join(tDir, `${subUuid}.webp`);
                    if (subMime.startsWith('image/')) {
                        await queue.spawn('magick', [subDestPath + '[0]', '-resize', '256x256^', '-gravity', 'center', '-crop', '256x256+0+0', '+repage', thumbDest]);
                    } else if (subMime.startsWith('video/')) {
                        await queue.spawn('ffmpegthumbnailer', ['-i', subDestPath, '-s', '256', '-o', thumbDest]).catch(async () => {
                            await queue.spawn('ffmpeg', ['-y', '-ss', '00:00:01', '-i', subDestPath, '-vframes', '1', '-vf', 'scale=256:256:force_original_aspect_ratio=increase,crop=256:256', thumbDest]);
                        });
                    } else if (subMime.startsWith('audio/')) {
                        try {
                            const cDir = manualApproval ? path.join(cfg.paths.pending, 'ca') : cfg.paths.ca;
                            const caDest = path.join(cDir, `${subUuid}.webp`);
                            await queue.spawn('ffmpeg', ['-y', '-i', subDestPath, '-an', '-vcodec', 'webp', '-frames:v', '1', caDest], { quiet: true });
                            const caStat = await fs.stat(caDest).catch(() => null);
                            if (caStat && caStat.size > 0) {
                                await queue.spawn('magick', [caDest + '[0]', '-resize', '256x256^', '-gravity', 'center', '-crop', '256x256+0+0', '+repage', thumbDest]);
                            }
                        } catch (_) {}
                    }
                } catch (tErr) {
                    console.warn(`[UPLOAD] Failed to generate thumbnail for album item ${subFilename}:`, tErr.message);
                }
            }

            // Process URL sub-items (e.g. YouTube links added to the album)
            const ytRegexAlbum = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\?(?:\S*?&?v=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;
            for (const urlItem of albumUrlItems) {
                // Skip if this was used as the cover (index 0, already inserted via YouTube flow above)
                if (!file && urlItem.url === inputUrl && urlItem === albumUrlItems[0]) continue;
                const subYtMatch = urlItem.url.match(ytRegexAlbum);
                if (!subYtMatch) continue;
                const subVideoId = subYtMatch[1];
                const subYtUrl = `https://www.youtube.com/watch?v=${subVideoId}`;
                const subYtFilename = `yt:${subVideoId}`;
                const subYtSlug = lib.generateSlug(11);

                const insertedYtSub = await db`
                    INSERT INTO album_items ${db({
                        item_id: itemid,
                        dest: subYtFilename,
                        mime: 'video/youtube',
                        size: 0,
                        checksum: `yt_${subVideoId}_${Date.now()}_${urlItem.index}`,
                        phash: null,
                        width: null,
                        height: null,
                        order_index: rawFiles.length + albumUrlItems.indexOf(urlItem),
                        slug: subYtSlug
                    }, 'item_id', 'dest', 'mime', 'size', 'checksum', 'phash', 'width', 'height', 'order_index', 'slug')}
                    RETURNING id
                `;
                const subYtItemId = insertedYtSub?.[0]?.id;

                // Generate placeholder thumbnail
                try {
                    await queue.genThumbnail(subYtFilename, 'video/youtube', subYtItemId || 0, subYtUrl, manualApproval);
                } catch (_) {
                    const tDir = manualApproval ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
                    await queue.spawn('magick', ['-size', '128x128', 'xc:#1a1a1a', '-gravity', 'center', '-fill', '#666', '-pointsize', '20', '-annotate', '0', 'YouTube', path.join(tDir, `${subYtSlug}.webp`)]).catch(() => {});
                }
            }
        }

        if (req.session?.is_anon) {
            await logAnonActivity(req, {
                action: 'upload',
                targetId: itemid,
                details: { filename, mime: actualMime, slug: itemSlug }
            });
        }

        if (targetVisibility === 2) {
            addPrivateItem(itemid, filename, req.session.user);
        }

        // Automatically subscribe uploader to comment thread
        if (cfg.enable_comments !== false) {
            try {
                await db`
                    INSERT INTO comment_subscriptions (user_id, item_id)
                    VALUES (${req.session.id}, ${itemid})
                    ON CONFLICT DO NOTHING
                `;
            } catch (err) {
                console.error('[UPLOAD HANDLER] Failed to auto-subscribe uploader:', err);
            }
        }

        // Thumbnail & Coverart
        const isPending = linkedToExisting ? manualApproval : true;
        let thumbProcessed = false;

        // Custom Thumbnail for Flash
        const dynThumbSize = 512;
        if (actualMime === 'application/x-shockwave-flash' || actualMime === 'application/vnd.adobe.flash.movie') {
            if (parts.thumbnail && parts.thumbnail.data && parts.thumbnail.data.length > 0) {
                try {
                    const thumbTmp = path.join(cfg.paths.tmp, `${itemid}_custom_thumb.tmp`);
                    await fs.writeFile(thumbTmp, parts.thumbnail.data);
                    
                    const tDir = isPending ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
                    const thumbDest = path.join(tDir, `${itemid}.webp`);
                    
                    await queue.spawn('magick', [thumbTmp, '-resize', `${dynThumbSize}x${dynThumbSize}^`, '-gravity', 'center', '-crop', `${dynThumbSize}x${dynThumbSize}+0+0`, '+repage', thumbDest]);
                    await fs.unlink(thumbTmp).catch(() => {});
                    thumbProcessed = true;
                    console.log(`[UPLOAD] Custom thumbnail processed for Flash item ${itemid}`);
                } catch (thumbErr) {
                    console.error(`[UPLOAD] Custom thumbnail processing failed for item ${itemid}:`, thumbErr);
                }
            }
        }

        if (beatmapSet) {
            // Background as cover art (genThumbnail picks up an existing ca/<id>.webp for audio)
            if (beatmapSet.background) {
                const bgTmp = path.join(cfg.paths.tmp, `${itemid}_beatmap_bg.tmp`);
                try {
                    await fs.writeFile(bgTmp, beatmapSet.background.data);
                    const cDir = isPending ? path.join(cfg.paths.pending, 'ca') : cfg.paths.ca;
                    await queue.spawn('magick', [bgTmp + '[0]', '-resize', '1920x1920>', path.join(cDir, `${itemid}.webp`)]);
                } catch (bgErr) {
                    console.warn(`[UPLOAD] Beatmap background failed for item ${itemid}:`, bgErr.message);
                }
                await fs.unlink(bgTmp).catch(() => {});
            }
            try {
                const src = linkedToExisting ? path.join(manualApproval ? path.join(cfg.paths.pending, 'b') : cfg.paths.b, filename) : destPath;
                const probe = await queue.spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { quiet: true, ignoreExitCode: true });
                const durationMs = Math.round((parseFloat(probe.stdout) || 0) * 1000);
                const r = await saveDiffs({ itemId: itemid, userId: req.session.id, diffs: beatmapSet.diffs, durationMs });
                console.log(`[UPLOAD] Beatmap set: ${r.ids.length} maps for item ${itemid}` + (r.skipped.length ? `, skipped ${r.skipped.map(d => d.version + ': ' + d.reason).join('; ')}` : ''));
            } catch (mapErr) {
                console.error(`[UPLOAD] Beatmap maps failed for item ${itemid}:`, mapErr);
            }
        }

        try {
            if (!thumbProcessed) {
            await queue.genThumbnail(filename, actualMime, itemid, '', isPending, dynThumbSize);
            }
            
            if (actualMime.startsWith('audio/') && queue._lastCoverExtracted) {
                await db`UPDATE items SET has_coverart = TRUE WHERE id = ${itemid}`;
            }
        } catch (err) {
            console.warn(`[UPLOAD WARNING] genThumbnail failed for item ${itemid} (falling back to placeholder):`, err.message);
            // Fallback to placeholder for thumbnail ONLY if it hasn't been processed yet
            if (!thumbProcessed) {
                const tPath = !isPending
                    ? path.join(cfg.paths.t, itemid + '.webp')
                    : path.join(cfg.paths.pending, 't', itemid + '.webp');
                await queue.spawn('magick', ['-size', `${dynThumbSize}x${dynThumbSize}`, 'xc:#1a1a1a', tPath]).catch(() => {});
            }
        }

        // Generate blurred thumbnail for all posts (SFW, NSFW, NSFL, Untagged)
        await queue.genBlurredThumbnail(itemid, isPending);

        // Insert optional first comment
        if (comment && comment.length > 0) {
            try {
                const filteredComment = await applyWordFilter(comment);
                await db`
                    INSERT INTO comments ${db({
                        item_id: itemid,
                        user_id: req.session.id,
                        content: filteredComment
                    })}
                `;
            } catch (err) {
                console.error('[UPLOAD HANDLER] Failed to insert comment:', err);
            }
        }

        // Tags — rating tag only assigned if a rating was selected
        if (effectiveRating) {
            const ratingTagId = effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3));
            await db`
              insert into tags_assign ${db({ item_id: itemid, tag_id: ratingTagId, user_id: req.session.id })}
            `;
            if (is_album) {
                await db`
                    INSERT INTO album_items_tags_assign (album_item_id, tag_id, user_id)
                    SELECT id, ${ratingTagId}, ${req.session.id}
                    FROM album_items
                    WHERE item_id = ${itemid}
                    ON CONFLICT DO NOTHING
                `.catch(() => {});
            }
        }

        for (const tagName of tags) {
            let tagRow = await db`
            select id from tags where normalized = slugify(${tagName}) limit 1
          `;

            let tagId;
            if (tagRow.length === 0) {
                await db`
              insert into tags ${db({ tag: tagName }, 'tag')}
            `;
                tagRow = await db`
              select id from tags where normalized = slugify(${tagName}) limit 1
            `;
            }
            tagId = tagRow[0].id;

            await db`
            insert into tags_assign ${db({ item_id: itemid, tag_id: tagId, user_id: req.session.id })}
            on conflict do nothing
          `;
        }

        // Assign OC tags if the uploader ticked the OC checkbox
        if (is_oc) {
            const ocTags = ['oc', 'original content'];
            for (const tagname of ocTags) {
                const normalized = tagname.replace(/\s+/g, '-').toLowerCase();
                let tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagname}) LIMIT 1`;
                if (tagRow.length === 0) {
                    await db`INSERT INTO tags ${db({ tag: tagname }, 'tag')}`;
                    tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagname}) LIMIT 1`;
                }
                await db`
                    INSERT INTO tags_assign ${db({ item_id: itemid, tag_id: tagRow[0].id, user_id: req.session.id })}
                    ON CONFLICT DO NOTHING
                `;
            }
        }

        // Auto-tag SWF uploads with "Flash" and "SWF"
        if (actualMime === 'application/x-shockwave-flash' || actualMime === 'application/vnd.adobe.flash.movie') {
            const swfTags = ['Flash', 'SWF'];
            for (const tagname of swfTags) {
                let tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagname}) LIMIT 1`;
                if (tagRow.length === 0) {
                    await db`INSERT INTO tags ${db({ tag: tagname }, 'tag')}`;
                    tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagname}) LIMIT 1`;
                }
                await db`
                    INSERT INTO tags_assign ${db({ item_id: itemid, tag_id: tagRow[0].id, user_id: req.session.id })}
                    ON CONFLICT DO NOTHING
                `;
            }
        }


        // Action if auto-approved
        if (!manualApproval) {
            // Bust the count cache so page totals update immediately
            f0cklib.clearCountCache();
            if (!linkedToExisting) {
                // Move logic: Handles both real files and symlinks (reposts) correctly
                const moveSafe = async (src, dst) => {
                    try {
                        const lstat = await fs.lstat(src);
                        if (lstat.isSymbolicLink()) {
                            const target = await fs.readlink(src);
                            const absTarget = path.resolve(path.dirname(src), target);
                            const relTarget = path.relative(path.dirname(dst), absTarget);
                            await fs.symlink(relTarget, dst);
                            await fs.unlink(src).catch(() => {});
                        } else {
                            await fs.copyFile(src, dst);
                            await fs.unlink(src).catch(() => {});
                        }
                    } catch (e) {
                        console.error(`[UPLOAD MOVE ERROR] Failed to move ${src} to ${dst}:`, e.message);
                    }
                };

                const itemDest = path.join(cfg.paths.b, filename);
                const thumbDest = path.join(cfg.paths.t, `${itemid}.webp`);
                const blurDest = path.join(cfg.paths.t, `${itemid}_blur.webp`);
                const coverDest = path.join(cfg.paths.ca, `${itemid}.webp`);

                await moveSafe(destPath, itemDest);
                await moveSafe(path.join(cfg.paths.pending, 't', `${itemid}.webp`), thumbDest);

                if (actualMime.startsWith('audio')) {
                    await moveSafe(path.join(cfg.paths.pending, 'ca', `${itemid}.webp`), coverDest);
                }
                await moveSafe(path.join(cfg.paths.pending, 't', `${itemid}_blur.webp`), blurDest);
            }
        }

        // --- From here on, we process in the background to return to the user immediately ---
        const backgroundProcess = async () => {
          try {
            // Thumbnail & Coverart is now primarily handled synchronously 
            // for immediate visual feedback in some cases, but we keep this as safety 
            // EXCEPT for custom thumbnails which are already processed.
            const isPending = manualApproval;
            try {
                if (!thumbProcessed) {
                    await queue.genThumbnail(filename, actualMime, itemid, '', isPending, 512);
                }
                
                if (actualMime.startsWith('audio/') && queue._lastCoverExtracted) {
                    await db`UPDATE items SET has_coverart = TRUE WHERE id = ${itemid}`;
                }
            } catch (err) {
                console.error(`[BACKGROUND ERROR] genThumbnail failed for item ${itemid}:`, err);
            }

            // Ensure blurred thumbnail exists and is freshly generated
            await queue.genBlurredThumbnail(itemid, isPending).catch(err => console.error(`[BACKGROUND ERROR] genBlurredThumbnail failed:`, err));

            // Note: video title metadata is surfaced to the user as a suggestion in the upload form.
            // Auto-tagging from embedded metadata was removed — the user must select suggestions explicitly.


            // Discord Webhook (only for public uploads)
            if (targetVisibility === 0) {
                try {
                    const discordClient = cfg.clients.find(c => c.type === 'discord');
                    if (discordClient && discordClient.webhook_url) {
                        const message = `${req.session.user} uploaded a new ${actualMime.split('/')[0]}: ${cfg.main.url.full}/${itemid}`;
                        const payload = JSON.stringify({ content: message });
                        const url = new URL(discordClient.webhook_url);
                        const options = {
                            hostname: url.hostname,
                            path: url.pathname + url.search,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(payload)
                            }
                        };
                        const reqDiscord = https.request(options, (resDiscord) => { });
                        reqDiscord.on('error', (err) => console.error('[UPLOAD] Discord Webhook failed:', err));
                        reqDiscord.write(payload);
                        reqDiscord.end();
                    }
                } catch (err) {
                    console.error(`[BACKGROUND ERROR] Discord notification failed:`, err);
                }
            }

            // Broadcast new_item event for live grid updates (only if auto-approved)
            if (!manualApproval) {
                try {
                    await db`SELECT pg_notify('new_item', ${JSON.stringify({
                        id: itemid,
                        dest: filename,
                        mime: actualMime,
                        username: req.session.user,
                        display_name: req.session.display_name || null,
                        tag_id: effectiveRating ? (effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3))) : 0,
                        is_oc: !!is_oc,
                        slug: itemSlug,
                        visibility: targetVisibility,
                        is_album: !!is_album,
                        album_count: is_album ? totalAlbumItems : 0
                    })})`;
                } catch (err) {
                    console.error('[UPLOAD] new_item notify failed:', err);
                }
            }

            // Push to Matrix Channel (only if auto-approved and public)
            if (!manualApproval && targetVisibility === 0) {
                try {
                    const matrixCfg = cfg.clients.find(c => c.type === 'matrix');
                    if (matrixCfg?.notification_channel_id && self?.bot?.clients) {
                        const clients = await Promise.all(self.bot.clients);
                        const matrixWrapper = clients.find(c => c.type === 'matrix');
                        if (matrixWrapper?.client) {
                            const message = `${req.session.user} uploaded a new item ${cfg.main.url.full}/${itemid}`;
                            await matrixWrapper.client.send(matrixCfg.notification_channel_id, message);
                            console.log(`[UPLOAD] Matrix notification sent for item ${itemid}`);
                        }
                    }
                } catch (err) {
                    console.error('[UPLOAD] Matrix notification error:', err);
                }
            }

            // Staff Notifications
            if (manualApproval) {
                try {
                    const staff = await db`select id, login from "user" where admin = true or is_moderator = true`;
                    const notifications = staff.map(user => ({
                        user_id: user.id,
                        type: 'admin_pending',
                        reference_id: 0,
                        item_id: itemid
                    }));

                    if (notifications.length > 0) {
                        await db`INSERT INTO notifications ${db(notifications)} ON CONFLICT DO NOTHING`;
                    }
                } catch (err) {
                    console.error('[UPLOAD HANDLER] Failed to notify staff:', err);
                }
            }
            
          } catch (globalErr) {
            console.error(`[CRITICAL BACKGROUND ERROR] Item ${itemid}:`, globalErr);
          }
        };

        // Start background processing without awaiting
        backgroundProcess();

        const successMsg = manualApproval 
            ? 'Upload successful! Your upload is pending admin approval.'
            : 'Upload successful! Your upload is now live.';

        const imagesPath = cfg.websrv.paths?.images || '/b';
        const itemRoute = itemSlug ? `/${itemSlug}` : `/${itemid}`;
        return sendJson(res, {
            success: true,
            msg: successMsg,
            itemid: itemid,
            slug: itemSlug,
            visibility: targetVisibility,
            manual_approval: manualApproval,
            redirect: !manualApproval ? itemRoute : null,
            // Pending uploads aren't public yet: point clients at the uploader's status page instead of the homepage
            url: !manualApproval ? `${cfg.main.url.full}${itemRoute}` : `${cfg.main.url.full}/pending#i${itemid}`,
            status: manualApproval ? 'pending' : 'live',
            status_url: `${cfg.main.url.full}/pending#i${itemid}`,
            status_api: `${cfg.main.url.full}/api/v2/uploads/${itemid}/status`,
            file_url: !manualApproval ? `${cfg.main.url.full}${imagesPath}/${filename}` : null,
            // Fields for immediate client-side grid injection (avoids SSE race condition)
            dest: filename,
            mime: actualMime,
            tag_id: effectiveRating ? (effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3))) : 0,
            is_oc: !!is_oc,
            is_album: !!is_album,
            album_count: is_album ? totalAlbumItems : 0,
            display_name: req.session.display_name || null,
            username: req.session.user
        });

    } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') {
            const isBoosted = req.session?.admin || req.session?.is_moderator;
            console.error(`[UPLOAD HANDLER ERROR] [BODY_TOO_LARGE] User: ${req.session?.user || 'unknown'}. Limit: ${lib.formatSize(cfg.main.maxfilesize * (isBoosted ? cfg.main.adminmultiplier : 1))}`);
            return sendJson(res, { success: false, msg: 'File too large' }, 413);
        }
        console.error('[UPLOAD HANDLER ERROR]', err);
        return sendJson(res, { success: false, msg: lib.logError(err, 'Upload failed') }, 500);
    }
};
