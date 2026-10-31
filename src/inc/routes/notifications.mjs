import db from "../sql.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import cfg from "../config.mjs";
import { getEnableItemSlugs, isAnonymizeSession, getHwFingerprintEnabled } from "../settings.mjs";
import { setMotd } from "../motd.mjs";
import security from "../security.mjs";

export const clients = new Set();
const activeTabs = new Map(); // sessionId -> tabId

export function broadcastBan(data) {
    if (!data) return;
    const targetUserIds = new Set();
    if (data.userId) targetUserIds.add(+data.userId);
    if (Array.isArray(data.userIds)) data.userIds.forEach(id => targetUserIds.add(+id));

    const targetFps = new Set();
    if (data.fingerprint) targetFps.add(data.fingerprint);
    if (Array.isArray(data.fingerprints)) data.fingerprints.forEach(fp => targetFps.add(fp));

    const targetHws = new Set();
    if (data.hwFingerprint) targetHws.add(data.hwFingerprint);
    if (Array.isArray(data.hwFingerprints)) data.hwFingerprints.forEach(hw => targetHws.add(hw));

    const targetIps = new Set();
    if (data.ip) targetIps.add(data.ip);
    if (Array.isArray(data.ips)) data.ips.forEach(ip => targetIps.add(ip));

    const targetIpHashes = new Set();
    if (data.ipHash) targetIpHashes.add(data.ipHash);
    if (Array.isArray(data.ipHashes)) data.ipHashes.forEach(h => targetIpHashes.add(h));

    for (const client of clients) {
        let isMatch = false;

        if (client.userId && targetUserIds.has(+client.userId)) {
            isMatch = true;
        } else if (client.fingerprint && targetFps.has(client.fingerprint)) {
            isMatch = true;
        } else if (client.hwFingerprint && targetHws.has(client.hwFingerprint)) {
            isMatch = true;
        } else if (client.ip && targetIps.has(client.ip)) {
            isMatch = true;
        } else if (client.ipHash && (targetIpHashes.has(client.ipHash) || targetIps.has(client.ipHash))) {
            isMatch = true;
        }

        if (isMatch) {
            console.log(`[SSE] Delivering instant ban to client (userId: ${client.userId}, ip: ${client.ip}, tab: ${client.tabId})`);
            client.send({
                type: 'banned',
                data: {
                    reason: data.reason || 'Violation of community rules',
                    expires: data.expires ? (isNaN(new Date(data.expires).getTime()) ? data.expires : new Date(data.expires).toLocaleString()) : 'Permanent',
                    redirect: '/banned'
                }
            });
            setTimeout(() => {
                client.close();
            }, 1000);
        }
    }
}

// Broadcast the deduplicated online-user list to all connected clients
function broadcastChatPresence() {
    const seen = new Set();
    const users = [];
    const guestIps = new Set();
    for (const client of clients) {
        if (client.userId) {
            if (!seen.has(client.userId)) {
                seen.add(client.userId);
                users.push({
                    id:             client.userId,
                    username:       client.username,
                    display_name:   client.display_name,
                    avatar_file:    client.avatar_file,
                    avatar:         client.avatar,
                    username_color: client.username_color
                });
            }
        } else if (client.ip) {
            guestIps.add(client.ip);
        }
    }
    const guestCount = guestIps.size;
    for (const client of clients) {
        client.send({ type: 'global_chat_presence', data: { users, guestCount } });
    }
}

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
        const SYSTEM_TYPES = ['upload_success', 'upload_error'];
        const USER_TYPES = ['comment', 'comment_reply', 'mention', 'subscription', 'upload_comment'];

        for (const client of clients) {
            if (client.userId === userId) {
                // Do Not Disturb takes absolute priority for standard notifications
                if (client.do_not_disturb === true) continue;

                if (SYSTEM_TYPES.includes(data.type) && client.receive_system_notifications === false) continue;
                // warnings bypass user settings
                if (data.type !== 'warning' && USER_TYPES.includes(data.type) && client.receive_user_notifications === false) continue;
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

// Global listener for bans
db.listen('bans', (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Received ban event via database notify:`, data);
        broadcastBan(data);
    } catch (e) {
        console.error('[SSE] Ban broadcast error:', e);
    }
}).catch(err => console.error('[SSE] DB Listen Ban error:', err));

// Global listener for profile updates (display name changes etc.)
db.listen('profile_update', (payload) => {
    try {
        const data = JSON.parse(payload);
        for (const client of clients) {
            if (client.userId === data.user_id) {
                // Sync notification preferences to client object for real-time filtering
                if (data.receive_system_notifications !== undefined) client.receive_system_notifications = data.receive_system_notifications;
                if (data.receive_user_notifications !== undefined) client.receive_user_notifications = data.receive_user_notifications;
                if (data.do_not_disturb !== undefined) client.do_not_disturb = data.do_not_disturb;
                
                client.send({ type: 'profile_update', data });
            } else {
                // For other users, only send public profile fields (so their DOM can live-update)
                const publicData = {
                    user_id: data.user_id,
                    user: data.user,
                    display_name: data.display_name,
                    banner_file: data.banner_file,
                    banner_position: data.banner_position,
                    banner_size: data.banner_size,
                    avatar_file: data.avatar_file,
                    username_color: data.username_color,
                    description: data.description
                };
                client.send({ type: 'profile_update', data: publicData });
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
            SELECT u.id as user_id, u.user as username, uo.avatar, uo.avatar_file, uo.username_color, uo.display_name, uo.banner_file, uo.banner_position, uo.banner_size, uo.banner_repeat, i.mime, i.slug as item_slug, COALESCE(i.visibility, 0) as visibility, LOWER(i.username) as item_username,
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
            data.banner_file = data.banner_file || details.banner_file || null;
            data.banner_position = data.banner_position || details.banner_position || null;
            data.banner_size = data.banner_size || details.banner_size || null;
            data.banner_repeat = data.banner_repeat || details.banner_repeat || null;
            data.mime = details.mime;
            data.username_color = details.username_color;
            data.display_name = details.display_name || null;
            data.tag_id = details.tag_id;
            data.item_slug = getEnableItemSlugs() ? details.item_slug : null;
            data.visibility = details.visibility;
            data.item_username = details.item_username;
        } else {
            data.username = 'System';
            data.visibility = 0;
            data.item_username = null;
        }

        // Broadcast to clients permitted to view this activity
        for (const client of clients) {
            const itemVisibility = data.visibility ?? 0;
            const isPublic = itemVisibility === 0;
            const isCommentAuthor = client.userId && client.userId === data.user_id;
            const isItemOwner = client.username && data.item_username && client.username.toLowerCase() === data.item_username.toLowerCase();
            const isAdminOrMod = client.admin || client.is_moderator;

            if (isPublic || isCommentAuthor || isItemOwner || isAdminOrMod) {
                client.send({ type: 'activity', data });
            }
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
        // Broadcast to ALL connected clients with per-client anonymization
        for (const client of clients) {
            const isAnonClient = client.session ? isAnonymizeSession(client.session) : (client.isAnonymized ?? isAnonymizeSession(null));
            if (isAnonClient) {
                const anonymizedFavs = Array.isArray(data.favs) ? data.favs.map(f => {
                    const isSelf = client.userId && f.user_id && Number(f.user_id) === Number(client.userId);
                    if (isSelf) return f;
                    return {
                        user_id: null,
                        user: 'anonymous',
                        login: 'anonymous',
                        display_name: 'Anonymous',
                        avatar: null,
                        avatar_file: null,
                        username_color: null,
                        hide_fav_badge: f.hide_fav_badge,
                        is_anon: true
                    };
                }) : [];
                client.send({
                    type: 'favorites',
                    data: {
                        item_id: data.item_id,
                        user_id: (client.userId && data.user_id && Number(client.userId) === Number(data.user_id)) ? data.user_id : null,
                        favorited: data.favorited,
                        favs: anonymizedFavs
                    }
                });
            } else {
                client.send({ type: 'favorites', data });
            }
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

// Global listener for brand image updates
db.listen('brand_image', (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting brand_image update to ${clients.size} clients`);
        for (const client of clients) {
            client.send({ type: 'brand_image', data: { url: data.url || null } });
        }
    } catch (e) {
        console.error('Brand image broadcast error:', e);
    }
}).catch(err => console.error('DB Listen brand_image error:', err));


// Global listener for new items (live grid updates)
db.listen('new_item', (payload) => {
    try {
        const data = JSON.parse(payload);
        const itemVis = data.visibility || 0;
        console.log(`[SSE] Broadcasting new_item (id: ${data.id}, visibility: ${itemVis}) to connected clients`);
        for (const client of clients) {
            const isOwner = client.username && data.username && client.username.toLowerCase() === data.username.toLowerCase();
            if (itemVis === 0 || isOwner) {
                client.send({ type: 'new_item', data });
            }
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
                // Silenced by DND
                if (client.do_not_disturb === true) continue;

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

// Global listener for rethumb live updates
db.listen('rethumb', (payload) => {
    try {
        const data = JSON.parse(payload);
        console.log(`[SSE] Broadcasting rethumb (id: ${data.item_id}) to ${clients.size} clients`);
        for (const client of clients) {
            client.send({ type: 'rethumb', data });
        }
    } catch (e) {
        console.error('Rethumb broadcast error:', e);
    }
}).catch(err => console.error('DB Listen rethumb error:', err));

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

    // Cleanup any orphaned or obsolete unread notifications on startup
    db`UPDATE notifications SET is_read = true WHERE type = 'report' AND reference_id IN (SELECT id FROM reports WHERE status != 'pending') AND is_read = false`.catch(err => console.error('[NOTIF CLEANUP] Failed to cleanup report notifications:', err));
    db`UPDATE notifications SET is_read = true WHERE type = 'admin_pending' AND item_id IN (SELECT id FROM items WHERE active = true OR is_deleted = true) AND is_read = false`.catch(err => console.error('[NOTIF CLEANUP] Failed to cleanup admin_pending notifications:', err));

    const USER_TYPES = ['comment_reply', 'subscription', 'mention', 'upload_comment'];
    const SYSTEM_TYPES = ['approve', 'deny', 'item_deleted', 'upload_success', 'upload_error', 'admin_pending', 'report', 'warning', 'invite_approved', 'invite_denied'];
    const ADMIN_TYPES = ['invite_request'];

    const nsflTagId = cfg.nsfl_tag_id || 3;

    async function getNotificationHistory(userId, page = 1, limit = 50, tab = null) {
        const offset = (page - 1) * limit;
        const typeFilter = tab === 'admin' ? ADMIN_TYPES : (tab === 'system' ? SYSTEM_TYPES : (tab === 'user' ? USER_TYPES : null));
        const notifications = typeFilter
            ? await db`
                SELECT n.id, n.type, n.item_id, i.slug as item_slug, n.reference_id, n.created_at, n.is_read, n.data,
                       COALESCE(u.user, 'System') as from_user,
                       COALESCE(uo.display_name, '') as from_display_name,
                       COALESCE(u.id, 0) as from_user_id,
                       uo.username_color,
                       i.dest, i.mime,
                       CASE (SELECT ta.tag_id FROM tags_assign ta WHERE ta.item_id = n.item_id AND ta.tag_id IN (1, 2, ${nsflTagId}) LIMIT 1)
                           WHEN 1 THEN 'sfw'
                           WHEN 2 THEN 'nsfw'
                           WHEN ${nsflTagId} THEN 'nsfl'
                           ELSE NULL
                       END as item_mode
                FROM notifications n
                LEFT JOIN comments c ON n.reference_id = c.id
                LEFT JOIN "user" u ON c.user_id = u.id
                LEFT JOIN user_options uo ON u.id = uo.user_id
                LEFT JOIN items i ON n.item_id = i.id
                WHERE n.user_id = ${userId}
                AND n.type = ANY(${typeFilter})
                AND (n.type IN ('admin_pending', 'deny', 'item_deleted', 'report', 'warning') OR i.id IS NULL OR (i.active = true AND i.is_deleted = false))
                ORDER BY n.created_at DESC
                LIMIT ${limit + 1}
                OFFSET ${offset}
            `
            : await db`
                SELECT n.id, n.type, n.item_id, i.slug as item_slug, n.reference_id, n.created_at, n.is_read, n.data,
                       COALESCE(u.user, 'System') as from_user,
                       COALESCE(uo.display_name, '') as from_display_name,
                       COALESCE(u.id, 0) as from_user_id,
                       uo.username_color,
                       i.dest, i.mime,
                       CASE (SELECT ta.tag_id FROM tags_assign ta WHERE ta.item_id = n.item_id AND ta.tag_id IN (1, 2, ${nsflTagId}) LIMIT 1)
                           WHEN 1 THEN 'sfw'
                           WHEN 2 THEN 'nsfw'
                           WHEN ${nsflTagId} THEN 'nsfl'
                           ELSE NULL
                       END as item_mode
                FROM notifications n
                LEFT JOIN comments c ON n.reference_id = c.id
                LEFT JOIN "user" u ON c.user_id = u.id
                LEFT JOIN user_options uo ON u.id = uo.user_id
                LEFT JOIN items i ON n.item_id = i.id
                WHERE n.user_id = ${userId}
                AND (n.type IN ('admin_pending', 'deny', 'item_deleted', 'report', 'warning') OR i.id IS NULL OR (i.active = true AND i.is_deleted = false))
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
            return { ...n, item_slug: getEnableItemSlugs() ? n.item_slug : null, reason };
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
                SELECT n.id, n.type, n.item_id, i.slug as item_slug, n.reference_id, n.created_at, n.is_read, n.data,
                       COALESCE(u.user, 'System') as from_user,
                       COALESCE(uo.display_name, '') as from_display_name,
                       COALESCE(u.id, 0) as from_user_id,
                       uo.username_color,
                       i.dest, i.mime,
                       CASE (SELECT ta.tag_id FROM tags_assign ta WHERE ta.item_id = n.item_id AND ta.tag_id IN (1, 2, ${nsflTagId}) LIMIT 1)
                           WHEN 1 THEN 'sfw'
                           WHEN 2 THEN 'nsfw'
                           WHEN ${nsflTagId} THEN 'nsfl'
                           ELSE NULL
                       END as item_mode
                FROM notifications n
                LEFT JOIN comments c ON n.reference_id = c.id
                LEFT JOIN "user" u ON c.user_id = u.id
                LEFT JOIN user_options uo ON u.id = uo.user_id
                LEFT JOIN items i ON n.item_id = i.id
                LEFT JOIN reports r ON n.type = 'report' AND n.reference_id = r.id
                WHERE n.user_id = ${req.session.id} AND n.is_read = false
                AND (n.type IN ('admin_pending', 'deny', 'item_deleted', 'report', 'approve', 'warning', 'invite_request', 'invite_approved', 'invite_denied') 
                     OR (
                       ${req.session.do_not_disturb !== true} AND (
                         (n.type IN ('upload_success', 'upload_error') AND ${req.session.receive_system_notifications !== false})
                         OR (n.type IN ('comment', 'comment_reply', 'mention', 'subscription', 'upload_comment') AND ${req.session.receive_user_notifications !== false})
                       )
                     )
                )
                AND (n.item_id IS NULL OR (i.active = true AND i.is_deleted = false) OR n.type IN ('admin_pending', 'deny', 'item_deleted', 'report', 'warning', 'invite_request', 'invite_approved', 'invite_denied'))
                AND (n.type != 'report' OR r.status = 'pending')
                AND (n.type != 'admin_pending' OR (i.active = false AND i.is_deleted = false))
                ORDER BY n.created_at DESC
                LIMIT 1000
            `;

            const processed = notifications.map(n => {
                let reason = 'No reason provided';
                if (n.data) {
                    const data = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
                    reason = data.reason || reason;
                }
                return { ...n, item_slug: getEnableItemSlugs() ? n.item_slug : null, reason };
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

    // Mark all as read (optionally filtered by tab)
    router.post('/api/notifications/read', async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });

        try {
            const tab = req.url.qs?.tab || null;
            const typeFilter = tab === 'admin' ? ADMIN_TYPES : (tab === 'system' ? SYSTEM_TYPES : (tab === 'user' ? USER_TYPES : null));
            if (typeFilter) {
                await db`UPDATE notifications SET is_read = true WHERE user_id = ${req.session.id} AND type = ANY(${typeFilter})`;
            } else {
                await db`UPDATE notifications SET is_read = true WHERE user_id = ${req.session.id}`;
            }
            return res.reply({
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ success: true, tab })
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
    router.post(/\/api\/notifications\/item\/(?<itemId>[a-zA-Z0-9_-]{11}|\d+)\/read/, async (req, res) => {
        if (!req.session?.id) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });
        const rawItemId = req.params.itemId;
        const numericId = await f0cklib.resolveNumericItemId(rawItemId);
        if (!numericId) return res.reply({ code: 404, body: JSON.stringify({ success: false }) });
        const SYSTEM_TYPES = ['item_deleted', 'deny', 'admin_pending', 'report', 'warning'];
        console.log(`[NotificationRoute] Marking notifications for item ${numericId} (${rawItemId}) as read for user ${req.session.id}`);
        try {
            await db`
                UPDATE notifications
                SET is_read = true
                WHERE user_id = ${req.session.id}
                  AND item_id = ${numericId}
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

        // sessionId used for presence deduplication only — all tabs from same session connect freely
        // Soft cap: max 10 SSE connections per session (prevents runaway tab abuse)
        const MAX_TABS_PER_SESSION = 10;
        if (!isGuest) {
            const sessionClients = Array.from(clients).filter(c => c.sessionId === sessionId);
            if (sessionClients.length >= MAX_TABS_PER_SESSION) {
                // Close the oldest connection (FIFO) to free the slot
                sessionClients[0].close();
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

        const clientIp = security.getRealIP(req);
        const clientIpHash = security.hashIP(clientIp);
        const clientFp = req.session?.fingerprint || req.session?.anon_fingerprint || req.url.qs?.fp || null;
        const clientHw = getHwFingerprintEnabled() ? (req.session?.hw_fingerprint || req.url.qs?.hw || null) : null;
        const clientUserId = (req.session && typeof req.session === 'object') ? req.session.id : null;

        const client = {
            userId: clientUserId,
            session: req.session || null,
            isAnonymized: isAnonymizeSession(req.session),
            fingerprint: clientFp,
            hwFingerprint: clientHw,
            username:       req.session?.user            || null,
            display_name:   req.session?.display_name   || null,
            avatar_file:    req.session?.avatar_file    || null,
            avatar:         req.session?.avatar          || null,
            username_color: req.session?.username_color || null,
            admin:          !!req.session?.admin,
            is_moderator:   !!req.session?.is_moderator,
            receive_system_notifications: req.session?.receive_system_notifications !== false,
            receive_user_notifications: req.session?.receive_user_notifications !== false,
            do_not_disturb: req.session?.do_not_disturb === true,
            sessionId,
            tabId,
            ip: clientIp,
            ipHash: clientIpHash,
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

        // Check if connecting client is already banned
        (async () => {
            let isBanned = false;
            let banReason = 'Violation of community rules';
            let banExpires = null;

            if (client.userId) {
                const u = await db`SELECT banned, ban_reason, ban_expires FROM "user" WHERE id = ${client.userId} LIMIT 1`;
                if (u[0]?.banned) {
                    isBanned = true;
                    banReason = u[0].ban_reason || banReason;
                    banExpires = u[0].ban_expires;
                }
            }

            if (!isBanned && client.ip) {
                const ipBan = await security.isIpBanned(client.ip);
                if (ipBan) {
                    isBanned = true;
                    banReason = ipBan.reason || banReason;
                    banExpires = ipBan.expires;
                }
            }

            if (!isBanned && client.fingerprint) {
                const fpBan = await security.isFingerprintBanned(client.fingerprint);
                if (fpBan) {
                    isBanned = true;
                    banReason = fpBan.reason || banReason;
                    banExpires = fpBan.expires;
                }
            }

            if (!isBanned && client.hwFingerprint) {
                const hwBan = await security.isHardwareBanned(client.hwFingerprint);
                if (hwBan) {
                    isBanned = true;
                    banReason = hwBan.reason || banReason;
                    banExpires = hwBan.expires;
                }
            }

            if (isBanned) {
                console.log(`[SSE] Connecting client is already banned, pushing instant redirect to /banned`);
                client.send({
                    type: 'banned',
                    data: {
                        reason: banReason,
                        expires: banExpires ? (isNaN(new Date(banExpires).getTime()) ? banExpires : new Date(banExpires).toLocaleString()) : 'Permanent',
                        redirect: '/banned'
                    }
                });
                setTimeout(() => client.close(), 1000);
            }
        })().catch(err => console.error('[SSE] Initial ban check error:', err));

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


        // Track active tab (no pruning — all tabs are allowed to coexist)
        if (!isGuest) activeTabs.set(sessionId, tabId);

        clients.add(client);
        broadcastChatPresence(); // notify everyone of new user

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
            broadcastChatPresence(); // notify everyone user left
            if (activeTabs.get(sessionId) === tabId) {
                // activeTabs.delete(sessionId); // Keep it set so we know who was last active
            }
        });
    });

    // Active Signal
    router.get('/api/notifications/active', (req, res) => {
        const tabId = req.url.qs?.tabId;
        const sessionId = req.cookies?.session;

        // Track which tab is focused (informational only, no pruning)
        if (tabId && sessionId) {
            activeTabs.set(sessionId, tabId);
            return res.reply({ body: JSON.stringify({ success: true }) });
        }
        
        // For guests, this is a no-op
        return res.reply({ body: JSON.stringify({ success: true }) });
    });

    // Notification History Page
    router.get('/notifications', async (req, res) => {
        if (!req.session) return res.redirect('/login');
        const tab = (cfg.enable_comments === false) ? 'system' : (req.url.qs?.tab || 'user');
        const data = await getNotificationHistory(req.session.id, 1, 50, tab);
        data.session = req.session;
        data.hidePagination = true;
        data.pagination = {
            page: 1,
            next: data.hasMore ? 2 : null
        };
        data.link = { main: '/notifications', path: '/' };
        data.activeTab = tab;
        data.domain = cfg.main.url.domain; // For header
        data.active_mode = req.session?.mode ?? 0;
        return res.html(tpl.render('notifications', data, req));
    });

    // AJAX Notification History
    router.get('/ajax/notifications', async (req, res) => {
        if (!req.session) return res.json({
            success: false
        }, 401);
        const page = parseInt(req.url.qs.page) || 1;
        const tab = (cfg.enable_comments === false) ? 'system' : (req.url.qs.tab || null);
        const data = await getNotificationHistory(req.session.id, page, 50, tab);

        const html = tpl.render('snippets/notifications-list', { ...data, active_mode: req.session?.mode ?? 0 }, req);

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
