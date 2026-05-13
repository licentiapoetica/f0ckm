import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import cfg from "./inc/config.mjs";
import queue from "./inc/queue.mjs";
import path from "path";
import https from "https";
import { getManualApproval, getMinTags, getTrustedUploads, getBypassDuplicateCheck, getEnablePdf } from "./inc/settings.mjs";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";

// Helper for JSON response
const sendJson = (res, data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

// One-time migration: add original_filename column if it doesn't exist
db`ALTER TABLE items ADD COLUMN IF NOT EXISTS original_filename text`.catch(() => {});

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

    if (!req.session) {
        return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
    }

    // CSRF validation — must happen after session lookup since flummpress middlewares run in parallel.
    const csrfToken = req.headers['x-csrf-token'];
    if (!req.session.csrf_token || !csrfToken || csrfToken !== req.session.csrf_token) {
        return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
    }

    try {
        const contentType = req.headers['content-type'] || '';
        
        // Robust boundary extraction (handles both quoted and unquoted boundaries)
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);

        if (!contentType || !contentType.includes('multipart/form-data') || !boundaryMatch) {
            return sendJson(res, { success: false, msg: 'Invalid content type' }, 400);
        }
        
        const boundary = boundaryMatch[1] || boundaryMatch[2];

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

        const parts = parseMultipart(body, boundary);

        // Validate required fields
        const file = parts.file;
        const rating = parts.rating;
        const tagsRaw = parts.tags;
        const comment = parts.comment ? parts.comment.trim() : '';

        const is_oc = (parts.is_oc === 'true' || parts.is_oc === '1');

        const is_shitpost = (parts.is_shitpost === 'true' || parts.is_shitpost === '1');

        if (!file || !file.data) {
            return sendJson(res, { success: false, msg: 'No file provided' }, 400);
        }

        // In shitpost mode, rating is optional — null means no rating tag is assigned (truly untagged)
        const effectiveRating = (rating && ['sfw', 'nsfw', 'nsfl'].includes(rating)) ? rating : (is_shitpost ? null : null);

        if (!is_shitpost && !effectiveRating) {
            return sendJson(res, { success: false, msg: 'Rating (sfw/nsfw/nsfl) is required' }, 400);
        }

        if (effectiveRating === 'nsfl' && !cfg.enable_nsfl) {
            return sendJson(res, { success: false, msg: 'NSFL mode is currently disabled' }, 400);
        }

        const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0 && !['sfw', 'nsfw', 'nsfl'].includes(t.toLowerCase())) : [];
        const minTags = getMinTags();
        // In shitpost mode, tags are optional — items without tags enter as untagged
        if (!is_shitpost && tags.length < minTags) {
            return sendJson(res, { success: false, msg: `At least ${minTags} tags are required` }, 400);
        }

        // Validate MIME type
        const allowedMimes = Object.keys(cfg.mimes);
        let mime = file.contentType;

        if (!allowedMimes.includes(mime)) {
            return sendJson(res, { success: false, msg: `Invalid file type: ${mime}` }, 400);
        }

        // Size was already validated by collectBody (effectiveMaxBytes)
        const size = file.data.length;

        let manualApproval = getManualApproval();

        // Enforce manual approval for untrusted users (configurable threshold)
        // Admins and moderators are exempt from this check
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
                    console.log(`[UPLOAD] Forcing manual approval for new user: ${req.session.user} (Upload count: ${totalUploads[0].count}/${trustedThreshold})`);
                    manualApproval = true;
                }
            } catch (err) {
                console.error('[UPLOAD] Failed to check total upload count:', err);
                // Default to manual approval on error for safety if we are unsure
                manualApproval = true; 
            }
        }

        // Rate Limit Check (if manual approval is disabled)
        // Admins and moderators are exempt from rate limiting
        if (!manualApproval && !req.session.admin && !req.session.is_moderator) {
            const twelveHoursAgo = ~~(Date.now() / 1000) - (12 * 3600);
            const uploadCount = await db`
                SELECT count(*) as count 
                FROM items 
                WHERE username = ${req.session.user} 
                AND stamp > ${twelveHoursAgo} 
                AND is_deleted = false
            `;
            if (parseInt(uploadCount[0].count) >= 69) {
                return sendJson(res, {
                    success: false,
                    msg: 'Rate limit exceeded. You can only upload 69 files every 12 hours.'
                }, 429);
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

        // Save temporarily to detect actual MIME
        await fs.writeFile(tmpPath, file.data);

        // Verify MIME
        let actualMime = (await queue.spawn('file', ['--mime-type', '-b', tmpPath])).stdout.trim();
        if (!allowedMimes.includes(actualMime)) {
            await fs.unlink(tmpPath).catch(() => { });
            return sendJson(res, { success: false, msg: `Invalid file type detected: ${actualMime}` }, 400);
        }

        if (actualMime === 'application/pdf' && !getEnablePdf()) {
            await fs.unlink(tmpPath).catch(() => { });
            return sendJson(res, { success: false, msg: 'PDF uploads are currently disabled.' }, 403);
        }

        // Reclassify audio-only MP4 containers (e.g. .m4a files detected as video/mp4)
        if (actualMime === 'video/mp4' || actualMime === 'video/quicktime') {
            const origExt = file.filename.split('.').pop().toLowerCase();
            if (['m4a', 'aac'].includes(origExt)) {
                actualMime = 'audio/mp4';
                console.log(`[UPLOAD] Reclassified ${origExt} from video/mp4 to audio/mp4`);
            } else {
                // Check with ffprobe if it has video streams
                try {
                    const probeResult = await queue.spawn('ffprobe', [
                        '-v', 'error', '-select_streams', 'v:0',
                        '-show_entries', 'stream=codec_type',
                        '-of', 'csv=p=0', tmpPath
                    ]);
                    if (!probeResult.stdout.trim()) {
                        actualMime = 'audio/mp4';
                        console.log(`[UPLOAD] Reclassified audio-only MP4 to audio/mp4`);
                    }
                } catch (err) {
                    // ffprobe not available or failed, keep original MIME
                }
            }
        }

        const ext = cfg.mimes[actualMime] || 'bin';
        const filename = `${uuid}.${ext}`;
        const destPath = path.join(cfg.paths.pending, 'b', filename);

        // Constants
        const checksum = (await queue.spawn('sha256sum', [tmpPath])).stdout.trim().split(" ")[0];

        // Check repost
        if (!getBypassDuplicateCheck()) {
            const repost = await queue.checkrepostsum(checksum);
            if (repost) {
                await fs.unlink(tmpPath).catch(() => { });
                return sendJson(res, {
                    success: false,
                    msg: `This file already exists`,
                    repost: repost
                }, 409);
            }
        }

        // PHash check
        let phash = null;
        try {
            phash = await queue.generatePHash(tmpPath);
            if (phash && !getBypassDuplicateCheck()) {
                const phashMatch = await queue.checkrepostphash(phash);
                if (phashMatch) {
                    await fs.unlink(tmpPath).catch(() => { });
                    return sendJson(res, {
                        success: false,
                        msg: `This file is a visual duplicate`,
                        repost: phashMatch
                    }, 409);
                }
            }
        } catch (e) {
            console.error('[UPLOAD] PHash error:', e);
        }

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
        const originalFilename = file.filename || null;
        await db`
          insert into items ${db({
            src: '',
            dest: filename,
            mime: actualMime,
            size: size,
            checksum: insertChecksum,
            phash: phash,
            username: req.session.user,
            userchannel: 'web',
            usernetwork: 'web',
            stamp: ~~(Date.now() / 1000),
            active: !manualApproval,
            is_oc: is_oc,
            original_filename: originalFilename
        }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active', 'is_oc', 'original_filename')
            }
        `;

        const itemid = await queue.getItemID(filename);

        // Automatically subscribe uploader to comment thread
        try {
            await db`
                INSERT INTO comment_subscriptions (user_id, item_id)
                VALUES (${req.session.id}, ${itemid})
                ON CONFLICT DO NOTHING
            `;
        } catch (err) {
            console.error('[UPLOAD HANDLER] Failed to auto-subscribe uploader:', err);
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

        // Generate blurred thumbnail for NSFW/NSFL
        if (effectiveRating === 'nsfw' || effectiveRating === 'nsfl') {
            await queue.genBlurredThumbnail(itemid, isPending);
        }

        // Insert optional first comment
        if (comment && comment.length > 0 && comment.length <= 2000) {
            try {
                await db`
                    INSERT INTO comments ${db({
                        item_id: itemid,
                        user_id: req.session.id,
                        content: comment
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
        if (mime === 'application/x-shockwave-flash' || mime === 'application/vnd.adobe.flash.movie') {
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
                if (effectiveRating === 'nsfw' || effectiveRating === 'nsfl') {
                    await moveSafe(path.join(cfg.paths.pending, 't', `${itemid}_blur.webp`), blurDest);
                }
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
                // If it's Flash, we might have already processed a custom thumbnail.
                // We'll only run genThumbnail if the thumbnail doesn't exist yet.
                const tDir = isPending ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
                const thumbPath = path.join(tDir, `${itemid}.webp`);
                const thumbExists = await fs.access(thumbPath).then(() => true).catch(() => false);

                if (!thumbExists) {
                    await queue.genThumbnail(filename, actualMime, itemid, '', isPending, 512);
                }
                
                if (actualMime.startsWith('audio/') && queue._lastCoverExtracted) {
                    await db`UPDATE items SET has_coverart = TRUE WHERE id = ${itemid}`;
                }
            } catch (err) {
                console.error(`[BACKGROUND ERROR] genThumbnail failed for item ${itemid}:`, err);
            }

            // Ensure blurred thumbnail exists if needed
            if (effectiveRating === 'nsfw' || effectiveRating === 'nsfl') {
                const tDir = isPending ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
                const blurPath = path.join(tDir, `${itemid}_blur.webp`);
                const blurExists = await fs.access(blurPath).then(() => true).catch(() => false);
                if (!blurExists) {
                    await queue.genBlurredThumbnail(itemid, isPending).catch(err => console.error(`[BACKGROUND ERROR] genBlurredThumbnail failed:`, err));
                }
            }

            // Note: video title metadata is surfaced to the user as a suggestion in the upload form.
            // Auto-tagging from embedded metadata was removed — the user must select suggestions explicitly.


            // Discord Webhook
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
                        is_oc: !!is_oc
                    })})`;
                } catch (err) {
                    console.error('[UPLOAD] new_item notify failed:', err);
                }
            }

            // Push to Matrix Channel
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

        return sendJson(res, {
            success: true,
            msg: successMsg,
            itemid: itemid,
            manual_approval: manualApproval,
            redirect: !manualApproval ? `/${itemid}` : null
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
