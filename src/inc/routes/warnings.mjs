import db from "../sql.mjs";
import lib from "../lib.mjs";
import audit from "../audit.mjs";

export default (router, tpl) => {

    // Mod/Admin: Issue a warning to a user
    router.post(/^\/api\/v2\/mod\/warnings\/issue\/?$/, lib.modAuth, async (req, res) => {
        try {
            const { user_id, reason } = req.post;

            if (!user_id || !reason || reason.trim().length === 0) {
                return res.json({ success: false, msg: "User ID and reason are required." }, 400);
            }

            const result = await db`
                INSERT INTO user_warnings (user_id, admin_id, reason)
                VALUES (${+user_id}, ${req.session.id}, ${reason.trim()})
                RETURNING id
            `;

            // Broadcast to SSE clients instantly
            if (result.length > 0) {
                await db`SELECT pg_notify('warnings', ${JSON.stringify({ 
                    user_id: +user_id, 
                    warning_id: result[0].id, 
                    reason: reason.trim() 
                })})`;
            }

            // Log it in audit
            const targetUser = await db`SELECT login, "user" FROM "user" WHERE id = ${+user_id} LIMIT 1`;
            const username = targetUser.length > 0 ? targetUser[0].user : String(user_id);
            await audit.log(req.session.id, 'issue_warning', 'user', +user_id, { reason: reason.trim(), target_user: username });

            return res.json({ success: true, msg: "Warning issued successfully." });
        } catch (err) {
            return res.json({ success: false, msg: lib.logError(err) }, 500);
        }
    });

    // User: Fetch active (unacknowledged) warnings
    router.get(/^\/api\/v2\/user\/warnings\/?$/, lib.loggedin, async (req, res) => {
        try {
            const warnings = await db`
                SELECT id, reason, created_at 
                FROM user_warnings 
                WHERE user_id = ${req.session.id} AND acknowledged = FALSE
                ORDER BY created_at ASC
            `;

            return res.json({ success: true, warnings });
        } catch (err) {
            return res.json({ success: false, msg: lib.logError(err) }, 500);
        }
    });

    // User: Acknowledge a warning
    router.post(/^\/api\/v2\/user\/warnings\/(?<id>\d+)\/acknowledge\/?$/, lib.loggedin, async (req, res) => {
        try {
            const id = +req.params.id;

            const result = await db`
                UPDATE user_warnings 
                SET acknowledged = TRUE 
                WHERE id = ${id} AND user_id = ${req.session.id}
                RETURNING id
            `;

            if (result.length === 0) {
                return res.json({ success: false, msg: "Warning not found or already acknowledged." }, 404);
            }

            return res.json({ success: true, msg: "Warning acknowledged." });
        } catch (err) {
            return res.json({ success: false, msg: lib.logError(err) }, 500);
        }
    });

    return router;
};
