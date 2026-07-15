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

    // List all emojis — returns both a flat list and a grouped-by-pack structure
    router.get('/api/v2/emojis', async (req, res) => {
        try {
            // Try the full pack-aware query first; fall back if pack_id column doesn't exist yet
            let emojis;
            let hasPacks = true;
            try {
                emojis = await db`
                    SELECT e.id, e.name, e.url, e.pack_id,
                           p.name as pack_name, p.tg_name, p.tg_title, p.thumb_url as pack_thumb_url
                    FROM custom_emojis e
                    LEFT JOIN sticker_packs p ON p.id = e.pack_id
                    ORDER BY e.pack_id NULLS FIRST, e.id ASC
                `;
            } catch (colErr) {
                // column pack_id or thumb_url may not exist — try without thumb_url, then flat
                try {
                    emojis = await db`
                        SELECT e.id, e.name, e.url, e.pack_id,
                               p.name as pack_name, p.tg_name, p.tg_title, NULL as pack_thumb_url
                        FROM custom_emojis e
                        LEFT JOIN sticker_packs p ON p.id = e.pack_id
                        ORDER BY e.pack_id NULLS FIRST, e.id ASC
                    `;
                } catch (_) {
                    // pack_id column missing entirely — serve flat list
                    console.warn('[EMOJIS] pack_id column missing, serving flat list');
                    hasPacks = false;
                    emojis = await db`SELECT id, name, url FROM custom_emojis ORDER BY id ASC`;
                }
            }

            // Flat list (backwards compat)
            const flat = emojis.map(e => ({ id: e.id, name: e.name, url: e.url, pack_id: e.pack_id ?? null }));

            if (!hasPacks) {
                return res.reply({
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: true, emojis: flat, packs: [] })
                });
            }

            // Grouped by pack
            const packsMap = new Map();
            // "No pack" group for standalone emojis
            packsMap.set(null, { id: null, name: 'Custom Emojis', tg_name: null, emojis: [] });

            for (const e of emojis) {
                if (e.pack_id && !packsMap.has(e.pack_id)) {
                    packsMap.set(e.pack_id, {
                        id: e.pack_id,
                        name: e.pack_name || e.tg_title || `Pack #${e.pack_id}`,
                        tg_name: e.tg_name,
                        thumb_url: e.pack_thumb_url || null,
                        emojis: []
                    });
                }
                const packKey = e.pack_id ?? null;
                packsMap.get(packKey).emojis.push({ id: e.id, name: e.name, url: e.url });
            }

            // Filter out empty groups
            const packs = [...packsMap.values()].filter(p => p.emojis.length > 0);

            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, emojis: flat, packs })
            });
        } catch (e) {

            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false, message: "Database error" }) });
        }
    });

    // List sticker packs (Admin)
    router.get('/api/v2/admin/sticker-packs', async (req, res) => {
        if (!req.session || !req.session.admin) {
            return res.reply({ code: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: "Forbidden" }) });
        }
        try {
            let packs;
            try {
                packs = await db`
                    SELECT sp.id, sp.name, sp.tg_name, sp.tg_title, sp.thumb_url, sp.sticker_count, sp.created_at,
                           count(e.id)::int as actual_count
                    FROM sticker_packs sp
                    LEFT JOIN custom_emojis e ON e.pack_id = sp.id
                    GROUP BY sp.id
                    ORDER BY sp.created_at DESC
                `;
            } catch (_) {
                // thumb_url column may not exist yet — fall back without it
                packs = await db`
                    SELECT sp.id, sp.name, sp.tg_name, sp.tg_title, NULL as thumb_url, sp.sticker_count, sp.created_at,
                           count(e.id)::int as actual_count
                    FROM sticker_packs sp
                    LEFT JOIN custom_emojis e ON e.pack_id = sp.id
                    GROUP BY sp.id
                    ORDER BY sp.created_at DESC
                `;
            }
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, packs })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false, message: "Database error" }) });
        }
    });


    // Delete a sticker pack and all its emojis (Admin)
    router.delete(/\/api\/v2\/admin\/sticker-packs\/(?<id>\d+)/, async (req, res) => {
        if (!req.session || !req.session.admin) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });
        }
        const csrfToken = req.headers['x-csrf-token'];
        if (!req.session.csrf_token || !csrfToken || csrfToken !== req.session.csrf_token) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Invalid CSRF token" }) });
        }
        const id = req.params.id;
        try {
            // Fetch emoji file URLs before deletion for filesystem cleanup
            const emojiFiles = await db`SELECT url FROM custom_emojis WHERE pack_id = ${id}`;
            await db`DELETE FROM custom_emojis WHERE pack_id = ${id}`;
            await db`DELETE FROM sticker_packs WHERE id = ${id}`;

            // Clean up local files
            for (const e of emojiFiles) {
                if (e.url && e.url.startsWith('/s/emojis/')) {
                    const filename = path.basename(e.url);
                    await fs.unlink(path.join(cfg.paths.emojis, filename)).catch(() => {});
                }
            }

            await db`NOTIFY emojis_updated, '{}'`;
            return res.reply({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false, message: "Database error" }) });
        }
    });

    // Rename a sticker pack (Admin)
    router.post(/\/api\/v2\/admin\/sticker-packs\/(?<id>\d+)\/rename/, async (req, res) => {
        if (!req.session || !req.session.admin) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });
        }
        const csrfToken = req.headers['x-csrf-token'];
        if (!req.session.csrf_token || !csrfToken || csrfToken !== req.session.csrf_token) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Invalid CSRF token" }) });
        }
        const id = req.params.id;
        const newName = (req.body?.name || req.post?.name || '').trim();
        if (!newName) {
            return res.reply({ code: 400, body: JSON.stringify({ success: false, message: 'name is required' }) });
        }
        try {
            await db`UPDATE sticker_packs SET name = ${newName} WHERE id = ${id}`;
            await db`NOTIFY emojis_updated, '{}'`;
            return res.reply({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false, message: "Database error" }) });
        }
    });

    // Set tab thumbnail for a sticker pack (Admin)
    router.post(/\/api\/v2\/admin\/sticker-packs\/(?<id>\d+)\/thumb/, async (req, res) => {
        if (!req.session || !req.session.admin) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Forbidden" }) });
        }
        const csrfToken = req.headers['x-csrf-token'];
        if (!req.session.csrf_token || !csrfToken || csrfToken !== req.session.csrf_token) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, message: "Invalid CSRF token" }) });
        }
        const id = req.params.id;
        let body = {};
        try {
            const raw = req.body || req.post || {};
            body = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (_) {}
        const thumbUrl = (body.thumb_url || '').trim();
        // Only allow local emoji paths to prevent SSRF
        if (!thumbUrl || !thumbUrl.startsWith('/s/emojis/')) {
            return res.reply({ code: 400, body: JSON.stringify({ success: false, message: 'thumb_url must be a local /s/emojis/ path' }) });
        }
        try {
            try {
                await db`UPDATE sticker_packs SET thumb_url = ${thumbUrl} WHERE id = ${id}`;
            } catch (colErr) {
                // Column might not exist yet — add it and retry once
                if (colErr.message && colErr.message.includes('thumb_url')) {
                    await db`ALTER TABLE public.sticker_packs ADD COLUMN IF NOT EXISTS thumb_url text`;
                    await db`UPDATE sticker_packs SET thumb_url = ${thumbUrl} WHERE id = ${id}`;
                } else {
                    throw colErr;
                }
            }
            await db`NOTIFY emojis_updated, '{}'`;
            return res.reply({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) });
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

    // Edit emoji (Admin only) — handled by bypass middleware in index.mjs

    return router;
};
