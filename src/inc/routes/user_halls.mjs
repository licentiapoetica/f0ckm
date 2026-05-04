import db from "../sql.mjs";
import cfg from "../config.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

const slugify = (s) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Simple auth guard — redirects to login page for browser, 401 for API calls
const requireLogin = (req, res) => {
  if (req.session) return true;
  const isApi = req.url.pathname.startsWith('/api/');
  if (isApi) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Login required' }));
  } else {
    res.writeHead(302, { Location: '/login' }).end();
  }
  return false;
};

// ── Helper: resolve user hall, checking privacy ──────────────────────────────
const resolveHall = async (ownerName, slug, viewerSession) => {
  const hall = await f0cklib.getUserHallByOwnerName(ownerName, slug);
  if (!hall) return null;
  // Private check: only owner or admin can see private halls
  if (hall.is_private) {
    const isOwner = viewerSession && viewerSession.user?.toLowerCase() === ownerName.toLowerCase();
    const isAdmin = viewerSession && viewerSession.admin;
    if (!isOwner && !isAdmin) return null;
  }
  return hall;
};

export default (router, tpl) => {

  // ── Public browse routes ────────────────────────────────────────────────────

  // List halls for a user
  router.get(/^\/user\/(?<owner>[^/]+)\/halls\/?$/, async (req, res) => {
    if (cfg.websrv.userhalls_enabled === false) return res.reply({ code: 404, body: tpl.render('error', { message: 'Not found', tmp: null }, req) });
    const ownerName = decodeURIComponent(req.params.owner);
    const mode = req.mode ?? 0;
    const excludedTags = req.session ? (req.session.excluded_tags || []) : [];

    // Resolve owner user record
    const ownerRow = (await db`SELECT id, "user", admin FROM "user" WHERE "user" ILIKE ${ownerName} LIMIT 1`)[0];
    if (!ownerRow) {
      return res.reply({ code: 404, body: tpl.render('error', { message: 'User not found', tmp: null }, req) });
    }

    const viewerUserId = req.session?.id ?? null;
    const hallsList = await f0cklib.getUserHalls(ownerRow.id, mode, excludedTags, viewerUserId);
    const isOwner = viewerUserId === ownerRow.id;

    const data = {
      hallsList,
      ownerUser: ownerRow,
      isOwner,
      tmp: null,
      hidePagination: true,
      session: req.session ? { ...req.session } : false,
      page_meta: {
        title: `${ownerRow.user}'s Halls`,
        description: `Browse ${ownerRow.user}'s personal collections`,
        url: `https://${cfg.main.url.domain}/user/${encodeURIComponent(ownerRow.user)}/halls`
      }
    };

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.reply({ body: tpl.render('user-halls-partial', data, req) });
    }
    return res.reply({ body: tpl.render('user-halls', data, req) });
  });

  // Item grid for a user hall
  router.get(/^\/user\/(?<owner>[^/]+)\/hall\/(?<slug>[^/]+)(?:\/p\/(?<page>\d+))?\/?$/, async (req, res) => {
    if (cfg.websrv.userhalls_enabled === false) return res.reply({ code: 404, body: tpl.render('error', { message: 'Not found', tmp: null }, req) });
    const ownerName = decodeURIComponent(req.params.owner);
    const slug = decodeURIComponent(req.params.slug);

    const hall = await resolveHall(ownerName, slug, req.session);
    if (!hall) {
      return res.reply({ code: 404, body: tpl.render('error', { message: 'Hall not found', tmp: null }, req) });
    }

    const data = await f0cklib.getf0cks({
      page: req.params.page,
      mode: req.mode,
      session: !!req.session,
      exclude: req.session?.excluded_tags || [],
      user_id: req.session?.id,
      userHall: slug,
      userHallOwner: ownerName,
      mime: req.cookies.mime || null,
      random: req.cookies.random_mode === '1'
    });

    if (!data.success) {
      data.items = [];
      data.pagination = { start: 1, end: 1, current: 1, page: 1, cheat: [1], prev: null, next: null };
      data.total = 0;
      data.success = true;
      data.link = { main: `/user/${encodeURIComponent(hall.owner_name)}/hall/${encodeURIComponent(hall.slug)}/`, path: 'p/', suffix: '' };
      data.tmp = { userHall: hall, userHallOwner: hall.owner_name };
    }

    data.session = req.session ? { ...req.session } : false;
    data.isOwner = !!(req.session && req.session.id === hall.user_id);
    data.page_meta = {
      title: `${hall.name} — ${hall.owner_name}'s Hall`,
      description: hall.description || `${hall.owner_name}'s collection`,
      url: `https://${cfg.main.url.domain}/user/${encodeURIComponent(hall.owner_name)}/hall/${encodeURIComponent(hall.slug)}`
    };

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.reply({ body: tpl.render('index-partial', data, req) });
    }
    return res.reply({ body: tpl.render('index', data, req) });
  });

  // Single item within a user hall
  router.get(/^\/user\/(?<owner>[^/]+)\/hall\/(?<slug>[^/]+)\/(?<itemid>\d+)\/?$/, async (req, res) => {
    if (cfg.websrv.userhalls_enabled === false) return res.reply({ code: 404, body: tpl.render('error', { message: 'Not found', tmp: null }, req) });
    const ownerName = decodeURIComponent(req.params.owner);
    const slug = decodeURIComponent(req.params.slug);

    const hall = await resolveHall(ownerName, slug, req.session);
    if (!hall) {
      return res.reply({ code: 404, body: tpl.render('error', { message: 'Hall not found', tmp: null }, req) });
    }

    const data = await f0cklib.getf0ck({
      itemid: req.params.itemid,
      mode: req.mode,
      session: !!req.session,
      exclude: req.session?.excluded_tags || [],
      user_id: req.session?.id,
      userHall: slug,
      userHallOwner: ownerName,
      mime: req.cookies.mime || null,
      random: req.cookies.random_mode === '1'
    });

    if (!data.success) {
      return res.reply({
        code: data.item ? 200 : 404,
        body: tpl.render('error', { message: data.message, item: data.item, tmp: null }, req)
      });
    }

    data.hidePagination = true;
    data.session = req.session ? { ...req.session } : false;

    // Precompute boolean helpers for template @if() — must match index.mjs pattern
    if (data.item) {
      const session = data.session;
      const item = data.item;
      data.is_mod_or_admin = !!(session && (session.admin || session.is_moderator));
      data.can_manage_item = !!(session && (session.admin || session.is_moderator || session.user === item.username));
      data.can_extract_meta = !!(item.mime && item.mime.indexOf('flash') === -1 && item.mime.indexOf('youtube') === -1);
      data.user_has_favorited = !!(session && Array.isArray(item.favorites) && item.favorites.some(f => f.user === session.user));
      data.halls_slugs = Array.isArray(item.halls) ? item.halls.map(h => h.slug).join(',') : '';
      data.user_halls_slugs = Array.isArray(item.user_halls) ? item.user_halls.map(h => h.slug).join(',') : '';
      data.item_rating_class = item.is_nsfl ? 'is-nsfl' : (item.is_nsfw ? 'is-nsfw' : (item.is_sfw ? 'is-sfw' : 'is-untagged'));
      data.item_rating_label = item.is_nsfl ? 'NSFL' : (item.is_nsfw ? 'NSFW' : (item.is_sfw ? 'SFW' : '?'));
      data.item_username_lower = (item.username || '').toLowerCase();
      data.is_flash_item = !!(item.mime && (item.mime.indexOf('flash') !== -1 || item.mime.indexOf('shockwave') !== -1));
      data.current_hall_slug = (data.tmp && data.tmp.hall && typeof data.tmp.hall === 'object') ? data.tmp.hall.slug : (data.tmp && data.tmp.hall ? data.tmp.hall : '');
      data.current_user_hall_slug = (data.tmp && data.tmp.userHall && typeof data.tmp.userHall === 'object') ? data.tmp.userHall.slug : (data.tmp && data.tmp.userHall ? data.tmp.userHall : '');
      data.current_user_hall_owner = (data.tmp && data.tmp.userHallOwner) ? data.tmp.userHallOwner : '';
    }

    // Precompute hall display
    if (data.item?.halls?.length) {
      data.item.primaryHall = data.item.halls[0];
      data.item.otherHalls = data.item.halls.slice(1);
    } else if (data.item) {
      data.item.primaryHall = null;
      data.item.otherHalls = [];
    }

    if (req.session || !cfg.main.hide_comments_from_public) {
      if (req.session?.id) f0cklib.markNotificationsRead(req.session.id, req.params.itemid).catch(() => {});
      data.isSubscribed = req.session ? await f0cklib.getSubscriptionStatus(req.session.id, req.params.itemid) : false;

      // xD Score
      const commentsForScore = await f0cklib.getComments(req.params.itemid, 'old', false);
      const xdScore = f0cklib.computeXdScore(commentsForScore);
      const xdMeta  = f0cklib.xdScoreMeta(xdScore);
      data.item.xd_score = xdScore;
      data.item.xd_tier  = xdMeta.tier;
      data.item.xd_label = xdMeta.label;

      // Comments loaded async by client
      data.commentsJSON = null;
      data.comments = [];
    } else {
      data.comments = [];
      data.isSubscribed = false;
      data.commentsJSON = null;
      data.item.xd_score = 0;
      data.item.xd_tier  = 0;
      data.item.xd_label = '';
    }

    return res.reply({ body: tpl.render('item', data, req) });
  });

  // ── Thumbnail route ─────────────────────────────────────────────────────────
  router.get(/^\/user_hall_image\/(?<userId>\d+)\/(?<slug>.+)$/, async (req, res) => {
    const userId = +req.params.userId;
    const slug = decodeURIComponent(req.params.slug);
    // F-016 Security: Sanitize slug to prevent path traversal
    const safeSlug = path.basename(slug);
    const mode = +(req.url.qs?.m ?? 0);

    const CUSTOM_DIR = path.join(cfg.paths.s, '../hall_custom');
    const CACHE_DIR = path.join(cfg.paths.s, '../hall_cache');
    const customPath = path.join(CUSTOM_DIR, `u_${userId}_${safeSlug}.webp`);

    try {
      // 1. Serve custom image if present
      try {
        const stat = await fs.stat(customPath);
        const etag = '"' + stat.mtimeMs.toString(16) + '-' + stat.size.toString(16) + '"';
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304); return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-cache', 'ETag': etag });
        return res.end(await fs.readFile(customPath));
      } catch (_) { /* no custom image */ }

      // 2. Check mosaic cache
      const hash = createHash('md5').update(`uh_${userId}_${safeSlug}_${mode}`).digest('hex');
      const cachePath = path.join(CACHE_DIR, `${hash}.webp`);
      try {
        await fs.access(cachePath);
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600' });
        return res.end(await fs.readFile(cachePath));
      } catch (_) {}

      // 3. Generate mosaic
      const hall = await f0cklib.getUserHall(userId, slug);
      if (!hall) { res.writeHead(302, { Location: '/s/img/favicon.gif' }); return res.end(); }

      let modeFilter = db``;
      if (mode === 0) modeFilter = db`JOIN tags_assign ta_sfw ON ta_sfw.item_id = i.id AND ta_sfw.tag_id = 1`;
      else if (mode === 1) modeFilter = db`JOIN tags_assign ta_nsfw ON ta_nsfw.item_id = i.id AND ta_nsfw.tag_id = 2`;

      const items = await db`
        SELECT i.id
        FROM items i
        JOIN user_halls_assign uha ON uha.item_id = i.id
        ${modeFilter}
        WHERE uha.hall_id = ${hall.id} AND i.active = true
        ORDER BY RANDOM()
        LIMIT 3
      `;

      if (items.length > 0) {
        const inputs = items.map(item => path.join(cfg.paths.t, `${item.id}.webp`));
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await execFile('magick', [
          ...inputs, '+append', '-background', 'none',
          '-resize', '300x150^', '-gravity', 'center', '-extent', '300x150', cachePath
        ]);
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600' });
        return res.end(await fs.readFile(cachePath));
      }
    } catch (e) {
      console.error('[USER_HALL_IMAGE]', e);
    }
    res.writeHead(302, { Location: '/s/img/favicon.gif' });
    res.end();
  });

  // ── API: list own halls (for modal) ────────────────────────────────────────
  router.get(/^\/api\/v2\/me\/halls\/?$/, async (req, res) => {
    if (cfg.websrv.userhalls_enabled === false) return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false }));
    if (!requireLogin(req, res)) return;
    try {
      const halls = await f0cklib.getUserHalls(req.session.id, 3, [], req.session.id);
      const body = JSON.stringify({ success: true, halls });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    } catch (e) {
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false }));
    }
  });

  // ── API: create hall ────────────────────────────────────────────────────────
  router.post(/^\/api\/v2\/me\/halls\/?$/, async (req, res) => {
    if (cfg.websrv.userhalls_enabled === false) return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false }));
    if (!requireLogin(req, res)) return;
    const name = (req.post.name || '').trim();
    const slug = slugify(req.post.slug || name);
    const description = (req.post.description || '').trim() || null;

    if (!name || !slug) {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ success: false, msg: 'Name is required' }));
    }

    const result = await f0cklib.createUserHall(req.session.id, name, slug, description);
    const status = result.success ? 200 : 409;
    return res.writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(result));
  });

  // ── API: update hall ────────────────────────────────────────────────────────
  router.patch(/^\/api\/v2\/me\/halls\/(?<slug>[^/]+)\/?$/, async (req, res) => {
    if (cfg.websrv.userhalls_enabled === false) return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false }));
    if (!requireLogin(req, res)) return;
    const slug = decodeURIComponent(req.params.slug);
    const { name, slug: newSlugRaw, description, is_private } = req.post;
    const newSlug = newSlugRaw ? slugify(newSlugRaw) : undefined;

    const result = await f0cklib.updateUserHall(req.session.id, slug, {
      name,
      newSlug,
      description,
      is_private: is_private !== undefined ? (is_private === true || is_private === 'true' || is_private === 1) : undefined
    });
    const status = result.success ? 200 : 400;
    return res.writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(result));
  });

  // ── API: delete hall ────────────────────────────────────────────────────────
  router.delete(/^\/api\/v2\/me\/halls\/(?<slug>[^/]+)\/?$/, async (req, res) => {
    if (cfg.websrv.userhalls_enabled === false) return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false }));
    if (!requireLogin(req, res)) return;
    const slug = decodeURIComponent(req.params.slug);

    // Admins can also delete on behalf of any user if they pass ?user_id=
    let targetUserId = req.session.id;
    if (req.session.admin && req.url.qs?.user_id) {
      targetUserId = +req.url.qs.user_id;
    }

    const result = await f0cklib.deleteUserHall(targetUserId, slug);

    // Clean up custom image if it exists
    // F-016 Security: Sanitize slug to prevent path traversal in file deletion
    const safeSlug = path.basename(slug);
    const CUSTOM_DIR = path.join(cfg.paths.s, '../hall_custom');
    fs.unlink(path.join(CUSTOM_DIR, `u_${targetUserId}_${safeSlug}.webp`)).catch(() => {});

    return res.writeHead(result.success ? 200 : 404, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(result));
  });

  // ── API: add item to hall ────────────────────────────────────────────────────
  router.post(/^\/api\/v2\/me\/halls\/(?<slug>[^/]+)\/items\/?$/, async (req, res) => {
    if (!requireLogin(req, res)) return;
    const slug = decodeURIComponent(req.params.slug);
    const itemId = +req.post.item_id;

    if (!itemId) {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ success: false, msg: 'Missing item_id' }));
    }

    const hall = await f0cklib.getUserHall(req.session.id, slug);
    if (!hall) {
      return res.writeHead(404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ success: false, msg: 'Hall not found' }));
    }

    const result = await f0cklib.addItemToUserHall(hall.id, itemId, req.session.id);
    return res.writeHead(result.success ? 200 : 409, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(result));
  });

  // ── API: remove item from hall ──────────────────────────────────────────────
  router.delete(/^\/api\/v2\/me\/halls\/(?<slug>[^/]+)\/items\/(?<itemid>\d+)\/?$/, async (req, res) => {
    if (!requireLogin(req, res)) return;
    const slug = decodeURIComponent(req.params.slug);
    const itemId = +req.params.itemid;

    const hall = await f0cklib.getUserHall(req.session.id, slug);
    if (!hall) {
      return res.writeHead(404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ success: false, msg: 'Hall not found' }));
    }

    const result = await f0cklib.removeItemFromUserHall(hall.id, itemId);
    return res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(result));
  });

  // ── API: upload custom hall image (handled via bypass middleware in index.mjs) ─
  // This stub is never reached for multipart uploads — the bypass intercepts first.
  router.post(/^\/api\/v2\/me\/halls\/(?<slug>[^/]+)\/image\/?$/, async (req, res) => {
    if (!requireLogin(req, res)) return;
    return res.writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ success: false, msg: 'Send as multipart/form-data' }));
  });

  // ── API: delete custom hall image (can go through normal router) ─────────
  router.delete(/^\/api\/v2\/me\/halls\/(?<slug>[^/]+)\/image\/?$/, async (req, res) => {
    if (!requireLogin(req, res)) return;
    const slug = decodeURIComponent(req.params.slug);
    const hall = await f0cklib.getUserHall(req.session.id, slug);
    if (!hall) {
      return res.writeHead(404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ success: false, msg: 'Hall not found' }));
    }

    // F-016 Security: Sanitize slug to prevent path traversal in file deletion
    const safeSlug = path.basename(slug);
    const CUSTOM_DIR = path.join(cfg.paths.s, '../hall_custom');
    const CACHE_DIR = path.join(cfg.paths.s, '../hall_cache');
    await fs.unlink(path.join(CUSTOM_DIR, `u_${req.session.id}_${safeSlug}.webp`)).catch(() => {});
    // Clear mosaic cache entries for all modes
    for (const m of [0, 1, 2]) {
      const h = createHash('md5').update(`uh_${req.session.id}_${safeSlug}_${m}`).digest('hex');
      await fs.unlink(path.join(CACHE_DIR, `${h}.webp`)).catch(() => {});
    }
    await db`UPDATE user_halls SET custom_image = false WHERE id = ${hall.id}`;
    return res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ success: true }));
  });

  return router;
};
