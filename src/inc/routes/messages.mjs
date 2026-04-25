import db from "../sql.mjs";
import lib from "../lib.mjs";
import cfg from "../config.mjs";
import { getPrivateMessages } from "../settings.mjs";

export default (router, tpl) => {

    const json = (res, body, code = 200) =>
        res.reply({ code, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });

    // Block all DM routes when private messaging is disabled in config
    const dmEnabled = (req, res, next) => {
        if (!getPrivateMessages()) return res.reply({ code: 404, body: 'Not found' });
        if (next) next();
    };

    // ─── Public Key Management ───────────────────────────────────────────────

    // Upload / refresh current user's public key
    router.post('/api/dm/pubkey', async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        const body = req.post || {};
        const pubkey = body.pubkey;
        const fingerprint = body.fingerprint || null;

        if (!pubkey || typeof pubkey !== 'string' || pubkey.length > 4096) {
            return json(res, { success: false, msg: 'Invalid pubkey' }, 400);
        }

        // Basic JWK validation — must look like JSON with kty field
        try {
            const parsed = JSON.parse(pubkey);
            if (!parsed.kty || parsed.kty !== 'EC' || parsed.crv !== 'P-256') {
                return json(res, { success: false, msg: 'Invalid key type — expected EC P-256' }, 400);
            }
        } catch {
            return json(res, { success: false, msg: 'Invalid JSON' }, 400);
        }

        try {
            await db`
                INSERT INTO user_pubkeys ${db({ user_id: req.session.id, pubkey, fingerprint, updated_at: db`NOW()` })}
                ON CONFLICT (user_id) DO UPDATE
                    SET pubkey = EXCLUDED.pubkey,
                        fingerprint = EXCLUDED.fingerprint,
                        updated_at = NOW()
            `;
            return json(res, { success: true });
        } catch (err) {
            console.error('[DM] pubkey upsert failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // Fetch a user's public key by user ID
    router.get(/\/api\/dm\/pubkey\/(?<userId>\d+)/, async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        const userId = parseInt(req.params.userId, 10);
        try {
            const rows = await db`SELECT pubkey, fingerprint FROM user_pubkeys WHERE user_id = ${userId}`;
            if (!rows.length) return json(res, { success: false, msg: 'No key registered for this user' }, 404);
            return json(res, { success: true, pubkey: rows[0].pubkey, fingerprint: rows[0].fingerprint });
        } catch (err) {
            console.error('[DM] pubkey fetch failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // ─── Key Vault (seed-phrase encrypted private key backup) ────────────────

    // Upload or replace the encrypted private key blob
    router.post('/api/dm/keyvault', async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        const body = req.post || {};
        const { salt, iv, ciphertext } = body;

        if (!salt || !iv || !ciphertext ||
            typeof salt !== 'string' || typeof iv !== 'string' || typeof ciphertext !== 'string') {
            return json(res, { success: false, msg: 'Missing salt, iv or ciphertext' }, 400);
        }
        // Length guards — salt: 24 chars (16 bytes b64), iv: 16 chars (12 bytes b64), ciphertext: privkey JWK is ~200 bytes + AES overhead → max 512
        if (salt.length > 32 || iv.length > 24 || ciphertext.length > 1024) {
            return json(res, { success: false, msg: 'Payload out of bounds' }, 400);
        }

        try {
            await db`
                INSERT INTO user_dm_keyvault ${db({ user_id: req.session.id, salt, iv, ciphertext, updated_at: db`NOW()` })}
                ON CONFLICT (user_id) DO UPDATE
                    SET salt       = EXCLUDED.salt,
                        iv         = EXCLUDED.iv,
                        ciphertext = EXCLUDED.ciphertext,
                        updated_at = NOW()
            `;
            return json(res, { success: true });
        } catch (err) {
            console.error('[DM] keyvault upsert failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // Fetch the encrypted blob for the current user
    router.get('/api/dm/keyvault', async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        try {
            const rows = await db`SELECT salt, iv, ciphertext, version FROM user_dm_keyvault WHERE user_id = ${req.session.id}`;
            if (!rows.length) return json(res, { success: false, msg: 'No vault found' }, 404);
            return json(res, { success: true, vault: rows[0] });
        } catch (err) {
            console.error('[DM] keyvault fetch failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // Delete the vault entry (user wants to reset)
    router.delete('/api/dm/keyvault', async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        try {
            await db`DELETE FROM user_dm_keyvault WHERE user_id = ${req.session.id}`;
            return json(res, { success: true });
        } catch (err) {
            console.error('[DM] keyvault delete failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // ─── Conversations List ──────────────────────────────────────────────────

    // Returns the list of unique users the current user has exchanged messages with,
    // plus last message metadata (no ciphertext exposed unnecessarily here — only metadata)
    router.get('/api/dm/conversations', async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        try {
            const rows = await db`
                WITH convos AS (
                    SELECT
                        CASE WHEN sender_id = ${req.session.id} THEN recipient_id ELSE sender_id END AS other_id,
                        MAX(id) AS last_msg_id
                    FROM private_messages
                    WHERE sender_id = ${req.session.id} OR recipient_id = ${req.session.id}
                    GROUP BY other_id
                ),
                unread_counts AS (
                    SELECT sender_id AS other_id, COUNT(*) AS unread
                    FROM private_messages
                    WHERE recipient_id = ${req.session.id} AND is_read = false
                    GROUP BY sender_id
                )
                SELECT
                    u.id            AS user_id,
                    u.user          AS username,
                    uo.avatar,
                    uo.avatar_file,
                    uo.username_color,
                    uo.display_name,
                    pm.created_at   AS last_message_at,
                    COALESCE(uc.unread, 0) AS unread_count
                FROM convos c
                JOIN "user" u ON u.id = c.other_id
                LEFT JOIN user_options uo ON uo.user_id = u.id
                JOIN private_messages pm ON pm.id = c.last_msg_id
                LEFT JOIN unread_counts uc ON uc.other_id = c.other_id
                LEFT JOIN user_conversation_states ucs ON ucs.user_id = ${req.session.id} AND ucs.other_id = c.other_id
                WHERE (ucs.is_hidden IS NULL OR ucs.is_hidden = false)
                ORDER BY pm.created_at DESC
            `;
            return json(res, { success: true, conversations: rows });
        } catch (err) {
            console.error('[DM] conversations failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // ─── Message Thread ──────────────────────────────────────────────────────

    // Fetch paginated messages between current user and another user
    // Supports ?before=id (older pages) and ?after=id (live updates since last known msg)
    router.get(/\/api\/dm\/thread\/(?<userId>\d+)/, async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        const otherId = parseInt(req.params.userId, 10);
        const limit = 50;
        const before = req.url.qs?.before ? parseInt(req.url.qs.before, 10) : null;
        const after  = req.url.qs?.after  ? parseInt(req.url.qs.after,  10) : null;

        // Validate other user exists
        const other = await db`SELECT id, user FROM "user" WHERE id = ${otherId} LIMIT 1`;
        if (!other.length) return json(res, { success: false, msg: 'User not found' }, 404);

        try {
            // Unhide for the viewing user
            await db`
                INSERT INTO user_conversation_states (user_id, other_id, is_hidden)
                VALUES (${req.session.id}, ${otherId}, false)
                ON CONFLICT (user_id, other_id) DO UPDATE SET is_hidden = false
            `;

            const messages = await db`
                SELECT
                    pm.id,
                    pm.sender_id,
                    pm.recipient_id,
                    pm.ciphertext,
                    pm.iv,
                    pm.is_read,
                    pm.created_at
                FROM private_messages pm
                WHERE (
                    (pm.sender_id = ${req.session.id} AND pm.recipient_id = ${otherId})
                    OR
                    (pm.sender_id = ${otherId}         AND pm.recipient_id = ${req.session.id})
                )
                ${after  ? db`AND pm.id > ${after}`  : db``}
                ${before ? db`AND pm.id < ${before}` : db``}
                ORDER BY pm.id ${after ? db`ASC` : db`DESC`}
                LIMIT ${after ? 200 : limit + 1}
            `;

            // Only applies to paginated (before) fetches
            const hasMore = !after && messages.length > limit;
            if (hasMore) messages.pop();

            return json(res, {
                success: true,
                messages: after ? messages : messages.reverse(),
                hasMore,
                other: other[0]
            });
        } catch (err) {
            console.error('[DM] thread fetch failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // Send a message (store ciphertext)
    router.post(/\/api\/dm\/send\/(?<userId>\d+)/, async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        const recipientId = parseInt(req.params.userId, 10);
        if (recipientId === req.session.id) return json(res, { success: false, msg: "Can't DM yourself" }, 400);

        const body = req.post || {};
        const { ciphertext, iv } = body;

        if (!ciphertext || !iv || typeof ciphertext !== 'string' || typeof iv !== 'string') {
            return json(res, { success: false, msg: 'Missing ciphertext or iv' }, 400);
        }
        // Sanity length bounds: ciphertext max ~64 KB encoded, iv is 16 chars (12 bytes base64url)
        if (ciphertext.length > 65536 || iv.length > 32) {
            return json(res, { success: false, msg: 'Payload too large' }, 413);
        }

        // Verify recipient exists
        const recip = await db`SELECT id FROM "user" WHERE id = ${recipientId} LIMIT 1`;
        if (!recip.length) return json(res, { success: false, msg: 'Recipient not found' }, 404);

        try {
            const msg = await db.begin(async sql => {
                const [m] = await sql`
                    INSERT INTO private_messages ${db({
                        sender_id: req.session.id,
                        recipient_id: recipientId,
                        ciphertext,
                        iv
                    })}
                    RETURNING id, created_at
                `;

                // Unhide for both parties
                await sql`
                    INSERT INTO user_conversation_states (user_id, other_id, is_hidden)
                    VALUES (${req.session.id}, ${recipientId}, false), (${recipientId}, ${req.session.id}, false)
                    ON CONFLICT (user_id, other_id) DO UPDATE SET is_hidden = false
                `;
                return m;
            });

            // Notify recipient via SSE (pg_notify wakes the db.listen in notifications.mjs)
            await db`SELECT pg_notify('private_message', ${JSON.stringify({
                id: msg.id,
                sender_id: req.session.id,
                recipient_id: recipientId,
                created_at: msg.created_at
            })})`;

            return json(res, { success: true, id: msg.id, created_at: msg.created_at });
        } catch (err) {
            console.error('[DM] send failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // Mark a conversation as read
    router.post(/\/api\/dm\/read\/(?<userId>\d+)/, async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        const otherId = parseInt(req.params.userId, 10);
        try {
            await db`UPDATE private_messages
                     SET is_read = true
                     WHERE recipient_id = ${req.session.id} AND sender_id = ${otherId} AND is_read = false`;
            return json(res, { success: true });
        } catch (err) {
            console.error('[DM] read mark failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // Hide a whole conversation (Close DM)
    router.post(/\/api\/dm\/conversation\/(?<userId>\d+)\/delete/, async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        const otherId = parseInt(req.params.userId, 10);
        try {
            await db`
                INSERT INTO user_conversation_states (user_id, other_id, is_hidden)
                VALUES (${req.session.id}, ${otherId}, true)
                ON CONFLICT (user_id, other_id) DO UPDATE SET is_hidden = true
            `;
            return json(res, { success: true });
        } catch (err) {
            console.error('[DM] hide conversation failed:', err);
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // Total unread DM count (for navbar badge polling)
    router.get('/api/dm/unread', async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: true, count: 0 });
        if (!req.session) return json(res, { success: false, count: 0 }, 401);
        try {
            const [row] = await db`
                SELECT COUNT(*) AS count FROM private_messages
                WHERE recipient_id = ${req.session.id} AND is_read = false
            `;
            return json(res, { success: true, count: parseInt(row.count, 10) });
        } catch (err) {
            return json(res, { success: false, count: 0 }, 500);
        }
    });

    // Resolve username → user_id  (needed for compose from user profile)
    router.get(/\/api\/dm\/resolve\/(?<username>[^/]+)/, async (req, res) => {
        if (!getPrivateMessages()) return json(res, { success: false, msg: 'Not found' }, 404);
        if (!req.session) return json(res, { success: false, msg: 'Unauthorized' }, 401);
        const uname = decodeURIComponent(req.params.username);
        try {
            const rows = await db`SELECT id, user FROM "user" WHERE login = ${uname.toLowerCase()} LIMIT 1`;
            if (!rows.length) return json(res, { success: false, msg: 'User not found' }, 404);
            return json(res, { success: true, user_id: rows[0].id, username: rows[0].user });
        } catch (err) {
            return json(res, { success: false, msg: 'DB error' }, 500);
        }
    });

    // ─── Pages ───────────────────────────────────────────────────────────────

    // Inbox page
    router.get('/messages', async (req, res) => {
        if (!getPrivateMessages()) return res.reply({ code: 404, body: 'Not found' });
        if (!req.session) return res.redirect('/login');
        return res.html(tpl.render('messages', {
            session: req.session,
            hidePagination: true,
            link: { main: '/messages', path: '/' },
            domain: cfg.main.url.domain
        }, req));
    });

    // Conversation page — /messages/:username
    router.get(/\/messages\/(?<username>[^/]+)/, async (req, res) => {
        if (!getPrivateMessages()) return res.reply({ code: 404, body: 'Not found' });
        if (!req.session) return res.redirect('/login');
        const uname = decodeURIComponent(req.params.username);
        const rows = await db`
            SELECT u.id, u.user, uo.avatar, uo.avatar_file, uo.username_color, uo.display_name
            FROM "user" u LEFT JOIN user_options uo ON uo.user_id = u.id
            WHERE u.login = ${uname.toLowerCase()} LIMIT 1
        `;
        if (!rows.length) return res.reply({ code: 404, body: 'User not found' });
        const other = rows[0];

        return res.html(tpl.render('messages-conversation', {
            session: req.session,
            other,
            hidePagination: true,
            link: { main: '/messages', path: '/' },
            domain: cfg.main.url.domain
        }, req));
    });

    return router;
};
