import db from "../sql.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import cfg from "../config.mjs";
import { setMotd } from "../motd.mjs";

export const clients = new Set();
const activeTabs = new Map(); // sessionId -> tabId

function pruneInactiveClients(sessionId, currentTabId) {
    for (const client of clients) {
        if (client.sessionId === sessionId && client.tabId !== currentTabId) {
            console.log(`[SSE] Pruning inactive client ${client.tabId} for session ${sessionId}`);
            client.close();
        }
    }
}

// Global listener for notifications
db.listen('notifications', (payload) => {
    try {
        const data = JSON.parse(payload);
        const userId = data.user_id;

        for (const client of clients) {
            if (client.userId === userId) {
                client.send({ type: 'notify', data });
            }
        }
    } catch (e) {
        console.error('Notification broadcast error:', e);
    }
}).catch(err => console.error('DB Listen error:', err));

// Global listener for warnings
db.listen('warnings', (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting warning to user ${data.user_id}`);
        for (const client of clients) {
            if (client.userId === data.user_id) {
                client.send({ type: 'warning', data });
            }
        }
    } catch (e) {
        console.error('Warning broadcast error:', e);
    }
}).catch(err => console.error('DB Listen Warning error:', err));

// Global listener for profile updates (display name changes etc.)
db.listen('profile_update', (payload) => {
    try {
        const data = JSON.parse(payload);
        for (const client of clients) {
            if (client.userId === data.user_id) {
                client.send({ type: 'profile_update', data });
            }
        }
    } catch (e) {
        console.error('Profile update broadcast error:', e);
    }
}).catch(err => console.error('DB Listen Profile Update error:', err));

// Global listener for activity
db.listen('activity', async (payload) => {
    try {
        const data = JSON.parse(payload);
        // We need the username, avatar, and item mime for the preview
        // trigger only gave us user_id and item_id
        const [details] = await db`
            SELECT u.id as user_id, u.user as username, uo.avatar, uo.avatar_file, uo.username_color, uo.display_name, i.mime,
            (SELECT tag_id FROM tags_assign WHERE item_id = i.id AND tag_id IN (1, 2) LIMIT 1) as tag_id
            FROM "user" u
            LEFT JOIN user_options uo ON u.id = uo.user_id
            LEFT JOIN items i ON i.id = ${data.item_id}
            WHERE u.id = ${data.user_id}
        `;

        if (details) {
            data.username = details.username;
            data.avatar = details.avatar;
            data.avatar_file = details.avatar_file;
            data.mime = details.mime;
            data.username_color = details.username_color;
            data.display_name = details.display_name || null;
            data.tag_id = details.tag_id;
        } else {
            data.username = 'System';
        }

        // Broadcast to ALL connected clients
        for (const client of clients) {
            client.send({ type: 'activity', data });
        }
    } catch (e) {
        console.error('Activity broadcast error:', e);
    }
}).catch(err => console.error('DB Listen Activity error:', err));

// Global listener for tags
db.listen('tags', async (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting tag update for item ${data.item_id} to ${clients.size} clients`);
        // Broadcast to ALL connected clients
        for (const client of clients) {
            client.send({ type: 'tags', data });
        }
    } catch (e) {
        console.error('Tag broadcast error:', e);
    }
}).catch(err => console.error('DB Listen Tag error:', err));

// Global listener for comments
db.listen('comments', async (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting comment update (${data.type}) for item ${data.item_id} to ${clients.size} clients`);
        // Broadcast to ALL connected clients
        for (const client of clients) {
            client.send({ type: 'comments', data });
        }
    } catch (e) {
        console.error('Comment broadcast error:', e);
    }
}).catch(err => console.error('DB Listen Comment error:', err));

// Global listener for favorites
db.listen('favorites', async (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting favorite update for item ${data.item_id} to ${clients.size} clients`);
        // Broadcast to ALL connected clients
        for (const client of clients) {
            client.send({ type: 'favorites', data });
        }
    } catch (e) {
        console.error('Favorite broadcast error:', e);
    }
}).catch(err => console.error('DB Listen Favorite error:', err));

// Global listener for MOTD
db.listen('motd', (payload) => {
    try {
        console.log(`[SSE] Broadcasting MOTD update to ${clients.size} clients`);
        setMotd(payload);
        for (const client of clients) {
            client.send({ type: 'motd', data: { motd: payload } });
        }
    } catch (e) {
        console.error('MOTD broadcast error:', e);
    }
}).catch(err => console.error('DB Listen MOTD error:', err));

// Global listener for new items (live grid updates)
db.listen('new_item', (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting new_item (id: ${data.id}) to ${clients.size} clients`);
        for (const client of clients) {
            client.send({ type: 'new_item', data });
        }
    } catch (e) {
        console.error('New item broadcast error:', e);
    }
}).catch(err => console.error('DB Listen new_item error:', err));

// Global listener for item deletions — broadcasts to all clients so they can remove the item live
db.listen('delete_item', (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting delete_item (id: ${data.id}) to ${clients.size} clients`);
        for (const client of clients) {
            client.send({ type: 'delete_item', data });
        }
    } catch (e) {
        console.error('Delete item broadcast error:', e);
    }
}).catch(err => console.error('DB Listen delete_item error:', err));

// Global listener for emoji updates
db.listen('emojis_updated', () => {
    try {
        console.log(`[SSE] Broadcasting emojis_updated to ${clients.size} clients`);
        for (const client of clients) {
            client.send({ type: 'emojis_updated' });
        }
    } catch (e) {
        console.error('Emoji update broadcast error:', e);
    }
}).catch(err => console.error('DB Listen emojis_updated error:', err));

// Global listener for private messages — deliver only to the recipient
db.listen('private_message', (payload) => {
    try {
        const data = JSON.parse(payload);
        // Only send to the recipient — sender already knows they sent it
        for (const client of clients) {
            if (client.userId === data.recipient_id) {
                client.send({ type: 'private_message', data: {
                    id: data.id,
                    sender_id: data.sender_id,
                    created_at: data.created_at
                }});
            }
        }
    } catch (e) {
        console.error('Private message broadcast error:', e);
    }
}).catch(err => console.error('DB Listen private_message error:', err));

// Global listener for global chat messages
db.listen('global_chat', async (payload) => {
    try {
        const data = JSON.parse(payload);
        // Enrich with user info
        const [user] = await db`
            SELECT u.user as username, uo.avatar, uo.avatar_file, uo.username_color, uo.display_name
            FROM "user" u
            LEFT JOIN user_options uo ON u.id = uo.user_id
            WHERE u.id = ${data.user_id}
        `;
        if (user) {
            data.username = user.username;
            data.avatar = user.avatar;
            data.avatar_file = user.avatar_file;
            data.username_color = user.username_color;
            data.display_name = user.display_name || null;
        }
        for (const client of clients) {
            client.send({ type: 'global_chat', data });
        }
    } catch (e) {
        console.error('Global chat broadcast error:', e);
    }
}).catch(err => console.error('DB Listen global_chat error:', err));

// Global listener for chat clear — broadcast to all clients immediately
db.listen('global_chat_clear', () => {
    try {
        console.log(`[SSE] Broadcasting global_chat_clear to ${clients.size} clients`);
        for (const client of clients) {
            client.send({ type: 'global_chat_clear' });
        }
    } catch (e) {
        console.error('Global chat clear broadcast error:', e);
    }
}).catch(err => console.error('DB Listen global_chat_clear error:', err));

// Global listener for single chat message deletion
db.listen('global_chat_delete', (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting global_chat_delete (id: ${data.id}) to ${clients.size} clients`);
        for (const client of clients) {
            client.send({ type: 'global_chat_delete', data });
        }
    } catch (e) {
        console.error('Global chat delete broadcast error:', e);
    }
}).catch(err => console.error('DB Listen global_chat_delete error:', err));

// Global listener for chat panel background changes
db.listen('global_chat_background', (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting global_chat_background to ${clients.size} clients`);
        for (const client of clients) {
            client.send({ type: 'global_chat_background', data });
        }
    } catch (e) {
        console.error('Global chat background broadcast error:', e);
    }
}).catch(err => console.error('DB Listen global_chat_background error:', err));

// Global listener for chat topic changes
db.listen('global_chat_topic', (payload) => {
    try {
        const data = JSON.parse(payload);
        for (const client of clients) {
            client.send({ type: 'global_chat_topic', data });
        }
    } catch (e) {
        console.error('Global chat topic broadcast error:', e);
    }
}).catch(err => console.error('DB Listen global_chat_topic error:', err));

export default (router, tpl) => {

    async function getNotificationHistory(userId, page = 1, limit = 50) {
        const offset = (page - 1) * limit;
        const notifications = await db`
            SELECT n.id, n.type, n.item_id, n.reference_id, n.created_at, n.is_read, n.data,
                   COALESCE(u.user, 'System') as from_user,
                   COALESCE(uo.display_name, '') as from_display_name,
                   COALESCE(u.id, 0) as from_user_id,
                   uo.username_color,
                   i.dest, i.mime
            FROM notifications n
            LEFT JOIN comments c ON n.reference_id = c.id
            LEFT JOIN "user" u ON c.user_id = u.id
            LEFT JOIN user_options uo ON u.id = uo.user_id
            LEFT JOIN items i ON n.item_id = i.id
            WHERE n.user_id = ${userId}
            AND (n.type IN ('admin_pending', 'deny', 'item_deleted', 'report') OR i.id IS NULL OR (i.active = true AND i.is_deleted = false))
            ORDER BY n.created_at DESC
            LIMIT ${limit + 1}
            OFFSET ${offset}
        `;

        const hasMore = notifications.length > limit;
        if (hasMore) notifications.pop();

        // Pre-process for template
        const processed = notifications.map(n => {
            let reason = 'No reason provided';
            if (n.data) {
                const data = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
                reason = data.reason || reason;
            }
            return { ...n, reason };
        });

        return {
            notifications: processed,
            hasMore,
            page
        };
    }


    // Get unread notifications
    router.get('/api/notifications', async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });

        try {
            const notifications = await db`
                SELECT n.id, n.type, n.item_id, n.reference_id, n.created_at, n.is_read, n.data,
                       COALESCE(u.user, 'System') as from_user,
                       COALESCE(uo.display_name, '') as from_display_name,
                       COALESCE(u.id, 0) as from_user_id,
                       uo.username_color,
                       i.dest, i.mime
                FROM notifications n
                LEFT JOIN comments c ON n.reference_id = c.id
                LEFT JOIN "user" u ON c.user_id = u.id
                LEFT JOIN user_options uo ON u.id = uo.user_id
                LEFT JOIN items i ON n.item_id = i.id
                WHERE n.user_id = ${req.session.id} AND n.is_read = false
                AND (n.type IN ('admin_pending', 'deny', 'item_deleted', 'report') OR i.id IS NULL OR (i.active = true AND i.is_deleted = false))
                ORDER BY n.created_at DESC
                LIMIT 20
            `;

            const processed = notifications.map(n => {
                let reason = 'No reason provided';
                if (n.data) {
                    const data = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
                    reason = data.reason || reason;
                }
                return { ...n, reason };
            });

            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true, notifications: processed })
            });
        } catch (err) {
            console.error(err);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // Mark all as read
    router.post('/api/notifications/read', async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });

        try {
            await db`UPDATE notifications SET is_read = true WHERE user_id = ${req.session.id}`;
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true })
            });
        } catch (err) {
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // Mark single as read (optional, for clicking)
    router.post(/\/api\/notifications\/(?<id>\d+)\/read/, async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        const id = req.params.id;
        console.log(`[NotificationRoute] Marking notification ${id} as read for user ${req.session.id}`);
        try {
            await db`UPDATE notifications SET is_read = true WHERE id = ${id} AND user_id = ${req.session.id}`;
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true })
            });
        } catch (err) {
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // Mark all notifications for a specific item as read
    // Used when the user receives a live notification while already viewing that item.
    // System-type notifications (item_deleted, deny, report, admin_pending) are excluded —
    // they require explicit user acknowledgment.
    router.post(/\/api\/notifications\/item\/(?<itemId>\d+)\/read/, async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        const itemId = req.params.itemId;
        const SYSTEM_TYPES = ['item_deleted', 'deny', 'admin_pending', 'report'];
        console.log(`[NotificationRoute] Marking comment notifications for item ${itemId} as read for user ${req.session.id}`);
        try {
            await db`
                UPDATE notifications
                SET is_read = true
                WHERE user_id = ${req.session.id}
                  AND item_id = ${+itemId}
                  AND NOT (type = ANY(${SYSTEM_TYPES}))
            `;
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true })
            });
        } catch (err) {
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // SSE Stream
    router.get('/api/notifications/stream', (req, res) => {
        const tabId = req.url.qs?.tabId || 'unknown';
        const sessionCookie = req.cookies?.session;
        const isGuest = !sessionCookie;
        
        // Use session cookie as the primary identifier.
        // For guests, we use tabId to avoid IP-based pruning collisions (CGNAT).
        const sessionId = sessionCookie || `guest-${tabId}`;

        // Pruning/Active logic only for logged-in users
        if (!isGuest) {
            const currentActive = activeTabs.get(sessionId);
            if (currentActive && currentActive !== tabId) {
                // Check if the current active tab is actually still connected
                const activeClient = Array.from(clients).find(c => c.sessionId === sessionId && c.tabId === currentActive);
                if (activeClient) {
                    // console.log(`[SSE] Denying connection for inactive tab ${tabId} (Active: ${currentActive})`);
                    res.writeHead(204); // No Content
                    return res.end();
                }
            }
        }

        const headers = {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no' // Prevent Nginx from buffering
        };

        res.writeHead(200, headers);
        res.write(': ok\n\n'); // Warmup

        const client = {
            userId: (req.session && typeof req.session === 'object') ? req.session.id : null,
            sessionId,
            tabId,
            send: (data) => {
                try {
                    res.write(`data: ${JSON.stringify(data)}\n\n`);
                } catch (err) {
                    // console.error('[SSE] Failed to send to client:', err.message);
                }
            },
            close: () => {
                try {
                    res.end();
                } catch (err) {}
            }
        };

        // Send any unacknowledged warnings on connection
        if (!isGuest && req.session?.id) {
            db`
                SELECT id, reason 
                FROM user_warnings 
                WHERE user_id = ${req.session.id} AND acknowledged = FALSE
                ORDER BY created_at ASC
            `.then(warnings => {
                warnings.forEach(warning => {
                    client.send({ 
                        type: 'warning', 
                        data: { 
                            warning_id: warning.id, 
                            reason: warning.reason 
                        } 
                    });
                });
            }).catch(e => console.error('[SSE] Failed to fetch initial warnings:', e));
        }


        // Set as active tab and prune others (only for logged-in users)
        if (!isGuest) {
            activeTabs.set(sessionId, tabId);
            pruneInactiveClients(sessionId, tabId);
        }

        clients.add(client);

        // Keep-alive ping
        const pingInterval = setInterval(() => {
            try {
                res.write(': ping\n\n');
            } catch (e) {
                // Connection likely closed
            }
        }, 30000);

        res.on('close', () => {
            clearInterval(pingInterval);
            clients.delete(client);
            if (activeTabs.get(sessionId) === tabId) {
                // activeTabs.delete(sessionId); // Keep it set so we know who was last active
            }
        });
    });

    // Active Signal
    router.get('/api/notifications/active', (req, res) => {
        const tabId = req.url.qs?.tabId;
        const sessionId = req.cookies?.session;

        // Only track active tabs for logged-in users
        if (tabId && sessionId) {
            console.log(`[SSE] Tab ${tabId} became active for session ${sessionId}`);
            activeTabs.set(sessionId, tabId);
            pruneInactiveClients(sessionId, tabId);
            return res.reply({ body: JSON.stringify({ success: true }) });
        }
        
        // For guests, this is a no-op
        return res.reply({ body: JSON.stringify({ success: true }) });
    });

    // Notification History Page
    router.get('/notifications', async (req, res) => {
        if (!req.session) return res.redirect('/login');
        const data = await getNotificationHistory(req.session.id, 1);
        data.session = req.session;
        data.hidePagination = true;
        data.pagination = {
            page: 1,
            next: data.hasMore ? 2 : null
        };
        data.link = { main: '/notifications', path: '/' };
        data.domain = cfg.main.url.domain; // For header
        return res.html(tpl.render('notifications', data, req));
    });

    // AJAX Notification History
    router.get('/ajax/notifications', async (req, res) => {
        if (!req.session) return res.json({
            success: false
        }, 401);
        const page = parseInt(req.url.qs.page) || 1;
        const data = await getNotificationHistory(req.session.id, page);

        const html = tpl.render('snippets/notifications-list', data, req);

        return res.json({
            success: true,
            html,
            hasMore: data.hasMore,
            currentPage: page,
            nextPage: data.hasMore ? page + 1 : null
        });
    });

    return router;
};
