import db from "../sql.mjs";
import path from "path";
import fs from "fs/promises";
import { parseMultipart, collectBody } from "../multipart.mjs";
import lib from "../lib.mjs";
import cfg from "../config.mjs";

export default (router, tpl) => {

    // Admin View
    router.get(/^\/admin\/memes\/?$/, lib.auth, async (req, res) => {
        res.reply({
            body: tpl.render("admin/memes", { session: req.session, tmp: null }, req)
        });
    });

    // List all memes (Public API)
    router.get('/api/v2/memes', async (req, res) => {
        try {
            const memes = await db`SELECT id, template_id, name, url, category FROM meme_templates ORDER BY name ASC`;
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, memes })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false, message: "Database error" }) });
        }
    });



    // Delete meme template (Admin only)
    router.post(/\/api\/v2\/admin\/memes\/(?<id>\d+)\/delete/, async (req, res) => {
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
            await db`DELETE FROM meme_templates WHERE id = ${id}`;
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
