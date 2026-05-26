import db from "../sql.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import cfg from "../config.mjs";
import lib from "../lib.mjs";
import audit from "../audit.mjs";
import { promises as fs } from "fs";
import { applyWordFilter } from "../wordfilter.mjs";
import path from "path";

export default (router, tpl) => {



    // Get comments for an item
    router.get(/\/api\/comments\/(?<itemid>\d+)/, async (req, res) => {
        const itemId = req.params.itemid;
        const sort = req.url.qs?.sort || 'new'; // 'new' or 'old'

        // Require login unless comments are public
        if (!req.session && cfg.main.hide_comments_from_public) {
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    success: true,
                    comments: [],
                    require_login: true,
                    user_id: null,
                    is_admin: false
                })
            });
        }

        try {
            // Check locked status
            const item = await db`SELECT is_comments_locked FROM items WHERE id = ${itemId}`;
            const is_locked = item.length > 0 ? item[0].is_comments_locked : false;

            const comments = await f0cklib.getComments(itemId, sort, false);

            let is_subscribed = false;
            if (req.session) {
                const sub = await db`SELECT 1 FROM comment_subscriptions WHERE user_id = ${req.session.id} AND item_id = ${itemId} AND is_subscribed = true`;
                if (sub.length > 0) is_subscribed = true;
            }

            // Transform for frontend if needed, or send as is
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    success: true,
                    comments,
                    is_subscribed,
                    is_locked,
                    user_id: req.session ? req.session.user : null,
                    is_admin: req.session ? (req.session.admin || req.session.is_moderator) : false
                })
            })
        } catch (err) {
            console.error(err);
            return res.reply({
                code: 500,
                body: JSON.stringify({ success: false, message: "Database error" })
            });
        }
    });

    // Get a single comment by ID
    router.get(/\/api\/comment\/(?<id>\d+)/, async (req, res) => {
        const id = req.params.id;

        // Require login unless comments are public
        if (!req.session && cfg.main.hide_comments_from_public) {
            return res.reply({
                code: 401,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: false, message: "Unauthorized" })
            });
        }

        try {
            const comment = await f0cklib.getComment(id);
            if (!comment) {
                return res.reply({
                    code: 404,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({ success: false, message: "Comment not found" })
                });
            }

            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true, comment })
            });
        } catch (err) {
            console.error(err);
            return res.reply({
                code: 500,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: false, message: "Database error" })
            });
        }
    });

    // Browse User Comments
    router.get(/\/user\/(?<user>[^\/]+)\/comments/, async (req, res) => {
        const user = decodeURIComponent(req.params.user);

        try {
            // Check if user exists and get ID + avatar
            const u = await db`
                SELECT "user".id, "user".user, user_options.avatar, user_options.avatar_file, user_options.username_color
                FROM "user" 
                LEFT JOIN user_options ON "user".id = user_options.user_id 
                WHERE "user".user ILIKE ${user}
            `;
            if (!u.length) {
                return res.reply({ code: 404, body: "User not found" });
            }
            const userId = u[0].id;
            const sort = req.url.qs?.sort || 'new';
            const page = +(req.url.qs?.page || 1);
            const limit = 20;
            const offset = (page - 1) * limit;
            const isJson = req.url.qs?.json === 'true';

            if (!req.session || !req.session.user) {
                if (cfg.main.hide_comments_from_public) {
                    if (isJson) {
                        return res.reply({
                            headers: { 'Content-Type': 'application/json; charset=utf-8' },
                            body: JSON.stringify({ success: false, require_login: true })
                        });
                    } else {
                        return res.redirect('/login');
                    }
                }
            }


            const globalfilter = cfg.nsfp.map(n => `tag_id = ${n}`).join(' or ');
            const excludedTags = req.session ? (req.session.excluded_tags || []) : [];
            /* <mode-override> */
            // prioritize query mode (from AJAX) over session default
            let mode = req.mode;
            if (req.url.qs && req.url.qs.mode && (req.url.qs.mode === '0' || req.url.qs.mode === '1' || req.url.qs.mode === '2' || req.url.qs.mode === '3')) {
                mode = parseInt(req.url.qs.mode);
            }
            /* </mode-override> */

            // Multi-rating cookie support (same logic as other routes)
            const ratingsRaw = req.cookies.ratings;
            const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;
            const multiRatingSQL = (ratingsArr && ratingsArr.length > 0) ? lib.getMultiRatingMode(ratingsArr) : null;

            // Build mode SQL — replace items.id alias with i.id used in the activity query
            const modequery = (multiRatingSQL ?? lib.getMode(mode)).replace(/items\.id/g, 'i.id');

            const comments = await db`
                SELECT c.*, i.mime, i.id as item_id
                FROM comments c
                LEFT JOIN items i ON c.item_id = i.id
                WHERE c.user_id = ${userId} AND c.is_deleted = false
                AND i.active = true AND i.is_deleted = false
                AND ${db.unsafe(modequery)}
                ${!req.session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = i.id and (${db.unsafe(globalfilter)}))` : db``}
                ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = i.id and tag_id = any(${excludedTags}::int[]))` : db``}
                ORDER BY c.created_at DESC
                LIMIT ${limit} OFFSET ${offset}
            `;

            // Process mentions for user comments page too
            // Note: Since we need to modify 'comments', we do it before any map/HTML escaping
            // However, f0cklib.processMentions returns a new array with modified content.
            // But we actually need to do this BEFORE the existing 'processedComments' map which does HTML escaping.
            // Wait, f0cklib.processMentions adds Markdown links: [@user](/user/user).
            // HTML escaping later will break this: [&quot;@user...
            // So we need to ensure formatting happens appropriately.

            // Actually, let's use processMentions here.
            // But notice below 'processedComments' logic manually escapes HTML and handles emojis.
            // If we add Markdown links now, 'escapeHtml' will destroy them.
            // We should probably rely on marked.js on the client side? 
            // The client 'user_comments.js' uses marked.js!
            // So if we inject Markdown links, they will be rendered as links by marked.js.
            // BUT 'processedComments' escapes HTML.
            // Ideally, we should let marked handle everything or be careful.

            // Let's modify comments content in-place (or new array) before mapping
            const mentionsProcessed = await f0cklib.processMentions(comments);
            const processedComments = mentionsProcessed.map(c => {
                return {
                    ...c,
                    content: c.content
                };
            });

            if (isJson) {
                return res.reply({
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({ success: true, comments: processedComments, user: u[0] })
                });
            }

            const data = {
                user: u[0],
                comments: processedComments,
                hidePagination: true,
                tmp: null // for header/footer
            };

            if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
                return res.reply({ body: tpl.render('comments_user-partial', data, req) });
            }

            return res.reply({ body: tpl.render('comments_user', data, req) });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: "Error" });
        }
    });

    // In-memory rate limiter for comment posting.
    // Tracks timestamps of recent posts per user_id in a sliding window.
    // Map: userId -> number[] (unix ms timestamps)
    const commentRateLimiter = new Map();
    const COMMENT_RATE_LIMIT = 25;      // max comments
    const COMMENT_RATE_WINDOW = 60_000; // per 60 seconds

    const isCommentRateLimited = (userId) => {
        const now = Date.now();
        const windowStart = now - COMMENT_RATE_WINDOW;
        const timestamps = (commentRateLimiter.get(userId) || []).filter(t => t > windowStart);
        if (timestamps.length >= COMMENT_RATE_LIMIT) return true;
        timestamps.push(now);
        commentRateLimiter.set(userId, timestamps);
        // Prune entries for users inactive for > 5 minutes to avoid unbounded growth
        if (commentRateLimiter.size > 5000) {
            const pruneWindow = now - 300_000;
            for (const [uid, ts] of commentRateLimiter) {
                if (!ts.some(t => t > pruneWindow)) commentRateLimiter.delete(uid);
            }
        }
        return false;
    };

    // Post a comment
    router.post('/api/comments', async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false, message: "Unauthorized" }) });

        // Rate limit regular users (admins and mods are exempt)
        if (!req.session.admin && !req.session.is_moderator) {
            if (isCommentRateLimited(req.session.id)) {
                return res.reply({ code: 429, body: JSON.stringify({ success: false, message: "You're posting too fast. Please slow down." }) });
            }
        }

        if (cfg.main.development) console.log("DEBUG: POST /api/comments");

        // Use standard framework parsing
        const body = req.post || {};
        const item_id = parseInt(body.item_id, 10);
        const parent_id = body.parent_id ? parseInt(body.parent_id, 10) : null;
        let content = body.content || '';
        content = await applyWordFilter(content);
        const video_time = (body.video_time !== undefined && body.video_time !== '' && !isNaN(parseFloat(body.video_time)))
            ? parseFloat(body.video_time)
            : null;

        if (cfg.main.development) console.log("DEBUG: Posting comment:", { item_id, parent_id, content: content?.substring(0, 20) });

        const fileIdsRaw = body.file_ids || '';
        const fileIds = fileIdsRaw ? fileIdsRaw.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0) : [];

        if ((!content || !content.trim()) && fileIds.length === 0) {
            return res.reply({ body: JSON.stringify({ success: false, message: "Empty comment" }) });
        }

        const maxLen = cfg.main.comment_max_length;
        if (maxLen !== null && maxLen !== undefined && content.length > maxLen) {
            return res.reply({ code: 400, body: JSON.stringify({ success: false, message: `Comment too long (max ${maxLen} characters)` }) });
        }

        try {
            // Check if thread is locked (admins and mods can still post)
            if (!req.session.admin && !req.session.is_moderator) {
                const lockCheck = await db`SELECT COALESCE(is_comments_locked, false) as is_locked FROM items WHERE id = ${item_id}`;
                if (lockCheck.length > 0 && lockCheck[0].is_locked) {
                    return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "This thread is locked" }) });
                }
            }

            const insertData = {
                item_id,
                user_id: req.session.id,
                parent_id: parent_id || null,
                content: content || ''
            };
            if (video_time !== null) insertData.video_time = video_time;

            const newComment = await db`
                INSERT INTO comments ${db(insertData)}
                RETURNING id, created_at, video_time
            `;

            const commentId = parseInt(newComment[0].id, 10);

            // Link uploaded files to this comment (if any)
            let activityFiles = [];
            const fileIdsRaw = body.file_ids || '';
            if (fileIdsRaw) {
                const fileIds = fileIdsRaw.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
                if (fileIds.length > 0) {
                    try {
                        // Only link files that belong to this user and aren't already linked
                        await db`
                            UPDATE comment_files
                            SET comment_id = ${commentId}
                            WHERE id = ANY(${fileIds}::int[])
                            AND user_id = ${req.session.id}
                            AND comment_id IS NULL
                        `;
                        // Fetch the linked files to send with live notification and post response
                        activityFiles = await db`
                            SELECT id, comment_id, dest, mime, size, original_filename
                            FROM comment_files
                            WHERE comment_id = ${commentId}
                            ORDER BY id ASC
                        `;
                    } catch (err) {
                        console.error('[COMMENTS] Failed to link files to comment:', err);
                    }
                }
            }

            // Notify Subscribers (excluding the author)
            // 1. Get subscribers (active only)
            const subscribers = await db`SELECT user_id FROM comment_subscriptions WHERE item_id = ${item_id} AND is_subscribed = true`;

            // Mentions Logic: Parse content for @username and [@User Name] (space-containing names).
            // Strip spoiler wrappers first so mentions inside [spoiler]...[/spoiler] are visible.
            const strippedContent = content.replace(/\[spoiler\]/gi, '').replace(/\[\/spoiler\]/gi, '');
            const mentionRegex = /(?<!\[)@([a-zA-Z0-9_\-\.]+)|\[@([^\]]+)\]/g;
            const matches = [...strippedContent.matchAll(mentionRegex)];
            const mentionedNames = [...new Set(matches.map(m => (m[1] || m[2]).trim()))];
            const lowerNames = mentionedNames.map(n => n.toLowerCase());

            let mentionedUsers = [];
            if (lowerNames.length > 0) {
                // Fetch IDs via login column (lowercase)
                mentionedUsers = await db`SELECT id, user FROM "user" WHERE login IN ${db(lowerNames)}`;
            }

            // 2. Get parent author
            let parentAuthor = [];
            if (parent_id) {
                parentAuthor = await db`SELECT user_id FROM comments WHERE id = ${parent_id}`;
            }

            // 3. Prepare notifications with priority: Mention > Reply > Subscription
            // Use a Map to ensure one notification per user
            const notificationsMap = new Map(); // UserId -> { type, ... }

            // A. Mentions
            mentionedUsers.forEach(u => {
                if (u.id !== req.session.id) {
                    notificationsMap.set(u.id, 'mention');
                }
            });

            // B. Reply (Parent Author)
            if (parentAuthor.length > 0) {
                const pid = parentAuthor[0].user_id;
                // Only if not already mentioned
                if (pid !== req.session.id && !notificationsMap.has(pid)) {
                    notificationsMap.set(pid, 'comment_reply');
                }
            }

            // C. Subscribers
            const parentUserId = parentAuthor.length > 0 ? parentAuthor[0].user_id : -1;

            // Get uploader ID to distinguish notification type
            const itemInfo = await db`
                SELECT u.id as uploader_id 
                FROM items i 
                JOIN "user" u ON (i.username ILIKE u.login OR i.username ILIKE u.user)
                WHERE i.id = ${item_id}
                LIMIT 1
            `;
            const uploaderId = itemInfo.length > 0 ? itemInfo[0].uploader_id : null;

            subscribers.forEach(s => {
                // If not self, and not already notified (as mention or reply)
                if (s.user_id !== req.session.id && !notificationsMap.has(s.user_id)) {
                    // Use specialized type for uploader
                    const type = (uploaderId && s.user_id === uploaderId) ? 'upload_comment' : 'subscription';
                    notificationsMap.set(s.user_id, type);
                }
            });

            // 4. Batch insert non-bundleable, handle bundleable separately
            const bundleable = [];
            const nonBundleable = [];

            for (const [uid, type] of notificationsMap.entries()) {
                const notif = {
                    user_id: uid,
                    type: type,
                    item_id: item_id,
                    reference_id: commentId
                };
                if (type === 'upload_comment') {
                    bundleable.push(notif);
                } else {
                    nonBundleable.push(notif);
                }
            }

            if (nonBundleable.length > 0) {
                await db`INSERT INTO notifications ${db(nonBundleable)}`;
            }

            for (const n of bundleable) {
                // Try to update existing unread notification for this item/user/type
                const updated = await db`
                    UPDATE notifications 
                    SET created_at = NOW(), reference_id = ${n.reference_id}
                    WHERE user_id = ${n.user_id} 
                      AND item_id = ${n.item_id} 
                      AND type = 'upload_comment' 
                      AND is_read = false
                    RETURNING id
                `;

                if (updated.length === 0) {
                    await db`INSERT INTO notifications ${db(n)}`;
                }
            }

            // Notify for live updates
            // Fetch the trigger-updated xd_score and the item rating tag from the DB (trigger runs synchronously before we get here)
            const itemQuery = await db`
                SELECT 
                    i.xd_score,
                    (SELECT ta.tag_id FROM tags_assign ta
                     WHERE ta.item_id = i.id AND ta.tag_id = ANY(${[1, 2, cfg.nsfl_tag_id || 3]}::int[])
                     ORDER BY ta.tag_id LIMIT 1) AS rating_tag_id
                FROM items i WHERE i.id = ${item_id}
            `;
            const xdRow = itemQuery[0];
            const ratingTagId = itemQuery[0]?.rating_tag_id;
            let ratingLabel = '?';
            let ratingClass = 'untagged';
            if (ratingTagId == 1) { ratingLabel = 'SFW'; ratingClass = 'sfw'; }
            else if (ratingTagId == 2) { ratingLabel = 'NSFW'; ratingClass = 'nsfw'; }
            else if (ratingTagId == (cfg.nsfl_tag_id || 3)) { ratingLabel = 'NSFL'; ratingClass = 'nsfl'; }

            // Truncate body to 500 chars: PostgreSQL NOTIFY has an 8000-byte hard limit.
            // Large comments would silently drop the notification. The client fetches
            // the full content via _silentSync; the NOTIFY only needs to trigger the update.
            const notifyBody = content.length > 500 ? content.substring(0, 500) + '…' : content;
            const livePayload = {
                type: 'comment',
                id: commentId,
                item_id: item_id,
                parent_id: parent_id || null,
                body: notifyBody,
                username: req.session.user,
                user_id: req.session.id,
                avatar: req.session.avatar,
                avatar_file: req.session.avatar_file,
                created_at: new Date().toISOString(),
                username_color: req.session.username_color,
                display_name: req.session.display_name || null,
                xd_score: xdRow?.xd_score ?? null,
                video_time: newComment[0]?.video_time ?? null,
                files: activityFiles
            };

            // 1. Thread live update
            db.notify('comments', JSON.stringify(livePayload));
            
            // 2. Sidebar activity update
            db.notify('activity', JSON.stringify({
                user_id: req.session.id,
                item_id: item_id,
                type: 'comment',
                body: notifyBody,
                id: commentId,
                item_rating_class: ratingClass,
                item_rating_label: ratingLabel,
                avatar: req.session.avatar,
                avatar_file: req.session.avatar_file,
                username: req.session.user,
                username_color: req.session.username_color,
                display_name: req.session.display_name || null,
                files: activityFiles
            }));

            // Automatically subscribe user to the thread
            const subResult = await db`
                INSERT INTO comment_subscriptions (user_id, item_id)
                VALUES (${req.session.id}, ${item_id})
                ON CONFLICT (user_id, item_id) DO NOTHING
                RETURNING 1
            `;
            const is_new_subscription = subResult.length > 0;

            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ 
                    success: true, 
                    comment: {
                        ...newComment[0],
                        files: activityFiles
                    },
                    xd_score: xdRow?.xd_score ?? null,
                    is_new_subscription
                })
            });
        } catch (err) {
            console.error(err);
            return res.reply({
                code: 500,
                body: JSON.stringify({ success: false, message: "Database error" })
            });
        }
    });

    // Subscribe toggle
    router.post(/\/api\/subscribe\/(?<itemid>\d+)/, async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        const itemId = req.params.itemid;

        try {
            const existing = await db`
                 SELECT is_subscribed FROM comment_subscriptions 
                 WHERE user_id = ${req.session.id} AND item_id = ${itemId}
             `;

            let subscribed = false;
            if (existing.length > 0) {
                subscribed = !existing[0].is_subscribed;
                await db`UPDATE comment_subscriptions SET is_subscribed = ${subscribed} WHERE user_id = ${req.session.id} AND item_id = ${itemId}`;
            } else {
                await db`INSERT INTO comment_subscriptions (user_id, item_id, is_subscribed) VALUES (${req.session.id}, ${itemId}, true)`;
                subscribed = true;
            }

            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true, subscribed })
            });
        } catch (e) {
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // Delete comment
    router.post(/\/api\/comments\/(?<id>\d+)\/delete/, async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        const commentId = req.params.id;
        if (cfg.main.development) console.log(`[DEBUG] Attempting to delete comment ${commentId} by user ${req.session.id} (mod: ${req.session.is_moderator})`);

        try {
            const comment = await db`SELECT content, item_id, user_id FROM comments WHERE id = ${commentId}`;
            if (!comment.length) return res.reply({ code: 404, body: JSON.stringify({ success: false, message: "Not found" }) });

            const { getAllowCommentDeletion } = await import("../settings.mjs");
            const canDeleteOwn = getAllowCommentDeletion();
            const isOwner = comment[0].user_id === req.session.id;

            if (!req.session.admin && !req.session.is_moderator) {
                if (!canDeleteOwn || !isOwner) {
                    return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });
                }
            }

            // Log all deletions in audit log
            const reason = (req.post && req.post.reason) ? req.post.reason : (req.url.qs?.reason || 'No reason provided');
            await audit.log(req.session.id, 'delete_comment', 'comment', commentId, {
                item_id: comment[0].item_id,
                reason: reason,
                old_content: comment[0].content
            });

            // Handle attachments cleanup
            const files = await db`SELECT id, dest, checksum FROM comment_files WHERE comment_id = ${commentId}`;
            for (const f of files) {
                const otherRefs = await db`SELECT id FROM comment_files WHERE checksum = ${f.checksum} AND id != ${f.id}`;
                const textRefs = await db`SELECT id FROM comments WHERE content LIKE ${'%' + f.dest + '%'} AND id != ${commentId}`;
                
                const hasRefs = otherRefs.length > 0 || textRefs.length > 0;
                
                const filePath = path.join(cfg.paths.c, f.dest);
                const thumbPath = path.join(cfg.paths.t, `cf_${f.dest.split('.')[0]}.webp`);

                if (!hasRefs) {
                    // Safe to delete from disk (last reference)
                    await fs.unlink(filePath).catch(() => {});
                    await fs.unlink(thumbPath).catch(() => {});
                } else {
                    // There are other references. Only delete if it's a symlink AND not referenced by text!
                    try {
                        const stats = await fs.lstat(filePath);
                        if (stats.isSymbolicLink() && textRefs.length === 0) {
                            await fs.unlink(filePath).catch(() => {});
                            await fs.unlink(thumbPath).catch(() => {});
                        }
                    } catch (e) {
                        console.error(`[DELETE_COMMENT] Failed to check stats for ${f.dest}:`, e.message);
                    }
                }
                // Delete record from DB
                await db`DELETE FROM comment_files WHERE id = ${f.id}`;
            }

            await db`UPDATE comments SET is_deleted = true, content = '[deleted]' WHERE id = ${commentId}`;

            // Notify for live update
            db.notify('comments', JSON.stringify({
                type: 'delete',
                item_id: comment[0].item_id,
                comment_id: commentId
            }));

            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true })
            });
        } catch (e) {
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // Delete comment attachment (admin/mod only)
    router.post('/api/comments/attachment/delete', async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        if (!req.session.admin && !req.session.is_moderator) return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });

        const body = req.post || {};
        const filename = body.filename;

        if (!filename) {
            return res.reply({ body: JSON.stringify({ success: false, message: "Missing filename" }) });
        }

        try {
            const cleanFilename = filename.split('#')[0];
            const file = await db`SELECT id, comment_id, dest FROM comment_files WHERE dest = ${cleanFilename}`;
            if (!file.length) return res.reply({ code: 404, body: JSON.stringify({ success: false, message: "Attachment not found" }) });

            let commentId = file[0].comment_id;
            let comment;

            if (!commentId) {
                // Try to find the comment by content search if not linked
                const commentsFound = await db`SELECT id, content, item_id FROM comments WHERE content LIKE ${'%' + cleanFilename + '%'}`;
                if (commentsFound.length > 0) {
                    commentId = commentsFound[0].id;
                    comment = commentsFound;
                }
            } else {
                comment = await db`SELECT id, content, item_id FROM comments WHERE id = ${commentId}`;
            }

            if (!commentId || !comment.length) {
                // File uploaded but not linked and not found in any comment content
                await db`DELETE FROM comment_files WHERE id = ${file[0].id}`;
                const filePath = path.join(cfg.paths.c, file[0].dest);
                await fs.unlink(filePath).catch(() => {});
                return res.reply({ body: JSON.stringify({ success: true, message: "Orphaned attachment deleted" }) });
            }

            const escapedFilename = cleanFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Find ALL comments containing this filename and update them
            const commentsToUpdate = await db`SELECT id, content FROM comments WHERE content LIKE ${'%' + cleanFilename + '%'}`;
            
            let finalContent = comment[0].content;
            for (const c of commentsToUpdate) {
                const originalContent = c.content;
                const domainRegex = `(?:https?:\\/\\/[^\\/\\s]+)?`;
                const updatedContent = originalContent
                    .replace(new RegExp(`!?\\[[^\\]]*\\]\\(${domainRegex}/c/${escapedFilename}(?:#gif)?\\)`, 'g'), '[attachment removed]')
                    .replace(new RegExp(`${domainRegex}/c/${escapedFilename}(?:#gif)?`, 'g'), '[attachment removed]');
                
                if (updatedContent !== originalContent) {
                    await db`UPDATE comments SET content = ${updatedContent}, updated_at = NOW() WHERE id = ${c.id}`;
                    
                    if (c.id === commentId) {
                        finalContent = updatedContent;
                    }
                    
                    // Notify for live update for each updated comment
                    db.notify('comments', JSON.stringify({
                        type: 'edit',
                        comment_id: c.id,
                        content: updatedContent
                    }));
                }
            }

            // Delete file record
            await db`DELETE FROM comment_files WHERE id = ${file[0].id}`;

            // Delete file from disk
            const filePath = path.join(cfg.paths.c, file[0].dest);
            await fs.unlink(filePath).catch(() => {});
            
            // Also delete thumbnail if exists
            const thumbPath = path.join(cfg.paths.t, `cf_${filename.split('.')[0]}.webp`);
            await fs.unlink(thumbPath).catch(() => {});

            // Log in audit log
            await audit.log(req.session.id, 'delete_attachment', 'comment', commentId, {
                filename: filename,
                old_content: comment[0].content,
                new_content: finalContent
            });

            // Notify for live update
            db.notify('comments', JSON.stringify({
                type: 'edit',
                item_id: comment[0].item_id,
                comment_id: commentId,
                content: finalContent
            }));

            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // Edit comment (admin/mod only)
    router.post(/\/api\/comments\/(?<id>\d+)\/edit/, async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        if (!req.session.admin && !req.session.is_moderator) return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });

        const commentId = req.params.id;
        const body = req.post || {};
        let content = body.content;
        content = await applyWordFilter(content);

        if (!content || !content.trim()) {
            return res.reply({ body: JSON.stringify({ success: false, message: "Empty content" }) });
        }

        try {
            const comment = await db`SELECT id, user_id, item_id, content FROM comments WHERE id = ${commentId}`;
            if (!comment.length) return res.reply({ code: 404, body: JSON.stringify({ success: false, message: "Not found" }) });

            const oldContent = comment[0].content;

            await audit.log(req.session.id, 'edit_comment', 'comment', commentId, {
                item_id: comment[0].item_id,
                old_content: oldContent.substring(0, 2000),
                new_content: content.substring(0, 2000)
            });

            await db`UPDATE comments SET content = ${content}, updated_at = NOW() WHERE id = ${commentId}`;

            // Notify for live update
            db.notify('comments', JSON.stringify({
                type: 'edit',
                item_id: comment[0].item_id,
                comment_id: commentId,
                content: content
            }));

            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });
    // Toggle pin comment (admin/mod only)
    router.post(/\/api\/comments\/(?<id>\d+)\/pin/, async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        if (!req.session.admin && !req.session.is_moderator) return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });

        const commentId = req.params.id;

        try {
            const comment = await db`SELECT id, COALESCE(is_pinned, false) as is_pinned, item_id FROM comments WHERE id = ${commentId}`;
            if (!comment.length) return res.reply({ code: 404, body: JSON.stringify({ success: false, message: "Not found" }) });

            const newPinned = !comment[0].is_pinned;
            await db`UPDATE comments SET is_pinned = ${newPinned} WHERE id = ${commentId}`;

            await audit.log(req.session.id, 'pin_comment', 'comment', commentId, { item_id: comment[0].item_id, is_pinned: newPinned });

            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true, is_pinned: newPinned })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });
    // Toggle lock thread (admin/mod only)
    router.post(/\/api\/comments\/(?<itemid>\d+)\/lock/, async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        if (!req.session.admin && !req.session.is_moderator) return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });

        const itemId = req.params.itemid;

        try {
            const item = await db`SELECT id, COALESCE(is_comments_locked, false) as is_locked FROM items WHERE id = ${itemId}`;
            if (!item.length) return res.reply({ code: 404, body: JSON.stringify({ success: false, message: "Not found" }) });

            const newLocked = !item[0].is_locked;
            await db`UPDATE items SET is_comments_locked = ${newLocked} WHERE id = ${itemId}`;

            await audit.log(req.session.id, newLocked ? 'lock_thread' : 'unlock_thread', 'item', itemId);

            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true, is_locked: newLocked })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // Recent Activity Page
    router.get(/\/activity\/?/, async (req, res) => {
        try {
            const page = +(req.url.qs?.page || 1);
            const limit = Math.min(+(req.url.qs?.limit || 50), 50);
            // Support explicit offset (used by sidebar infinite-scroll after a non-standard initial limit)
            const offset = req.url.qs?.offset !== undefined
                ? Math.max(0, +(req.url.qs.offset))
                : (page - 1) * limit;

            /* <mode-override> */
            // prioritize query mode (from AJAX) over session default
            let mode = req.mode;
            if (req.url.qs && req.url.qs.mode && (req.url.qs.mode === '0' || req.url.qs.mode === '1' || req.url.qs.mode === '2' || req.url.qs.mode === '3')) {
                mode = parseInt(req.url.qs.mode);
            }
            /* </mode-override> */

            // Multi-rating cookie support (same logic as other routes)
            const ratingsRaw = req.cookies.ratings;
            const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;
            const multiRatingSQL = (ratingsArr && ratingsArr.length > 0) ? lib.getMultiRatingMode(ratingsArr) : null;

            // Build mode SQL — replace items.id alias with i.id used in the activity query
            const modequery = (multiRatingSQL ?? lib.getMode(mode)).replace(/items\.id/g, 'i.id');
            const globalfilter = cfg.nsfp.map(n => `tag_id = ${n}`).join(' or ');
            const excludedTags = req.session ? (req.session.excluded_tags || []) : [];

            const comments = await db`
                SELECT 
                    c.*, 
                    i.mime, 
                    i.id as item_id, 
                    i.dest as item_dest,
                    (SELECT ta.tag_id FROM tags_assign ta
                     WHERE ta.item_id = i.id AND ta.tag_id = ANY(${[1, 2, cfg.nsfl_tag_id || 3]}::int[])
                     ORDER BY ta.tag_id LIMIT 1) AS rating_tag_id,
                    u.user as username,
                    uo.avatar,
                    uo.avatar_file,
                    uo.username_color,
                    uo.display_name
                FROM comments c
                LEFT JOIN items i ON c.item_id = i.id
                LEFT JOIN "user" u ON c.user_id = u.id
                LEFT JOIN user_options uo ON u.id = uo.user_id
                WHERE c.is_deleted = false
                AND i.active = true
                AND i.is_deleted = false
                AND ${db.unsafe(modequery)}
                ${!req.session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = i.id and (${db.unsafe(globalfilter)}))` : db``}
                ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = i.id and tag_id = any(${excludedTags}::int[]))` : db``}

                ORDER BY c.created_at DESC
                LIMIT ${limit} OFFSET ${offset}
            `;

            // Fetch comment file attachments
            const filesMap = new Map();
            if (comments.length > 0) {
                const commentIds = comments.map(c => c.id);
                try {
                    const files = await db`
                        SELECT id, comment_id, dest, mime, size, original_filename
                        FROM comment_files
                        WHERE comment_id = ANY(${commentIds}::int[])
                        ORDER BY id ASC
                    `;
                    for (const f of files) {
                        if (!filesMap.has(f.comment_id)) filesMap.set(f.comment_id, []);
                        filesMap.get(f.comment_id).push(f);
                    }
                } catch (e) {
                    console.error('[ACTIVITY] Failed to fetch comment files:', e);
                }
            }

            const processedComments = comments.map(c => {
                let ratingLabel = '?';
                let ratingClass = 'untagged';
                if (c.rating_tag_id == 1) { ratingLabel = 'SFW'; ratingClass = 'sfw'; }
                else if (c.rating_tag_id == 2) { ratingLabel = 'NSFW'; ratingClass = 'nsfw'; }
                else if (c.rating_tag_id == (cfg.nsfl_tag_id || 3)) { ratingLabel = 'NSFL'; ratingClass = 'nsfl'; }

                return {
                    ...c,
                    content: (c.content || '').trim(),
                    username_color: c.username_color,
                    item_rating_class: ratingClass,
                    item_rating_label: ratingLabel,
                    files: filesMap.get(c.id) || []
                    // created_at stays as the raw ISO timestamp so the frontend f0ckTimeAgo can localize it
                };
            });

            if (req.url.qs?.json === 'true' || req.headers['x-requested-with'] === 'XMLHttpRequest') {
                return res.reply({
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0'
                    },
                    body: JSON.stringify({
                        success: true,
                        comments: processedComments,
                        page,
                        hasMore: processedComments.length === limit
                    })
                });
            }

            // Standalone page no longer exists
            return res.reply({ code: 404, body: "Page not found" });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: "Error loading activity data" });
        }
    });

    // Subscribe to all own uploads
    router.post('/api/v2/user/subscribe-all-uploads', async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false, message: "Unauthorized" }) });

        try {
            const result = await db`
                INSERT INTO comment_subscriptions (user_id, item_id)
                SELECT ${req.session.id}, i.id
                FROM items i
                WHERE i.username ILIKE ${req.session.login} OR i.username ILIKE ${req.session.user}
                ON CONFLICT DO NOTHING
            `;

            res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    message: `Successfully subscribed to your uploads`
                })
            });
        } catch (err) {
            console.error('[API] Failed to subscribe to all uploads:', err);
            res.reply({
                code: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: false, message: "Internal server error" })
            });
        }
    });

    return router;
};
