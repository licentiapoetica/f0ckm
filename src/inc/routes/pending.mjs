import db from "../sql.mjs";
import lib from "../lib.mjs";
import cfg from "../config.mjs";
import path from "path";
import { promises as fs, createReadStream } from "fs";
import audit from "../audit.mjs";
import { getManualApproval, getSessionOwnerName, getEnableItemSlugs } from "../settings.mjs";
import { invalidateHiddenItems } from "../hidden_items.mjs";

/**
 * pending.mjs — upload status for the uploader
 *   GET /pending                        own recent uploads with status (pending / live / denied / removed)
 *   GET /pending/t/:id.webp             thumbnail of an own pending upload (pending files are not public)
 *   POST /pending/delete                withdraw an own upload that is still pending (files + row are removed)
 *   GET /api/v2/uploads/:id/status      JSON status for API clients (session or X-Api-Key)
 */

const RECENT_LIMIT = 50;

const statusOf = (row) => {
  if (row.is_purged) return 'removed';
  if (row.is_deleted) return 'denied';
  if (row.active) return 'live';
  return 'pending';
};

const itemPath = (row) => (getEnableItemSlugs() && row.slug) ? row.slug : row.id;

// Latest moderator reason for denied/removed items (deny, delete or purge)
const reasonsFor = async (ids) => {
  if (!ids.length) return new Map();
  const rows = await db`
    select distinct on (target_id) target_id, details->>'reason' as reason
    from audit_log
    where target_id = any(${ids.map(String)}::text[])
      and action in ('deny_item', 'delete_item', 'purge_item')
    order by target_id, created_at desc
  `.catch(() => []);
  return new Map(rows.map(r => [Number(r.target_id), r.reason]));
};

// Session user, or the account behind an X-Api-Key header (for API clients)
const resolveUser = async (req) => {
  if (req.session?.id) return req.session;
  const key = req.headers['x-api-key'];
  if (!key || cfg.websrv.enable_user_api_keys === false) return null;
  const rows = await db`
    select u.id, u.user, u.login, u.admin, u.is_moderator, u.banned
    from user_api_keys k join "user" u on u.id = k.user_id
    where k.api_key = ${key} limit 1
  `.catch(() => []);
  if (!rows.length || rows[0].banned) return null;
  return rows[0];
};

const isOwnerOf = (row, session) => {
  const owner = getSessionOwnerName(session);
  return !!(row && owner && row.username && row.username.toLowerCase() === owner.toLowerCase());
};

// Every file a pending upload keeps in the pending folder (main file, thumbs, cover art, album sub-items)
const pendingFilesOf = async (row) => {
  const p = (...parts) => path.join(cfg.paths.pending, ...parts);
  const files = [p('t', `${row.id}.webp`), p('t', `${row.id}_blur.webp`), p('ca', `${row.id}.webp`)];
  if (row.dest && row.mime !== 'video/youtube') files.push(p('b', row.dest));
  if (row.is_album) {
    const subs = await db`select dest from album_items where item_id = ${row.id}`.catch(() => []);
    for (const sub of subs) {
      files.push(p('b', sub.dest), p('t', `${sub.dest.replace(/\.[^.]+$/, '')}.webp`));
    }
  }
  return files;
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  return res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
};

export default (router, tpl) => {

  router.get(/^\/pending\/?$/, async (req, res) => {
    if (!req.session) return res.redirect('/login');
    const owner = getSessionOwnerName(req.session);

    const rows = owner ? await db`
      select id, slug, mime, title, original_filename, stamp, size, active, is_deleted, is_purged, is_album, album_count, visibility
      from items
      where lower(username) = ${owner.toLowerCase()}
      order by id desc
      limit ${RECENT_LIMIT}
    ` : [];

    const reasons = await reasonsFor(rows.filter(r => r.is_deleted).map(r => r.id));
    const items = rows.map(r => {
      const status = statusOf(r);
      return {
        id: r.id,
        path: itemPath(r),
        status,
        title: r.title || r.original_filename || '',
        mime: r.mime,
        is_album: !!r.is_album,
        album_count: r.album_count || 0,
        size_fmt: r.size ? lib.formatSize(r.size) : '',
        time_ago: r.stamp ? lib.timeAgo(new Date(r.stamp * 1000), req.lang) : '',
        time_full: r.stamp ? new Date(r.stamp * 1000).toISOString() : '',
        thumb: status === 'live' ? `/t/${r.id}.webp` : (status === 'pending' ? `/pending/t/${r.id}.webp` : ''),
        reason: status === 'denied' || status === 'removed' ? (reasons.get(r.id) || '') : ''
      };
    });

    const counts = { pending: 0, live: 0, denied: 0, removed: 0 };
    items.forEach(i => { counts[i.status]++; });

    res.reply({
      body: tpl.render('pending', {
        items,
        counts,
        manual_approval_on: getManualApproval(),
        session: req.session,
        tmp: null
      }, req)
    });
  });

  // Thumbnail of an own pending upload (moderators may view any)
  router.get(/^\/pending\/t\/(?<id>\d+)\.webp$/, async (req, res) => {
    if (!req.session) return res.writeHead(401).end();
    const id = +req.params.id;
    const [row] = await db`select username, active, is_deleted from items where id = ${id} limit 1`;
    const isStaff = !!(req.session.admin || req.session.is_moderator);
    const isOwner = isOwnerOf(row, req.session);
    if (!row || row.active || row.is_deleted || !(isOwner || isStaff)) return res.writeHead(404).end();

    const file = path.join(cfg.paths.pending, 't', `${id}.webp`);
    try {
      const stat = await fs.stat(file);
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=60' });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });

  // Withdraw an own upload before a moderator has looked at it. Only the uploader, only while pending.
  router.post(/^\/pending\/delete\/?$/, async (req, res) => {
    if (!req.session) return json(res, 401, { success: false, msg: 'Login required' });
    const id = +(req.post?.id || req.body?.id || 0);
    if (!id) return json(res, 400, { success: false, msg: 'No ID provided' });

    const [row] = await db`select id, username, dest, mime, is_album, active, is_deleted, is_purged from items where id = ${id} limit 1`;
    if (!row || !isOwnerOf(row, req.session)) return json(res, 404, { success: false, msg: 'Upload not found' });
    if (row.active || row.is_deleted || row.is_purged) return json(res, 409, { success: false, msg: 'Only pending uploads can be deleted' });

    // Collect files before the row goes (album_items cascade). The active = false guard lets a concurrent
    // approval win; files are only touched once the row is gone. Cascades clear tags, notifications, reports.
    const files = await pendingFilesOf(row);
    const deleted = await db`delete from items where id = ${id} and active = false and is_deleted = false returning id`;
    if (!deleted.length) return json(res, 409, { success: false, msg: 'Upload was already reviewed' });
    invalidateHiddenItems();
    await Promise.all(files.map(f => fs.unlink(f).catch(() => {})));
    await audit.log(req.session.id, 'withdraw_item', 'item', id, { filename: row.dest, uploader_name: row.username });

    return json(res, 200, { success: true, id });
  });

  // JSON status for API clients (e.g. f0ckm-uploader polling after an upload went to manual approval)
  router.get(/^\/api\/v2\/uploads\/(?<id>\d+)\/status\/?$/, async (req, res) => {
    const user = await resolveUser(req);
    if (!user) return json(res, 401, { success: false, msg: 'Login or X-Api-Key required' });

    const id = +req.params.id;
    const [row] = await db`select id, slug, username, active, is_deleted, is_purged from items where id = ${id} limit 1`;
    const owner = getSessionOwnerName(user.is_anon !== undefined ? user : { ...user, is_anon: false });
    const isStaff = !!(user.admin || user.is_moderator);
    const isOwner = !!(row && owner && row.username && row.username.toLowerCase() === owner.toLowerCase());
    if (!row || !(isOwner || isStaff)) return json(res, 404, { success: false, msg: 'Upload not found' });

    const status = statusOf(row);
    const reason = (status === 'denied' || status === 'removed') ? ((await reasonsFor([row.id])).get(row.id) || null) : null;
    return json(res, 200, {
      success: true,
      itemid: row.id,
      slug: row.slug || null,
      status,
      reason,
      url: status === 'live' ? `${cfg.main.url.full}/${itemPath(row)}` : `${cfg.main.url.full}/pending#i${row.id}`,
      status_url: `${cfg.main.url.full}/pending#i${row.id}`
    });
  });
};
