import db from "../sql.mjs";

import lib from "../lib.mjs";

export default (router, tpl) => {

    // Admin View
    router.get(/^\/admin\/emojis\/?$/, lib.auth, async (req, res) => {
        res.reply({
            body: tpl.render("admin/emojis", { session: req.session, tmp: null }, req)
        });
    });

    // List all emojis (Public)
    router.get('/api/v2/emojis', async (req, res) => {
        try {
            const emojis = await db`SELECT id, name, url FROM custom_emojis ORDER BY name ASC`;
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, emojis })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false, message: "Database error" }) });
        }
    });



    // Delete emoji (Admin only)
    router.post(/\/api\/v2\/admin\/emojis\/(?<id>\d+)\/delete/, async (req, res) => {
        if (!req.session || !req.session.admin) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });
        }
        // F-031 Security: CSRF validation for destructive admin action
        const csrfToken = req.headers['x-csrf-token'];
        if (!req.session.csrf_token || !csrfToken || csrfToken !== req.session.csrf_token) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Invalid CSRF token" }) });
        }
        const id = req.params.id;

        try {
            await db`DELETE FROM custom_emojis WHERE id = ${id}`;
            await db`NOTIFY emojis_updated, '{}'`;
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false, message: "Database error" }) });
        }
    });

    return router;
};
