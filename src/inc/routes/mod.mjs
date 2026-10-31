import db from "../sql.mjs";
import lib from "../lib.mjs";
import audit from "../audit.mjs";
import { invalidateHiddenItems } from "../hidden_items.mjs";
import { promises as fs } from "fs";
import cfg from "../config.mjs";
import fetch from "flumm-fetch";
import https from "https";
import path from "path";
import { getManualApproval } from "../settings.mjs";
import { moveToDeleted, safeDeleteMediaFile } from "../lib_delete.mjs";
import { setMotd } from "../motd.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import queue from "../queue.mjs";


export default (router, tpl) => {
    // Moderator Dashboard
    router.get(/^\/mod(\/)?$/, lib.modAuth, async (req, res) => {
        const pendingCount = (await db`select count(*) as c from "items" where active = false and is_deleted = false`)[0].c;
        const trashCount = (await db`select count(*) as c from "items" where active = false and is_deleted = true and is_purged = false`)[0].c;
        const reportsCount = (await db`select count(*)::int as c from reports where status = 'pending'`.catch(() => [{ c: 0 }]))[0].c;


        res.reply({
            body: tpl.render("mod", {
                session: req.session,
                pendingCount: parseInt(pendingCount),
                trashCount: parseInt(trashCount),
                reportsCount: parseInt(reportsCount) || 0,
                manualApproval: getManualApproval(),
                tmp: null
            }, req)
        });
    });

    // Moderator Reports View
    router.get(/^\/mod\/reports\/?$/, lib.modAuth, async (req, res) => {
        res.reply({
            body: tpl.render("mod_reports", {
                session: req.session,
                tmp: null
            }, req)
        });
    });

    // Approval Queue (View only — GET is safe, no state change)
    // Tag badge classes for queue cards (shared by the approval queue and soft-deleted views)
    const processQueueItems = (items) => items.map(p => ({
        ...p,
        tags: (p.tags || [])
            .filter(t => t.tag !== null)
            .map(t => {
                let badge = "badge-light";
                if (t.tag.startsWith(">")) badge = "badge-greentext badge-light";
                else if (t.normalized === "ukraine") badge = "badge-ukraine badge-light";
                else if (/[а-яё]/.test(t.normalized) || t.normalized === "russia") badge = "badge-russia badge-light";
                else if (t.normalized === "german") badge = "badge-german badge-light";
                else if (t.normalized === "dutch") badge = "badge-dutch badge-light";
                else if (t.normalized === "sfw") badge = "badge-success";
                else if (t.normalized === "nsfw") badge = "badge-danger";
                return { ...t, badge };
            })
    }));

    const QUEUE_PAGE_SIZE = 20;
    const queuePage = (req) => Math.max(1, +req.url.qs.page || 1);

    // Approval queue: uploads waiting for approval (not deleted)
    router.get(/^\/mod\/approve\/?/, lib.modAuth, async (req, res) => {
        const page = queuePage(req);
        const [{ n: total }] = await db`select count(*)::int as n from "items" where active = false and is_deleted = false`;
        const pending = await db`
            select i.id, i.mime, i.username, i.dest, i.title, i.stamp, i.size, i.width, i.height,
                   i.original_filename, i.is_album, i.album_count,
                   json_agg(json_build_object('tag', t.tag, 'normalized', t.normalized)) as tags
            from "items" i
            left join "tags_assign" ta on ta.item_id = i.id
            left join "tags" t on t.id = ta.tag_id
            where i.active = false and i.is_deleted = false
            group by i.id
            order by i.id desc
            limit ${QUEUE_PAGE_SIZE} offset ${(page - 1) * QUEUE_PAGE_SIZE}
        `;

        // Album pictures for the albums on this page (cover = order_index 0 uses the item's own files)
        const albumIds = pending.filter(p => p.is_album).map(p => p.id);
        const albumRows = albumIds.length ? await db`
            select item_id, id, dest, mime, width, height, order_index
            from album_items where item_id = any(${albumIds}::int[])
            order by item_id, order_index asc
        ` : [];
        const albumsById = new Map();
        for (const r of albumRows) {
            if (!albumsById.has(r.item_id)) albumsById.set(r.item_id, []);
            albumsById.get(r.item_id).push(r);
        }

        const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
        const mediaKind = (mime) => mime === 'video/youtube' ? 'youtube'
            : mime?.startsWith('video') ? 'video'
            : mime?.startsWith('image') ? 'image'
            : mime?.startsWith('audio') ? 'audio'
            : mime === 'application/pdf' ? 'pdf' : 'file';

        const cards = processQueueItems(pending).map(p => {
            const names = p.tags.map(t => t.normalized);
            const rating = names.includes('nsfl') ? 'nsfl' : names.includes('nsfw') ? 'nsfw' : names.includes('sfw') ? 'sfw' : 'untagged';
            // Main media (cover for albums)
            const albumRows = p.is_album ? (albumsById.get(p.id) || []) : [];
            const coverRow = albumRows.find(r => r.dest === p.dest) || albumRows.find(r => r.order_index === 0);
            const media = [{
                index: 1, aid: coverRow ? coverRow.id : null, kind: mediaKind(p.mime), mime: p.mime,
                src: `/mod/pending/b/${p.dest}`, thumb: `/mod/pending/t/${p.id}.webp`,
                width: p.width, height: p.height
            }];
            if (p.is_album) {
                const subs = albumRows.filter(r => r !== coverRow);
                for (const r of subs) {
                    media.push({
                        index: media.length + 1, aid: r.id, kind: mediaKind(r.mime), mime: r.mime,
                        src: `/mod/pending/b/${r.dest}`, thumb: `/mod/pending/t/${r.dest.replace(/\.[^.]+$/, '')}.webp`,
                        width: r.width, height: r.height
                    });
                }
            }
            return {
                ...p,
                rating,
                kind: mediaKind(p.mime),
                media,
                media_json: JSON.stringify(media),
                is_album_view: media.length > 1,
                time_ago: p.stamp ? lib.timeAgo(new Date(p.stamp * 1000), req.lang) : '',
                time_full: p.stamp ? new Date(p.stamp * 1000).toISOString() : '',
                size_fmt: p.size ? lib.formatSize(p.size) : '',
                dims: (p.width && p.height) ? `${p.width}×${p.height}` : ''
            };
        });

        res.reply({
            body: tpl.render('mod/approve', {
                pending: cards,
                total,
                page,
                pages: Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE)),
                enable_nsfl: !!cfg.enable_nsfl,
                nsfl_tag_id: nsflId,
                session: req.session,
                tmp: null
            }, req)
        });
    });

    // Soft deleted: removed items that still exist on disk and can be restored or purged
    router.get(/^\/mod\/trash\/?$/, lib.modAuth, async (req, res) => {
        const page = queuePage(req);
        const [{ n: total }] = await db`select count(*)::int as n from "items" where active = false and is_deleted = true and is_purged = false`;
        const trash = await db`
            select i.id, i.mime, i.username, i.dest,
                json_agg(json_build_object('tag', t.tag, 'normalized', t.normalized)) as tags,
                (select details->>'reason' from audit_log where target_id = i.id::text and action = 'delete_item' order by created_at desc limit 1) as delete_reason
            from "items" i
            left join "tags_assign" ta on ta.item_id = i.id
            left join "tags" t on t.id = ta.tag_id
            where i.active = false and i.is_deleted = true and i.is_purged = false
            group by i.id
            order by i.id desc
            limit ${QUEUE_PAGE_SIZE} offset ${(page - 1) * QUEUE_PAGE_SIZE}
        `;

        res.reply({
            body: tpl.render('mod/trash', {
                trash: processQueueItems(trash),
                total,
                page,
                pages: Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE)),
                session: req.session,
                tmp: null
            }, req)
        });
    });

    const jsonReply = (res, code, obj) => {
        const body = JSON.stringify(obj);
        return res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
    };

    // Move an item's media (and album sub-items) from the pending or deleted folder back to the public folders.
    const moveItemFilesToPublic = async (item, id) => {
        const movePaths = [
            { b: path.join(cfg.paths.pending, 'b', item.dest), t: path.join(cfg.paths.pending, 't', `${id}.webp`), ca: path.join(cfg.paths.pending, 'ca', `${id}.webp`) },
            { b: path.join(cfg.paths.deleted, 'b', item.dest), t: path.join(cfg.paths.deleted, 't', `${id}.webp`), ca: path.join(cfg.paths.deleted, 'ca', `${id}.webp`) }
        ];

        const isYouTube = item.mime === 'video/youtube';
        for (const p of movePaths) {
            try {
                if (isYouTube) {
                    await fs.access(p.t);
                } else {
                    await fs.access(p.b);
                }
                console.log(`[MOD MOVE] Moving files for item ${id} from ${p.b.includes('pending') ? 'pending' : 'deleted'}`);

                const moveSafe = async (src, dst) => {
                    try {
                        const lstat = await fs.lstat(src);
                        if (lstat.isSymbolicLink()) {
                            const target = await fs.readlink(src);
                            const absTarget = path.resolve(path.dirname(src), target);
                            const relTarget = path.relative(path.dirname(dst), absTarget);
                            await fs.symlink(relTarget, dst);
                            await fs.unlink(src).catch(() => {});
                        } else {
                            await fs.copyFile(src, dst);
                            await fs.unlink(src).catch(() => {});
                        }
                    } catch (e) {
                        if (e.code !== 'ENOENT') {
                            console.warn(`[MOD MOVE ERROR] Failed to move ${src} to ${dst}:`, e.message);
                        }
                    }
                };

                const bDst = path.join(cfg.paths.b, item.dest);
                const tDst = path.join(cfg.paths.t, `${id}.webp`);
                const blurDst = path.join(cfg.paths.t, `${id}_blur.webp`);
                const caDst = path.join(cfg.paths.ca, `${id}.webp`);

                if (!isYouTube) {
                    await moveSafe(p.b, bDst);
                }
                await moveSafe(p.t, tDst);
            
                const blurSrc = p.t.replace('.webp', '_blur.webp');
                await moveSafe(blurSrc, blurDst);

                if (item.mime.startsWith('audio')) {
                    await moveSafe(p.ca, caDst);
                }

                if (item.is_album) {
                    try {
                        const subItems = await db`SELECT dest FROM album_items WHERE item_id = ${id}`;
                        for (const sub of subItems) {
                            const subBase = sub.dest.replace(/\.[^.]+$/, '');
                            await moveSafe(path.join(cfg.paths.pending, 'b', sub.dest), path.join(cfg.paths.b, sub.dest));
                            await moveSafe(path.join(cfg.paths.pending, 't', `${subBase}.webp`), path.join(cfg.paths.t, `${subBase}.webp`));
                        }
                    } catch (_) {}
                }
                break;
            } catch (e) { }
        }
    };

    // Permanently remove an item's files and comments and flag it purged (admin action).
    const purgeItem = async (item, id) => {
        await safeDeleteMediaFile(item.dest, id);
        await fs.unlink(path.join(cfg.paths.t, `${id}.webp`)).catch(() => { });
        await fs.unlink(path.join(cfg.paths.t, `${id}_blur.webp`)).catch(() => { });
        await fs.unlink(path.join(cfg.paths.pending, 'b', item.dest)).catch(() => { });
        await fs.unlink(path.join(cfg.paths.pending, 't', `${id}.webp`)).catch(() => { });
        await fs.unlink(path.join(cfg.paths.deleted, 'b', item.dest)).catch(() => { });
        await fs.unlink(path.join(cfg.paths.deleted, 't', `${id}.webp`)).catch(() => { });
        await fs.unlink(path.join(cfg.paths.deleted, 't', `${id}_blur.webp`)).catch(() => { });
        if (item.mime?.startsWith('audio')) {
            await fs.unlink(path.join(cfg.paths.ca, `${id}.webp`)).catch(() => { });
            await fs.unlink(path.join(cfg.paths.pending, 'ca', `${id}.webp`)).catch(() => { });
            await fs.unlink(path.join(cfg.paths.deleted, 'ca', `${id}.webp`)).catch(() => { });
        }
        await db`update "items" set is_purged = true where id = ${id}`;
        await db`delete from comments where item_id = ${id}`;
    };

    const uploaderInfoFor = async (username) => {
        try {
            const u = await db`select id, "user" as username from "user" where login = ${username} or "user" = ${username} limit 1`;
            return u.length ? { uploader_id: u[0].id, uploader_name: u[0].username } : {};
        } catch { return {}; }
    };

    // F-005 Security: Approve action — POST with CSRF protection
    router.post(/^\/mod\/approve\/?/, lib.modAuth, async (req, res) => {
        const id = +(req.post?.id || 0);
        if (!id) {
            const body = JSON.stringify({ success: false, msg: 'No ID provided' });
            return res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
        }

        const f0ck = await db`
            select i.dest, i.mime, i.username, i.id, i.visibility, i.is_album, i.album_count,
                   (select ta2.tag_id from tags_assign ta2
                    join tags t2 on t2.id = ta2.tag_id
                    where ta2.item_id = i.id and t2.tag in ('sfw','nsfw','nsfl')
                    limit 1) as tag_id
            from "items" i
            where i.id = ${id} and i.active = false and i.is_deleted = false
            limit 1
        `;

        if (f0ck.length === 0) {
            const body = JSON.stringify({ success: false, msg: `f0ck ${id}: not in the approval queue` });
            return res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
        }

        // Fetch uploader details for audit log
        let uploaderInfo = {};
        try {
            const uploader = await db`select id, "user" as username from "user" where login = ${f0ck[0].username} or "user" = ${f0ck[0].username} limit 1`;
            if (uploader.length > 0) {
                uploaderInfo = { uploader_id: uploader[0].id, uploader_name: uploader[0].username };
            }
        } catch (err) { }

        // ACTION: Approve
        // We only proceed with side-effects (notifications/webhooks) if the update actually changed active=false to active=true.
        // This prevents duplicate webhooks from double-clicks or race conditions.
        const result = await db`update "items" set active = true, is_deleted = false where id = ${id} and active = false`;
        invalidateHiddenItems();

        if (result.count === 1) {
            // Mark pending upload notifications as read for staff
            await db`UPDATE notifications SET is_read = true WHERE type = 'admin_pending' AND item_id = ${id}`.catch(() => {});

            await audit.log(req.session.id, 'approve_item', 'item', id, { filename: f0ck[0].dest, ...uploaderInfo });

            // Notify User (WebSocket/Internal)
            try {
                const uploader = await db`select id from "user" where login = ${f0ck[0].username} or "user" = ${f0ck[0].username} limit 1`;
                if (uploader.length > 0) {
                    await db`
                        INSERT INTO notifications (user_id, type, reference_id, item_id)
                        VALUES (${uploader[0].id}, 'approve', 0, ${id})
                    `;
                }
            } catch (err) {
                console.error('[MOD APPROVE] Failed to notify user:', err);
            }

            const isPublic = (f0ck[0].visibility || 0) === 0;

            if (isPublic) {
                // Push to Discord Webhook (Direct)
                try {
                    const discordClient = cfg.clients.find(c => c.type === 'discord');
                    if (discordClient && discordClient.webhook_url) {
                        const message = `${f0ck[0].username} uploaded a new video ${cfg.main.url.full}/${id}`;
                        const payload = JSON.stringify({ content: message });
                        const url = new URL(discordClient.webhook_url);
                        const options = {
                            hostname: url.hostname,
                            path: url.pathname + url.search,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(payload)
                            }
                        };
                        const reqDiscord = https.request(options, (resDiscord) => {
                            if (resDiscord.statusCode >= 400) {
                                console.error(`[MOD APPROVE] Webhook returned status ${resDiscord.statusCode}`);
                            }
                        });
                        reqDiscord.on('error', (err) => {
                            console.error('[MOD APPROVE] Webhook failed:', err);
                        });
                        reqDiscord.write(payload);
                        reqDiscord.end();
                    }
                } catch (err) {
                    console.error('[MOD APPROVE] Discord Webhook error:', err);
                }

                // Push to Matrix Channel
                try {
                    const matrixCfg = cfg.clients.find(c => c.type === 'matrix');
                    if (matrixCfg?.notification_channel_id && router.self?.bot?.clients) {
                        const clients = await Promise.all(router.self.bot.clients);
                        const matrixWrapper = clients.find(c => c.type === 'matrix');
                        if (matrixWrapper?.client) {
                            const message = `${f0ck[0].username} uploaded a new video ${cfg.main.url.full}/${id}`;
                            await matrixWrapper.client.send(matrixCfg.notification_channel_id, message);
                            console.log(`[MOD APPROVE] Matrix notification sent for item ${id}`);
                        }
                    }
                } catch (err) {
                    console.error('[MOD APPROVE] Matrix notification error:', err);
                }

                // Broadcast new_item event for live grid updates
                try {
                    await db`SELECT pg_notify('new_item', ${JSON.stringify({
                        id: id,
                        dest: f0ck[0].dest,
                        mime: f0ck[0].mime,
                        username: f0ck[0].username,
                        tag_id: f0ck[0].tag_id,
                        is_oc: !!f0ck[0].is_oc,
                        is_album: !!f0ck[0].is_album,
                        album_count: f0ck[0].album_count || 0
                    })})`;
                } catch (err) {
                    console.error('[MOD APPROVE] new_item notify failed:', err);
                }
            }
        }

        await moveItemFilesToPublic(f0ck[0], id);

            if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                const body = JSON.stringify({ success: true, item_id: id, msg: "Item approved" });
                return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
            }

            return res.writeHead(302, { "Location": `/${id}` }).end();
    });

    // F-005 Security: Deny action — POST with CSRF protection
    router.post(/^\/mod\/deny\/?/, lib.modAuth, async (req, res) => {
        const id = +(req.post?.id || 0);
        if (!id) {
            const body = JSON.stringify({ success: false, msg: 'No ID provided' });
            return res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
        }

        const f0ck = await db`select id, dest, mime, is_deleted, active, username from "items" where id = ${id} limit 1`;
        if (f0ck.length > 0) {
            const item = f0ck[0];

            if (item.is_deleted) {
                // PURGE LOGIC (Strict Admin)
                if (!req.session.admin) {
                    const body = JSON.stringify({ success: false, msg: "Only admins can purge items permanently." });
                    return res.writeHead(403, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
                }

                await purgeItem(item, id);

                // Fetch uploader details for audit log
                let uploaderInfo = {};
                try {
                    const uploader = await db`select id, "user" as username from "user" where login = ${item.username} or "user" = ${item.username} limit 1`;
                    if (uploader.length > 0) {
                        uploaderInfo = { uploader_id: uploader[0].id, uploader_name: uploader[0].username };
                    }
                } catch (err) { }

                await audit.log(req.session.id, 'purge_item', 'item', id, { filename: item.dest, ...uploaderInfo });
                
                if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                    const body = JSON.stringify({ success: true, action: "purge", msg: "Item purged" });
                    return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
                }

                return res.reply({ success: true, action: "purge" });
            } else {
                // DENY LOGIC (Move to trash)
                const movePaths = [
                    { b: path.join(cfg.paths.pending, 'b', item.dest), t: path.join(cfg.paths.pending, 't', `${id}.webp`), ca: path.join(cfg.paths.pending, 'ca', `${id}.webp`) },
                    { b: path.join(cfg.paths.b, item.dest), t: path.join(cfg.paths.t, `${id}.webp`), ca: path.join(cfg.paths.ca, `${id}.webp`) }
                ];

                for (const p of movePaths) {
                    try {
                        await fs.access(p.b);
                        // Use safe move that handles symlink ownership
                        await moveToDeleted(item.dest, id);
                        await fs.copyFile(p.t, path.join(cfg.paths.deleted, 't', `${id}.webp`)).catch(() => { });
                        await fs.unlink(p.t).catch(() => { });
                        if (item.mime?.startsWith('audio')) {
                            await fs.copyFile(p.ca, path.join(cfg.paths.deleted, 'ca', `${id}.webp`)).catch(() => { });
                            await fs.unlink(p.ca).catch(() => { });
                        }
                        break;
                    } catch (e) { }
                }

                const reason = req.post?.reason || "Denied by moderator";

                await db`update "items" set is_deleted = true, active = false where id = ${id}`;
                await db`UPDATE notifications SET is_read = true WHERE type = 'admin_pending' AND item_id = ${id}`.catch(() => {});

                // Fetch uploader details for audit log and notification
                let uploaderId = null;
                let uploaderInfo = {};
                try {
                    const uploader = await db`select id, "user" as username from "user" where login = ${item.username} or "user" = ${item.username} limit 1`;
                    if (uploader.length > 0) {
                        uploaderId = uploader[0].id;
                        uploaderInfo = { uploader_id: uploader[0].id, uploader_name: uploader[0].username };

                        // Send Notification to User
                        await db`
                            INSERT INTO notifications (user_id, type, reference_id, item_id, data)
                            VALUES (${uploaderId}, 'deny', 0, ${id}, ${db.json({ reason })})
                        `;
                    }
                } catch (err) {
                    console.error('[MOD DENY] Failed to notify uploader:', err);
                }

                await audit.log(req.session.id, 'deny_item', 'item', id, { filename: item.dest, reason, ...uploaderInfo });

                if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                    const body = JSON.stringify({ success: true, action: "deny", msg: "Item denied" });
                    return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
                }

                return res.reply({ success: true, action: "deny" });
            }
        }
        return res.reply({ success: false, msg: "Item not found" });
    });

    // Audit Log View
    router.get(/^\/mod\/audit\/?/, lib.modAuth, async (req, res) => {
        const page = +(req.url.qs?.page || 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        const filterAction = req.url.qs?.action?.trim() || '';
        const filterUser   = req.url.qs?.user?.trim()   || '';

        const logs = await db`
            SELECT al.*, u.user as username 
            FROM audit_log al
            LEFT JOIN "user" u ON al.user_id = u.id
            WHERE true
              ${filterAction ? db`AND al.action = ${filterAction}` : db``}
              ${filterUser   ? db`AND u.user ILIKE ${'%' + filterUser + '%'}` : db``}
            ORDER BY al.created_at DESC 
            LIMIT ${limit} OFFSET ${offset}
        `;

        const totalResult = await db`
            SELECT count(*) as c
            FROM audit_log al
            LEFT JOIN "user" u ON al.user_id = u.id
            WHERE true
              ${filterAction ? db`AND al.action = ${filterAction}` : db``}
              ${filterUser   ? db`AND u.user ILIKE ${'%' + filterUser + '%'}` : db``}
        `;
        const total = totalResult[0].c;
        const pages = Math.ceil(total / limit);

        const processLogEntry = (l) => {
            const entry = { ...l };
            let details = l.details;
            if (typeof details === 'string') {
                try {
                    details = JSON.parse(details);
                } catch (e) {
                    details = {};
                }
            }

            entry.created_at_fmt = new Date(l.created_at).toLocaleString();
            // Also keep standard created_at for client side
            entry.created_at = entry.created_at_fmt;

            entry.reason = details ? details.reason : null;
            entry.old_content = details ? details.old_content : null;
            entry.new_content = details ? details.new_content : null;
            entry.item_id = details ? details.item_id : null;

            if (entry.action === 'toggle_tag' && details) {
                if (details.action === 'added') {
                    entry.new_content = details.tag;
                } else if (details.from) {
                    entry.old_content = details.from;
                    entry.new_content = details.tag;
                }
            }

            if (details && details.uploader_name) {
                entry.uploader_info = `Uploader: ${details.uploader_name} (ID: ${details.uploader_id || '?'})`;
            }

            let otherDetails = {};
            if (details && typeof details === 'object') {
                for (const [key, val] of Object.entries(details)) {
                    const isStandard = ['reason', 'old_content', 'new_content', 'item_id', 'uploader_name', 'uploader_id'].includes(key);
                    const isToggle = entry.action === 'toggle_tag' && ['tag', 'from', 'action'].includes(key);

                    if (!isStandard && !isToggle) {
                        otherDetails[key] = val;
                    }
                }
            }
            entry.details_json = Object.keys(otherDetails).length > 0 ? JSON.stringify(otherDetails) : null;

            delete entry.details;

            return entry;
        };

        if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
            const processed = logs.map(processLogEntry);
            const body = JSON.stringify({
                success: true,
                logs: processed,
                page,
                pages,
                hasMore: page < pages,
                filterAction,
                filterUser
            });
            return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
        }

        const processedLogs = logs.map(processLogEntry);

        res.reply({
            body: tpl.render("mod/audit", {
                session: req.session,
                logs: processedLogs,
                page,
                pages,
                filterAction,
                filterUser,
                tmp: null
            }, req)
        });
    });


    // Bulk Deny (POST)
    router.post(/^\/mod\/deny-multi\/?/, lib.modAuth, async (req, res) => {
        try {
            const ids = req.post.ids;
            if (!Array.isArray(ids)) throw new Error('ids must be an array');
            let count = 0;
            for (const id of ids) {
                const f0ck = await db`select id, dest, mime, is_deleted, active, username from "items" where id = ${+id} limit 1`;
                if (f0ck.length > 0) {
                    const item = f0ck[0];
                    if (item.is_deleted) {
                        // Purge (Strict Admin)
                        if (!req.session.admin) continue;

                        // Purge — respect symlink ownership
                        await safeDeleteMediaFile(item.dest, +id);
                        await fs.unlink(path.join(cfg.paths.t, `${item.id}.webp`)).catch(() => { });
                        await fs.unlink(path.join(cfg.paths.deleted, 'b', item.dest)).catch(() => { });
                        await fs.unlink(path.join(cfg.paths.deleted, 't', `${item.id}.webp`)).catch(() => { });
                        if (item.mime?.startsWith('audio')) {
                            await fs.unlink(path.join(cfg.paths.ca, `${item.id}.webp`)).catch(() => { });
                            await fs.unlink(path.join(cfg.paths.deleted, 'ca', `${item.id}.webp`)).catch(() => { });
                        }
                        await db`update "items" set is_purged = true where id = ${+id}`;
                        // Delete comments permanently on purge
                        await db`delete from comments where item_id = ${+id}`;
                        // Fetch uploader details for audit log
                        let uploaderInfo = {};
                        try {
                            const uploader = await db`select id, "user" as username from "user" where login = ${item.username} or "user" = ${item.username} limit 1`;
                            if (uploader.length > 0) {
                                uploaderInfo = { uploader_id: uploader[0].id, uploader_name: uploader[0].username };
                            }
                        } catch (err) { }

                        await audit.log(req.session.id, 'purge_item_multi', 'item', +id, { filename: item.dest, ...uploaderInfo });
                    } else {
                        // Deny (Move to trash)
                        // Deny — safe move respecting symlink ownership
                        await moveToDeleted(item.dest, +id);
                        await fs.copyFile(path.join(cfg.paths.t, `${item.id}.webp`), path.join(cfg.paths.deleted, 't', `${item.id}.webp`)).catch(() => { });
                        await fs.unlink(path.join(cfg.paths.t, `${item.id}.webp`)).catch(() => { });
                        if (item.mime?.startsWith('audio')) {
                            await fs.copyFile(path.join(cfg.paths.ca, `${item.id}.webp`), path.join(cfg.paths.deleted, 'ca', `${item.id}.webp`)).catch(() => { });
                            await fs.unlink(path.join(cfg.paths.ca, `${item.id}.webp`)).catch(() => { });
                        }
                        await db`update "items" set is_deleted = true, active = false where id = ${+id}`;
                        await db`UPDATE notifications SET is_read = true WHERE type = 'admin_pending' AND item_id = ${+id}`.catch(() => {});
                        // Fetch uploader details for audit log
                        let uploaderInfo = {};
                        try {
                            const uploader = await db`select id, "user" as username from "user" where login = ${item.username} or "user" = ${item.username} limit 1`;
                            if (uploader.length > 0) {
                                uploaderInfo = { uploader_id: uploader[0].id, uploader_name: uploader[0].username };
                            }
                        } catch (err) { }

                        await audit.log(req.session.id, 'deny_item_multi', 'item', +id, { filename: item.dest, ...uploaderInfo });
                    }
                    count++;
                }
            }
            return res.reply({ success: true, count });
        } catch (err) {
            return res.reply({ success: false, msg: lib.logError(err) }, 500);
        }
    });

    // Serve pending files (Stream with Range support)
    // Supports /mod/pending/b/filename.ext (Binaries)
    // Supports /mod/pending/t/id.webp (Thumbnails)
    router.get(/^\/mod\/pending\/(?<type>[btca])\/(?<file>.+)/, lib.modAuth, async (req, res) => {
        const { type } = req.params;
        // F-003 Security: Sanitize file parameter to prevent path traversal
        const file = path.basename(req.params.file);
        const baseDir = path.resolve(cfg.paths.pending, type);
        const filePath = path.resolve(baseDir, file);
        if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
            return res.writeHead(403).end('Forbidden');
        }

        try {
            const stats = await fs.stat(filePath);
            const fileSize = stats.size;
            const range = req.headers.range;
            const ext = file.split('.').pop();
            const mimeType = {
                'mp4': 'video/mp4', 'webm': 'video/webm',
                'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp',
                'pdf': 'application/pdf'
            }[ext] || 'application/octet-stream';

            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                const fileStream = (await import('fs')).createReadStream(filePath, { start, end });

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': mimeType,
                });
                fileStream.pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': mimeType,
                });
                (await import('fs')).createReadStream(filePath).pipe(res);
            }
        } catch (err) {
            if (err.code !== 'ENOENT') console.error(err);
            res.writeHead(404).end('File not found');
        }
    });

    // Serve deleted files (Stream with Range support)
    // Supports /mod/deleted/b/filename.ext (Binaries)
    // Supports /mod/deleted/t/id.webp (Thumbnails)
    router.get(/^\/mod\/deleted\/(?<type>[bt])\/(?<file>.+)/, lib.modAuth, async (req, res) => {
        // F-003 Security: Sanitize file parameter to prevent path traversal
        const file = path.basename(decodeURIComponent(req.params.file));
        const type = req.params.type; // 'b' or 't'
        console.log(`[MOD_STREAM] Request: type=${type}, file=${file}, range=${req.headers.range || 'none'}`);
        const baseDir = path.resolve(cfg.paths.deleted, type);
        const filePath = path.resolve(baseDir, file);
        if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
            return res.writeHead(403).end('Forbidden');
        }

        try {
            const stat = await fs.stat(filePath);
            const fileSize = stat.size;
            const range = req.headers.range;
            const ext = file.split('.').pop();
            const mimeType = {
                'mp4': 'video/mp4', 'webm': 'video/webm',
                'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp',
                'pdf': 'application/pdf'
            }[ext] || 'application/octet-stream';

            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                const fileStream = (await import('fs')).createReadStream(filePath, { start, end });

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': mimeType,
                });
                fileStream.pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': mimeType,
                });
                (await import('fs')).createReadStream(filePath).pipe(res);
            }
        } catch (err) {
            if (err.code !== 'ENOENT') console.error(err);
            res.writeHead(404).end('File not found');
        }
    });

    // Deny a single picture of a pending album. The rest stays in the queue; if the cover is denied the next
    // picture becomes the cover, and with one picture left the album is degraded to a normal single post.
    router.post(/^\/mod\/album-item\/deny\/?$/, lib.modAuth, async (req, res) => {
        const itemId = +(req.post?.item_id || 0);
        const subId = +(req.post?.album_item_id || 0);
        const reason = (req.post?.reason || '').toString().trim();
        if (!itemId || !subId) return jsonReply(res, 400, { success: false, msg: 'Missing item_id or album_item_id' });
        if (!reason) return jsonReply(res, 400, { success: false, msg: 'A reason is required' });

        const [item] = await db`select id, dest, mime, username, is_album from "items" where id = ${itemId} and active = false and is_deleted = false limit 1`;
        if (!item || !item.is_album) return jsonReply(res, 404, { success: false, msg: 'Not a pending album' });

        const subs = await db`
            select id, dest, mime, size, checksum, phash, width, height, order_index
            from album_items where item_id = ${itemId} order by order_index asc, id asc
        `;
        const target = subs.find(r => r.id === subId);
        if (!target) return jsonReply(res, 404, { success: false, msg: 'Album item not found' });
        if (subs.length <= 1) return jsonReply(res, 400, { success: false, msg: 'Only one item left, deny the whole post instead' });

        const remaining = subs.filter(r => r.id !== subId);
        const isCover = target.dest === item.dest;
        const degraded = remaining.length === 1;

        await db.begin(async sql => {
            await sql`delete from album_items where id = ${subId}`;
            for (let i = 0; i < remaining.length; i++) {
                await sql`update album_items set order_index = ${i} where id = ${remaining[i].id}`;
            }
            if (isCover) {
                const c = remaining[0];
                await sql`
                    update "items" set dest = ${c.dest}, mime = ${c.mime}, size = ${c.size},
                        checksum = ${c.checksum}, phash = ${c.phash}, width = ${c.width}, height = ${c.height}
                    where id = ${itemId}
                `;
            }
            if (degraded) {
                await sql`delete from album_items where item_id = ${itemId}`;
                await sql`update "items" set is_album = false, album_count = 0 where id = ${itemId}`;
            } else {
                await sql`update "items" set album_count = ${remaining.length} where id = ${itemId}`;
            }
        });

        // Remove the denied picture's files from the pending folders
        const base = target.dest.replace(/\.[^.]+$/, '');
        await fs.unlink(path.join(cfg.paths.pending, 'b', target.dest)).catch(() => {});
        await fs.unlink(path.join(cfg.paths.pending, 't', `${base}.webp`)).catch(() => {});
        await fs.unlink(path.join(cfg.paths.pending, 'ca', `${base}.webp`)).catch(() => {});

        // New cover: regenerate the item's main + blurred thumbnail from it
        if (isCover) {
            const c = remaining[0];
            try {
                await queue.genThumbnail(c.dest, c.mime, itemId, null, true);
                await queue.genBlurredThumbnail(itemId, true);
            } catch (err) {
                console.error('[MOD ALBUM DENY] Thumbnail regeneration failed:', err);
            }
        }

        await audit.log(req.session.id, 'deny_album_item', 'item', itemId, {
            filename: target.dest, album_item_id: subId, reason,
            remaining: remaining.length, cover_changed: isCover, degraded,
            ...(await uploaderInfoFor(item.username))
        });

        return jsonReply(res, 200, { success: true, remaining: remaining.length, cover_changed: isCover, degraded });
    });

    // ── Soft deleted: restore / purge (own endpoints, independent of the approval queue) ──

    // Restore a soft-deleted item: back to public, no "approved" notification or webhook
    router.post(/^\/mod\/trash\/restore\/?$/, lib.modAuth, async (req, res) => {
        const id = +(req.post?.id || 0);
        if (!id) return jsonReply(res, 400, { success: false, msg: 'No ID provided' });

        const rows = await db`
            select i.id, i.dest, i.mime, i.username, i.visibility, i.is_album, i.album_count, i.is_oc,
                   (select ta2.tag_id from tags_assign ta2 join tags t2 on t2.id = ta2.tag_id
                    where ta2.item_id = i.id and t2.tag in ('sfw','nsfw','nsfl') limit 1) as tag_id
            from "items" i
            where i.id = ${id} and i.is_deleted = true and i.is_purged = false
            limit 1
        `;
        if (!rows.length) return jsonReply(res, 404, { success: false, msg: `Item ${id} is not soft deleted` });
        const item = rows[0];

        const result = await db`update "items" set active = true, is_deleted = false where id = ${id} and is_deleted = true`;
        invalidateHiddenItems();
        if (result.count !== 1) return jsonReply(res, 409, { success: false, msg: 'Item was already restored' });

        await moveItemFilesToPublic(item, id);
        await audit.log(req.session.id, 'restore_item', 'item', id, { filename: item.dest, ...(await uploaderInfoFor(item.username)) });

        // Live grid update so the item reappears for open tabs
        if ((item.visibility || 0) === 0) {
            db`SELECT pg_notify('new_item', ${JSON.stringify({
                id, dest: item.dest, mime: item.mime, username: item.username, tag_id: item.tag_id,
                is_oc: !!item.is_oc, is_album: !!item.is_album, album_count: item.album_count || 0
            })})`.catch(err => console.error('[MOD RESTORE] new_item notify failed:', err));
        }

        return jsonReply(res, 200, { success: true, item_id: id, msg: 'Item restored' });
    });

    // Permanently purge one soft-deleted item (admins only)
    router.post(/^\/mod\/trash\/purge\/?$/, lib.auth, async (req, res) => {
        const id = +(req.post?.id || 0);
        if (!id) return jsonReply(res, 400, { success: false, msg: 'No ID provided' });
        const reason = (req.post?.reason || '').toString().trim();
        if (!reason) return jsonReply(res, 400, { success: false, msg: 'A reason is required' });

        const rows = await db`select id, dest, mime, username from "items" where id = ${id} and is_deleted = true and is_purged = false limit 1`;
        if (!rows.length) return jsonReply(res, 404, { success: false, msg: `Item ${id} is not soft deleted` });
        const item = rows[0];

        await purgeItem(item, id);
        await audit.log(req.session.id, 'purge_item', 'item', id, { filename: item.dest, reason, ...(await uploaderInfoFor(item.username)) });
        return jsonReply(res, 200, { success: true, item_id: id, msg: 'Item purged' });
    });

    // Purge Trash (POST) - Strict Admin
    router.post(/^\/mod\/(?:purge-trash-all|trash\/purge-all)\/?$/, lib.auth, async (req, res) => {
        try {
            // lib.auth already ensures session.admin
            const trash = await db`select id, dest, mime from "items" where active = false and is_deleted = true and is_purged = false`;
            let count = 0;
            for (const item of trash) {
                try {
                    await purgeItem(item, item.id);
                    count++;
                } catch (e) { }
            }
            await audit.log(req.session.id, 'purge_trash', 'system', 0, { count });
            const body = JSON.stringify({ success: true, count });
            return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
        } catch (err) {
            const body = JSON.stringify({ success: false, msg: 'Purge failed' });
            return res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
        }
    });

    // MOTD Routes
    router.get(/^\/mod\/motd\/?$/, lib.modAuth, async (req, res) => {
        const settings = await db`SELECT value FROM site_settings WHERE key = 'motd' LIMIT 1`;
        const motd = settings.length > 0 ? settings[0].value : '';
        res.reply({
            body: tpl.render("mod/motd", {
                session: req.session,
                motd: motd,
                tmp: null
            }, req)
        });
    });

    router.post(/^\/mod\/motd\/?$/, lib.modAuth, async (req, res) => {
        try {
            let motd = (req.post?.motd ?? '');
            
            if (motd.trim().length > 0) {
                // Append .t name suffix (display_name if set, otherwise username)
                const name = req.session.display_name || req.session.user;
                const suffix = ` t. ${name}`;
                if (!motd.endsWith(suffix)) {
                    motd = motd.trim() + suffix;
                }
            }
            
            await db`INSERT INTO site_settings (key, value) VALUES ('motd', ${motd}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

            setMotd(motd);

            // Log it in audit
            await audit.log(req.session.id, 'update_motd', 'system', 0, { motd });

            try {
                await db`SELECT pg_notify('motd', ${motd ? motd.substring(0, 7000) : ''})`;
            } catch (e) {
                console.error('[MOD MOTD] Notify failed:', e.message);
            }

            if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
                const body = JSON.stringify({ success: true, motd });
                return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
            }

            return res.writeHead(302, { "Location": "/mod/motd" }).end();
        } catch (err) {
            console.error('[MOD MOTD] Save failed:', err);
            const msg = 'Failed to save MOTD: ' + err.message;
            if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
                const body = JSON.stringify({ success: false, msg });
                return res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
            }
            return res.reply({ code: 500, body: msg });
        }
    });


    // Pin / Unpin Item
    router.post(/^\/mod\/pin\/?/, lib.modAuth, async (req, res) => {
        if (!req.url.qs?.id) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: "No ID provided" }));
        const id = +req.url.qs.id;

        const result = await db`update "items" set is_pinned = true where id = ${id} and active = true`;
        if (result.count === 1) {
            await audit.log(req.session.id, 'pin_item', 'item', id);
            return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, pinned: true }));
        }
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: "Item not found or not active" }));
    });

    router.post(/^\/mod\/unpin\/?/, lib.modAuth, async (req, res) => {
        if (!req.url.qs?.id) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: "No ID provided" }));
        const id = +req.url.qs.id;

        const result = await db`update "items" set is_pinned = false where id = ${id}`;
        if (result.count === 1) {
            await audit.log(req.session.id, 'unpin_item', 'item', id);
            return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, pinned: false }));
        }
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: "Item not found" }));
    });

    // Hall Management
    router.post(/^\/mod\/halls\/add\/?$/, lib.modAuth, async (req, res) => {
        const { id, hall, description } = req.post;
        if (!id || !hall) {
            const body = JSON.stringify({ success: false, msg: "Missing id or hall" });
            return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
        }
        
        const result = await f0cklib.addItemToHall(id, hall, req.session.id, description);
        if (result.success) {
            await audit.log(req.session.id, 'add_to_hall', 'item', +id, { hall, description });
        }
        const body = JSON.stringify({ success: result.success, msg: result.message });
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
    });

    router.post(/^\/mod\/halls\/remove\/?$/, lib.modAuth, async (req, res) => {
        const { id, hall } = req.post;
        if (!id || !hall) {
            const body = JSON.stringify({ success: false, msg: "Missing id or hall" });
            return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
        }

        const result = await f0cklib.removeItemFromHall(id, hall);
        if (result.success) {
            await audit.log(req.session.id, 'remove_from_hall', 'item', +id, { hall });
        }
        const body = JSON.stringify({ success: result.success, msg: result.message });
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
    });

    router.post(/^\/mod\/halls\/update\/?$/, lib.modAuth, async (req, res) => {
        const { hall, description } = req.post;
        if (!hall) {
            const body = JSON.stringify({ success: false, msg: "Missing hall slug" });
            return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
        }

        const result = await f0cklib.updateHallMetadata(hall, description);
        if (result.success) {
            await audit.log(req.session.id, 'update_hall_metadata', 'hall', 0, { hall, description });
        }
        const body = JSON.stringify({ success: result.success, msg: result.message });
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
    });

    // Hall Manager page (also accessible by mods)
    router.get(/^\/mod\/halls\/?$/, lib.modAuth, async (req, res) => {
        const hallsList = await f0cklib.getHalls();
        res.reply({
            body: tpl.render('admin/halls', {
                session: req.session,
                hallsList,
                tmp: null
            }, req)
        });
    });

    return router;
};
