import db from "../sql.mjs";
import lib from "../lib.mjs";
import audit from "../audit.mjs";
import cfg from "../config.mjs";
import security from "../security.mjs";

export default (router, tpl) => {

    // Submit a new report (Users & Guests)
    router.post(/^\/api\/v2\/report\/?$/, async (req, res) => {
        try {
            const { item_id, comment_id, reported_user_id, reason } = req.post;
            // The framework's readBody uses Object.fromEntries which loses duplicate keys
            // and decodeURIComponent on an array joins it as comma-separated string.
            // So categories[]= ends up as a single comma-joined string — split it back.
            const VALID_CATEGORIES = ['wrong_rating', 'spam', 'duplicate', 'copyright', 'illegal', 'other'];
            let rawCats = req.post['categories[]'] || req.post['categories'] || '';
            let categories = [];
            if (Array.isArray(rawCats)) {
                categories = rawCats;
            } else if (typeof rawCats === 'string' && rawCats.length > 0) {
                categories = rawCats.split(',').map(s => s.trim());
            }
            categories = categories.filter(c => VALID_CATEGORIES.includes(c));

            if ((!reason || reason.trim().length === 0) && categories.length === 0) {
                return res.json({ success: false, msg: "Please select at least one reason or provide a description." }, 400);
            }

            // At least one target must be specified
            if (!item_id && !comment_id && !reported_user_id) {
                return res.json({ success: false, msg: "Must specify an item, comment, or user to report." }, 400);
            }

            const ip = security.getRealIP(req);
            const isGuest = !req.session;

            if (isGuest) {
                // CAPTCHA verification for guest reports (bypassed for .onion and localhost)
                const isOnion = lib.isOnionRequest(req);
                const isLocalhost = lib.isLocalhostRequest(req);
                if (!isOnion && !isLocalhost && cfg.recaptcha?.enabled && cfg.recaptcha?.secret_key) {
                    const rcToken = req.post['g-recaptcha-response'];
                    if (!rcToken) {
                        return res.json({ success: false, msg: "Please complete the CAPTCHA." }, 400);
                    }
                    try {
                        const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({ secret: cfg.recaptcha.secret_key, response: rcToken, remoteip: ip })
                        });
                        const { success } = await verifyRes.json();
                        if (!success) {
                            return res.json({ success: false, msg: "CAPTCHA verification failed. Please try again." }, 400);
                        }
                    } catch (e) {
                        console.error('[REPORT] reCAPTCHA error:', e.message);
                        return res.json({ success: false, msg: "CAPTCHA verification error. Please try again." }, 500);
                    }
                }
            }

            const reportRes = await db`
                INSERT INTO reports (reporter_id, reporter_ip, item_id, comment_id, user_id, reason, categories)
                VALUES (
                    ${req.session ? req.session.id : null},
                    ${security.storableIP(ip)},
                    ${item_id ? +item_id : null},
                    ${comment_id ? +comment_id : null},
                    ${reported_user_id ? +reported_user_id : null},
                    ${reason ? reason.trim() : ''},
                    ${db.array(categories)}
                )
                RETURNING id
            `;

            const report_id = reportRes[0].id;

            // Notify all mods and admins
            try {
                const mods = await db`SELECT id FROM "user" WHERE admin = true OR is_moderator = true`;
                if (mods.length > 0) {
                    let resolved_item_id = item_id ? +item_id : null;
                    
                    // If reporting a comment, resolve the item_id it belongs to
                    if (!resolved_item_id && comment_id) {
                        const comm = await db`SELECT item_id FROM comments WHERE id = ${comment_id}`;
                        if (comm.length > 0) resolved_item_id = comm[0].item_id;
                    }

                    const notificationsToAdd = mods.map(m => ({
                        user_id: m.id,
                        type: 'report',
                        reference_id: report_id,
                        item_id: resolved_item_id // Can be null now after migration
                    }));
                    await db`INSERT INTO notifications ${db(notificationsToAdd)}`;
                }
            } catch (notifyErr) {
                console.error('[REPORT] Failed to send notifications:', notifyErr);
            }

            return res.json({ success: true, msg: "Report submitted successfully." });
        } catch (err) {
            return res.json({ success: false, msg: lib.logError(err) }, 500);
        }
    });

    // Mod/Admin: Get pending/all reports
    router.get(/^\/api\/v2\/mod\/reports\/?$/, lib.modAuth, async (req, res) => {
        try {
            const status = req.url.qs?.status || 'pending';
            const page = +(req.url.qs?.page || 1);
            const limit = 20;
            const offset = (page - 1) * limit;

            const reports = await db`
                SELECT r.*, 
                    rep.user AS reporter_name,
                    COALESCE(tgt_u.user, tgt_auth.user, comm_auth.user) AS reported_user_name,
                    COALESCE(NULLIF(r.user_id, 0), tgt_auth.id, comm_auth.id) AS reported_user_id,
                    COALESCE(tgt_u.admin, tgt_auth.admin, comm_auth.admin) AS reported_user_is_admin,
                    resolver.user AS resolver_name,
                    i.dest AS item_dest,
                    tgt_auth.id AS item_user_id,
                    tgt_auth.user AS item_user_name,
                    (SELECT coalesce(json_agg(json_build_object('id', t.id, 'tag', t.tag, 'normalized', t.normalized)), '[]')
                     FROM tags_assign ta
                     JOIN tags t ON ta.tag_id = t.id
                     WHERE ta.item_id = COALESCE(r.item_id, c.item_id)) as item_tags,
                    c.content AS comment_body,
                    COALESCE(r.item_id, c.item_id) AS resolved_item_id,
                    COALESCE(i.dest, ci.dest) AS resolved_item_dest,
                    COALESCE(i.mime, ci.mime) AS resolved_item_mime,
                    COALESCE(i.visibility, ci.visibility, 0) AS resolved_item_visibility
                FROM reports r
                LEFT JOIN "user" rep ON r.reporter_id = rep.id
                LEFT JOIN "user" tgt_u ON r.user_id = tgt_u.id
                LEFT JOIN "user" resolver ON r.resolved_by = resolver.id
                LEFT JOIN items i ON r.item_id = i.id
                LEFT JOIN "user" tgt_auth ON i.username = tgt_auth.user
                LEFT JOIN comments c ON r.comment_id = c.id
                LEFT JOIN items ci ON c.item_id = ci.id
                LEFT JOIN "user" comm_auth ON c.user_id = comm_auth.id
                WHERE r.status = ${status}
                ORDER BY r.created_at DESC
                LIMIT ${limit} OFFSET ${offset}
            `;

            // Compute badges for tags (sync with lib.getTags logic)
            for (const r of reports) {
                if (r.item_tags) {
                    for (const t of r.item_tags) {
                        if (t.tag.startsWith(">")) t.badge = "badge-greentext badge-light";
                        else if (t.normalized === "ukraine") t.badge = "badge-ukraine badge-light";
                        else if (/[а-яё]/.test(t.normalized) || t.normalized === "russia") t.badge = "badge-russia badge-light";
                        else if (t.normalized === "german") t.badge = "badge-german badge-light";
                        else if (t.normalized === "dutch") t.badge = "badge-dutch badge-light";
                        else if (t.normalized === "sfw") t.badge = "badge-success";
                        else if (t.normalized === "nsfw") t.badge = "badge-danger";
                        else t.badge = "badge-light";
                    }
                }
            }

            const totalRes = await db`SELECT count(*) as c FROM reports WHERE status = ${status}`;
            const total = totalRes[0].c;

            const emojis = await db`SELECT name, url FROM custom_emojis`;

            return res.json({
                success: true,
                reports,
                emojis,
                page,
                pages: Math.ceil(total / limit),
                total
            });
        } catch (err) {
            return res.json({ success: false, msg: lib.logError(err) }, 500);
        }
    });

    // Mod/Admin: Resolve a report
    router.post(/^\/api\/v2\/mod\/reports\/(?<id>\d+)\/resolve\/?$/, lib.modAuth, async (req, res) => {
        try {
            const id = +req.params.id;
            const { action } = req.post; // 'resolved' or 'rejected'

            if (!['resolved', 'rejected'].includes(action)) {
                return res.json({ success: false, msg: "Invalid action. Must be 'resolved' or 'rejected'." }, 400);
            }

            const result = await db`
                UPDATE reports 
                SET status = ${action}, resolved_by = ${req.session.id}
                WHERE id = ${id}
                RETURNING id
            `;

            if (result.length === 0) {
                return res.json({ success: false, msg: "Report not found." }, 404);
            }

            // Mark all notifications for this report as read across all moderators
            await db`
                UPDATE notifications 
                SET is_read = true 
                WHERE type = 'report' AND reference_id = ${id}
            `;

            await audit.log(req.session.id, 'resolve_report', 'report', id, { status: action });

            return res.json({ success: true, msg: `Report marked as ${action}.` });
        } catch (err) {
            return res.json({ success: false, msg: lib.logError(err) }, 500);
        }
    });

    return router;
};
