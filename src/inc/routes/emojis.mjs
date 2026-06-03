import db from "../sql.mjs";
import lib from "../lib.mjs";
import cfg from "../config.mjs";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

// Custom IM policy that raises list-length from 128 → 65536 to handle large animated GIFs.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGICK_POLICY_PATH = path.resolve(__dirname, '../../../config/magick-policy');
const magickEnv = { ...process.env, MAGICK_CONFIGURE_PATH: MAGICK_POLICY_PATH };

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
            const emojis = await db`SELECT id, name, url FROM custom_emojis ORDER BY id DESC`;
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, emojis })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false, message: "Database error" }) });
        }
    });

    // Reconvert all existing emoji files to WebP (Admin only)
    router.post('/api/v2/admin/emojis/reconvert', async (req, res) => {
        if (!req.session || !req.session.admin) {
            return res.reply({ code: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: "Forbidden" }) });
        }
        const csrfToken = req.headers['x-csrf-token'];
        if (!req.session.csrf_token || !csrfToken || csrfToken !== req.session.csrf_token) {
            return res.reply({ code: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: "Invalid CSRF token" }) });
        }

        try {
            const emojis = await db`SELECT id, name, url FROM custom_emojis ORDER BY id`;
            const emojisDir = cfg.paths.emojis;
            let converted = 0, skipped = 0, errors = 0;
            const errorList = [];

            for (const emoji of emojis) {
                const { id, name, url } = emoji;

                // Only handle locally hosted emojis
                if (!url || !url.startsWith('/s/emojis/')) { skipped++; continue; }

                const filename = path.basename(url);
                const ext = path.extname(filename).toLowerCase().replace('.', '');

                if (ext === 'webp') { skipped++; continue; }

                const originalPath = path.join(emojisDir, filename);
                const webpFilename = filename.replace(/\.[^.]+$/, '.webp');
                const webpPath = path.join(emojisDir, webpFilename);
                const newUrl = `/s/emojis/${webpFilename}`;

                try {
                    await fs.access(originalPath);
                } catch {
                    console.warn(`[EMOJI RECONVERT] Missing file for emoji "${name}": ${originalPath}`);
                    skipped++;
                    continue;
                }

                try {
                    await execFile('magick', [originalPath, '-coalesce', '-quality', '80', webpPath], { env: magickEnv });
                    const stat = await fs.stat(webpPath);
                    if (!stat || stat.size === 0) throw new Error('Output file is empty');
                    await db`UPDATE custom_emojis SET url = ${newUrl} WHERE id = ${id}`;
                    await fs.unlink(originalPath);
                    console.log(`[EMOJI RECONVERT] Converted "${name}": ${filename} → ${webpFilename}`);
                    converted++;
                } catch (err) {
                    console.error(`[EMOJI RECONVERT] Failed "${name}":`, err.message);
                    await fs.unlink(webpPath).catch(() => {});
                    errorList.push(`${name}: ${err.message}`);
                    errors++;
                }
            }

            if (converted > 0) {
                await db`NOTIFY emojis_updated, '{}'`;
            }

            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, converted, skipped, errors, errorList })
            });
        } catch (e) {
            console.error('[EMOJI RECONVERT] Fatal error:', e);
            return res.reply({ code: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: e.message }) });
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
