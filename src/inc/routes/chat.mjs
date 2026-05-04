import db from "../sql.mjs";
import cfg from "../config.mjs";

const MAX_MSG_LEN = 500;
const RATE_LIMIT_MS = 1000; // 1s between messages
const userLastMsg = new Map();

// Cached state — loaded from DB on first use, written through on every change
let chatBackground = null;
let chatTopic      = null;
let _settingsLoaded = false;

async function loadSettings() {
    if (_settingsLoaded) return;
    _settingsLoaded = true;
    try {
        const rows = await db`SELECT key, value FROM global_chat_settings WHERE key IN ('background','topic')`;
        for (const row of rows) {
            if (row.key === 'background') chatBackground = row.value || null;
            if (row.key === 'topic')      chatTopic      = row.value || null;
        }
    } catch (err) {
        // Table may not exist yet (migration not applied) — degrade gracefully
        console.warn('[Chat] Could not load settings (run global_chat_settings.sql migration):', err.message);
    }
}

async function saveSetting(key, value) {
    try {
        await db`
            INSERT INTO global_chat_settings (key, value) VALUES (${key}, ${value})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `;
    } catch (err) {
        console.warn('[Chat] Could not persist setting:', key, err.message);
    }
}

// Build allowed-host regex from config
function buildBgHostRegex() {
    const siteHost = new URL(cfg.main.url.base || `http://${cfg.main.url.domain}`).host;
    const escaped = [siteHost, ...(cfg.websrv.allowed_comment_images || [])].map(h =>
        h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    return new RegExp(`^https?://(?:${escaped.join('|')})/`, 'i');
}

export default (router, tpl) => {

    // GET /api/chat — fetch recent messages
    router.get('/api/chat', async (req, res) => {
        if (!cfg.websrv.enable_global_chat) {
            return res.reply({ code: 404, body: JSON.stringify({ success: false }) });
        }
        if (!req.session) {
            return res.reply({ code: 401, body: JSON.stringify({ success: false, msg: 'Login required' }) });
        }
        try {
            const messages = await db`
                SELECT gc.id, gc.user_id, gc.message, gc.created_at,
                       u.user as username, uo.avatar, uo.avatar_file,
                       uo.username_color, uo.display_name
                FROM global_chat gc
                JOIN "user" u ON u.id = gc.user_id
                LEFT JOIN user_options uo ON uo.user_id = gc.user_id
                ORDER BY gc.created_at DESC
                LIMIT 50
            `;
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true, messages: messages.reverse() })
            });
        } catch (err) {
            console.error('[Chat] GET error:', err);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // POST /api/chat — send a message
    router.post('/api/chat', async (req, res) => {
        if (!cfg.websrv.enable_global_chat) {
            return res.reply({ code: 404, body: JSON.stringify({ success: false }) });
        }
        if (!req.session) {
            return res.reply({ code: 401, body: JSON.stringify({ success: false, msg: 'Login required' }) });
        }
        // F-007 Security: Block banned users from chatting
        if (req.session.banned) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: 'You are banned' }) });
        }

        const message = (req.post?.message || '').trim();
        if (!message || message.length > MAX_MSG_LEN) {
            return res.reply({ code: 400, body: JSON.stringify({ success: false, msg: 'Invalid message' }) });
        }

        // Rate limit
        const now = Date.now();
        const lastMs = userLastMsg.get(req.session.id) || 0;
        if (now - lastMs < RATE_LIMIT_MS) {
            return res.reply({ code: 429, body: JSON.stringify({ success: false, msg: 'Slow down!' }) });
        }
        userLastMsg.set(req.session.id, now);

        try {
            await db`
                INSERT INTO global_chat (user_id, message)
                VALUES (${req.session.id}, ${message})
            `;
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true })
            });
        } catch (err) {
            console.error('[Chat] POST error:', err);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // GET /api/chat/background — return current background CSS
    router.get('/api/chat/background', async (req, res) => {
        if (!cfg.websrv.enable_global_chat) {
            return res.reply({ code: 404, body: JSON.stringify({ success: false }) });
        }
        await loadSettings();
        return res.reply({
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ success: true, background: chatBackground })
        });
    });

    // POST /api/chat/background — admin: set chat panel background
    router.post('/api/chat/background', async (req, res) => {
        if (!cfg.websrv.enable_global_chat) {
            return res.reply({ code: 404, body: JSON.stringify({ success: false }) });
        }
        if (!req.session || (!req.session.admin && !req.session.is_moderator)) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: 'Forbidden' }) });
        }

        const { url, opts } = req.post || {};
        if (!url) {
            // Clear background
            chatBackground = null;
            await saveSetting('background', null);
            await db`SELECT pg_notify('global_chat_background', ${JSON.stringify({ background: null })})`;
            return res.reply({ headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ success: true }) });
        }

        // Validate URL against allowed hosts
        const hostRegex = buildBgHostRegex();
        if (!hostRegex.test(url)) {
            return res.reply({ code: 400, body: JSON.stringify({ success: false, msg: 'URL not from an allowed host' }) });
        }

        // Build the CSS background shorthand
        const safeOpts = (opts || 'center / cover no-repeat')
            .replace(/[;<>{}]/g, '');
        const css = `url(${JSON.stringify(url)}) ${safeOpts}`;

        chatBackground = css;
        await saveSetting('background', css);
        try {
            await db`SELECT pg_notify('global_chat_background', ${JSON.stringify({ background: css })})`;
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true, background: css })
            });
        } catch (err) {
            console.error('[Chat] BACKGROUND error:', err);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // GET /api/chat/topic — return current topic text
    router.get('/api/chat/topic', async (req, res) => {
        if (!cfg.websrv.enable_global_chat) {
            return res.reply({ code: 404, body: JSON.stringify({ success: false }) });
        }
        await loadSettings();
        return res.reply({
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ success: true, topic: chatTopic })
        });
    });

    // POST /api/chat/topic — admin: set or clear the pinned topic
    router.post('/api/chat/topic', async (req, res) => {
        if (!cfg.websrv.enable_global_chat) {
            return res.reply({ code: 404, body: JSON.stringify({ success: false }) });
        }
        if (!req.session || (!req.session.admin && !req.session.is_moderator)) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: 'Forbidden' }) });
        }
        const raw = (req.post?.topic || '').trim();
        chatTopic = raw || null;
        await saveSetting('topic', chatTopic);
        try {
            await db`SELECT pg_notify('global_chat_topic', ${JSON.stringify({ topic: chatTopic })})`;
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true, topic: chatTopic })
            });
        } catch (err) {
            console.error('[Chat] TOPIC error:', err);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // DELETE /api/chat/:id — admin: delete a single message
    router.delete(/\/api\/chat\/(?<id>\d+)/, async (req, res) => {
        if (!cfg.websrv.enable_global_chat) {
            return res.reply({ code: 404, body: JSON.stringify({ success: false }) });
        }
        if (!req.session || (!req.session.admin && !req.session.is_moderator)) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: 'Forbidden' }) });
        }
        const id = parseInt(req.params.id, 10);
        if (!id) return res.reply({ code: 400, body: JSON.stringify({ success: false }) });
        try {
            await db`DELETE FROM global_chat WHERE id = ${id}`;
            await db`SELECT pg_notify('global_chat_delete', ${JSON.stringify({ id })})`;
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true })
            });
        } catch (err) {
            console.error('[Chat] DELETE message error:', err);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // DELETE /api/chat — admin: clear all messages
    router.delete('/api/chat', async (req, res) => {
        if (!cfg.websrv.enable_global_chat) {
            return res.reply({ code: 404, body: JSON.stringify({ success: false }) });
        }
        if (!req.session || (!req.session.admin && !req.session.is_moderator)) {
            return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: 'Forbidden' }) });
        }
        try {
            await db`TRUNCATE global_chat RESTART IDENTITY`;
            await db`SELECT pg_notify('global_chat_clear', '')`;
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true })
            });
        } catch (err) {
            console.error('[Chat] CLEAR error:', err);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    return router;
};
