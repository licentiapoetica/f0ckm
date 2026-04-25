import db from "../sql.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import cfg from "../config.mjs";
import lib from "../lib.mjs";
import audit from "../audit.mjs";

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
            const modequery = lib.getMode(mode).replace(/items\.id/g, 'i.id');

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

        console.log("DEBUG: POST /api/comments");

        // Use standard framework parsing
        const body = req.post || {};
        const item_id = parseInt(body.item_id, 10);
        const parent_id = body.parent_id ? parseInt(body.parent_id, 10) : null;
        const content = body.content;
        const video_time = (body.video_time !== undefined && body.video_time !== '' && !isNaN(parseFloat(body.video_time)))
            ? parseFloat(body.video_time)
            : null;

        console.log("DEBUG: Posting comment:", { item_id, parent_id, content: content?.substring(0, 20) });

        if (!content || !content.trim()) {
            return res.reply({ body: JSON.stringify({ success: false, message: "Empty comment" }) });
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
                content: content
            };
            if (video_time !== null) insertData.video_time = video_time;

            const newComment = await db`
                INSERT INTO comments ${db(insertData)}
                RETURNING id, created_at, video_time
            `;

            const commentId = parseInt(newComment[0].id, 10);

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
            // Fetch the trigger-updated xd_score from the DB (trigger runs synchronously before we get here)
            const [xdRow] = await db`SELECT xd_score FROM items WHERE id = ${item_id}`;
            const livePayload = {
                type: 'comment',
                id: commentId,
                item_id: item_id,
                parent_id: parent_id || null,
                body: content,
                username: req.session.user,
                user_id: req.session.id,
                avatar: req.session.avatar,
                avatar_file: req.session.avatar_file,
                created_at: new Date().toISOString(),
                username_color: req.session.username_color,
                display_name: req.session.display_name || null,
                xd_score: xdRow?.xd_score ?? null,
                video_time: newComment[0]?.video_time ?? null
            };

            // 1. Thread live update
            db.notify('comments', JSON.stringify(livePayload));
            
            // 2. Sidebar activity update
            db.notify('activity', JSON.stringify({
                user_id: req.session.id,
                item_id: item_id,
                type: 'comment',
                body: content,
                id: commentId
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
                    comment: newComment[0],
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
        console.log(`[DEBUG] Attempting to delete comment ${commentId} by user ${req.session.id} (mod: ${req.session.is_moderator})`);

        try {
            const comment = await db`SELECT content, item_id, user_id FROM comments WHERE id = ${commentId}`;
            if (!comment.length) return res.reply({ code: 404, body: JSON.stringify({ success: false, message: "Not found" }) });

            if (!req.session.admin && !req.session.is_moderator && comment[0].user_id !== req.session.id) {
                return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });
            }

            // Log all deletions in audit log
            const reason = (req.post && req.post.reason) ? req.post.reason : (req.url.qs?.reason || 'No reason provided');
            await audit.log(req.session.id, 'delete_comment', 'comment', commentId, {
                item_id: comment[0].item_id,
                reason: reason,
                old_content: comment[0].content
            });

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

    // Edit comment (admin/mod only)
    router.post(/\/api\/comments\/(?<id>\d+)\/edit/, async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        if (!req.session.admin && !req.session.is_moderator) return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });

        const commentId = req.params.id;
        const body = req.post || {};
        const content = body.content;

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
            const limit = 50;
            const offset = (page - 1) * limit;

            /* <mode-override> */
            // prioritize query mode (from AJAX) over session default
            let mode = req.mode;
            if (req.url.qs && req.url.qs.mode && (req.url.qs.mode === '0' || req.url.qs.mode === '1' || req.url.qs.mode === '2' || req.url.qs.mode === '3')) {
                mode = parseInt(req.url.qs.mode);
            }
            /* </mode-override> */
            const modequery = lib.getMode(mode).replace(/items\.id/g, 'i.id');
            const globalfilter = cfg.nsfp.map(n => `tag_id = ${n}`).join(' or ');
            const excludedTags = req.session ? (req.session.excluded_tags || []) : [];

            const comments = await db`
                SELECT 
                    c.*, 
                    i.mime, 
                    i.id as item_id, 
                    i.dest as item_dest,
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

            const processedComments = comments.map(c => {
                return {
                    ...c,
                    content: (c.content || '').trim(),
                    username_color: c.username_color
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
