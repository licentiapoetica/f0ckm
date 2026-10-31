import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import { createI18n } from "../i18n.mjs";
import { render502 } from "../private_items.mjs";
import { canAnonDo, canAnonMode, isAnonSession, isAnonymizeSession, getSessionOwnerName, isOnaraEnabledFor, getHashUserIps, getLogUserIps, getEnableAnonymousAccess, getHwFingerprintEnabled } from "../settings.mjs";
import { getRetention } from "../retention.mjs";
import { getIpHashSource } from "../security.mjs";

const auth = async (req, res, next) => {
  if (!req.session)
    return res.redirect("/login");
  return next();
};

export default (router, tpl) => {
  router.get(/^\/user\/(?<user>[^/]+)\/?$/, async (req, res) => {
    // When anonymization is active, user profiles must not be accessible without an authenticated regular session
    // But allow anon users to view their own profile
    if (isAnonymizeSession(req.session)) {
      const requestedUser = decodeURIComponent(req.params.user).toLowerCase();
      // Anon sessions have user = 'anonymous'; their real profile name is the shadow login (anon_xxxx)
      const isSelf = !!req.session && (
        requestedUser === (req.session.user || '').toLowerCase() ||
        requestedUser === (req.session.login || '').toLowerCase()
      );
      if (!isSelf) {
        return req.session ? res.redirect('/') : res.redirect('/login');
      }
    }
    const user = decodeURIComponent(req.params.user);
    const mime = req.cookies.mime !== undefined ? req.cookies.mime : (req.query?.mime || req.url.qs?.mime || null);

    const query = await db`
      select "user".id, "user".login, "user".user, "user".admin, "user".is_moderator, "user".banned, "user".ban_expires, "user".created_at, user_options.*, user_options.display_name
      from "user"
      left join user_options on "user".id = user_options.user_id
      where "user".user ilike ${user} OR "user".login ilike ${user}
      limit 1
    `;

    let userData = query[0];

    if (!userData) {
      // Fallback: Check if user exists as a "Ghost" (uploading in items table but no account)
      const ghostQuery = await db`
        SELECT username, MIN(stamp) as first_upload
        FROM items
        WHERE username ILIKE ${user} AND active = true
        GROUP BY username
        LIMIT 1
      `;

      if (ghostQuery.length) {
        userData = {
          id: null,
          user: user,
          created_at: new Date(ghostQuery[0].first_upload * 1000),
          activated: true,
          banned: false,
          is_ghost: true
        };
      } else {
        return res.reply({
          code: 404,
          body: tpl.render('error', {
            message: 'this user does not exists',
            tmp: null
          }, req)
        });
      }
    }

    let f0cks, favs;
    const count = {
      f0cks: 0,
      favs: 0,
      tags: 0
    };
    try {
      const isRandom = req.cookies.random_mode === '1';
      const ratingsRaw = req.cookies.ratings;
      // In All mode (mode=3), ignore the ratings cookie — it would otherwise
      // filter out e.g. NSFW uploads even though the user is in "All" mode.
      const ratingsArr = (req.mode === 3) ? null : (ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null);
      f0cks = await f0cklib.getf0cks({
        user: user,
        mode: req.mode,
        ratings: ratingsArr,
        mime: mime,
        fav: false,
        session: req.session,
        user_id: req.session?.id,
        random: isRandom
      });
      if ('items' in f0cks) {
        count.f0cks = f0cks.total ?? f0cks.items.length;
        f0cks.items = f0cks.items.slice(0, 12);
      }
    } catch (err) {
      console.error('[PROFILE] getf0cks failed for user:', user, err);
      f0cks = false;
      count.f0cks = 0;
    }
    if (!userData.is_ghost) {
      try {
        const isRandom = req.cookies.random_mode === '1';
        const ratingsRaw = req.cookies.ratings;
        // In All mode (mode=3), ignore the ratings cookie — a stale ratings cookie
        // (e.g. only 'sfw') would cause NSFW favorites to show 0 on the profile.
        const ratingsArr = (req.mode === 3) ? null : (ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null);
        favs = await f0cklib.getf0cks({
          user: user,
          mode: req.mode,
          ratings: ratingsArr,
          mime: mime,
          fav: true,
          session: req.session,
          user_id: req.session?.id,
          is_admin: req.session?.admin,
          random: isRandom
        });
        if (favs && 'items' in favs) {
          count.favs = favs.total ?? favs.items.length;
          favs.items = favs.items.slice(0, 12);
        }
      } catch (err) {
        favs = false;
        count.favs = 0;
      }
    }

    if (!userData.is_ghost) {
      try {
        const [comms, tags, halls] = await Promise.all([
          db`
            select count(*) 
            from comments c
            join items i on c.item_id = i.id
            where c.user_id = ${userData.id} 
            and c.is_deleted = false
            and i.active = true 
            and i.is_deleted = false
          `,
          db`
            select count(*)
            from tags_assign
            where user_id = ${userData.id}
            and tag_id > 2
          `,
          db`
            select count(*)
            from user_halls
            where user_id = ${userData.id}
          `
        ]);
        count.comments = +comms[0].count;
        count.tags = +tags[0].count;
        count.halls = +halls[0].count;
      } catch (e) {
        count.comments = count.comments || 0;
        count.tags = 0;
      }
    }

    userData.timestamp = {
      timeago: lib.timeAgo(userData.created_at, req.lang),
      timefull: new Date(userData.created_at).toISOString()
    };
    userData.age_days = Math.floor((Date.now() - new Date(userData.created_at).getTime()) / 86400000);

    if (!req.session) {
      userData.banned = false;
      delete userData.ban_expires;
      delete userData.ban_duration;
    } else if (userData.banned) {
      if (!userData.ban_expires) {
        userData.ban_duration = "Permanent";
      } else {
        const diff = ~~((new Date(userData.ban_expires) - new Date()) / 1e3);
        if (diff <= 0) {
          userData.ban_duration = "Expiration pending refresh";
        } else {
          const epochs = [
            ["year", 31536000],
            ["month", 2592000],
            ["week", 604800],
            ["day", 86400],
            ["hour", 3600],
            ["minute", 60],
            ["second", 1]
          ];
          let durationStr = "Expires in ";
          for (let [name, seconds] of epochs) {
            const interval = ~~(diff / seconds);
            if (interval >= 1) {
              durationStr += `${interval} ${name}${interval === 1 ? "" : "s"}`;
              break;
            }
          }
          userData.ban_duration = durationStr;
        }
      }
    }

    const data = {
      user: userData,
      f0cks,
      count,
      favs,
      tmp: null,
      session: req.session ? { ...req.session } : false,
      page_meta: {
        title: userData.user,
        description: userData.is_ghost ? `${count.f0cks} legacy uploads` : `${count.f0cks} uploads, ${count.favs} favorites`,
        url: `https://${cfg.main.url.domain}/user/${encodeURIComponent(userData.user)}`,
        image: userData.avatar_file
          ? `https://${cfg.main.url.domain}/a/${userData.avatar_file}`
          : userData.avatar
            ? `https://${cfg.main.url.domain}/t/${userData.avatar}.webp`
            : `https://${cfg.main.url.domain}/a/default.png`
      }
    };

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.reply({ body: tpl.render('user-partial', data, req) });
    }

    return res.reply({ body: tpl.render('user', data, req) });
  });

  /* <routing-refactor> */
  const handleGenericRoute = async (req, res) => {
    const tRouteStart = Date.now();
    const mode = req.params.itemid ? 'item' : 'index';

    // Feature flag guards for disabled features
    if (cfg.websrv.halls_enabled === false && req.params.hall) {
      return res.reply({ code: 404, body: tpl.render('error', { message: 'Not found', tmp: null }, req) });
    }

    // Redirect anonymous users requesting /user/anonymous/favs to their personal shadow username favs
    if (req.params.mode === 'favs' && req.params.user?.toLowerCase() === 'anonymous' && req.session?.is_anon && req.session?.login) {
      res.writeHead(302, { Location: `/user/${encodeURIComponent(req.session.login.toLowerCase())}/favs` });
      return res.end();
    }

    // When anonymization is active, user gallery pages must require authentication and hide other users
    if (isAnonymizeSession(req.session) && req.params.user && req.params.mode) {
      const targetUser = decodeURIComponent(req.params.user).toLowerCase();
      const isSelf = req.session?.user && (
        targetUser === req.session.user.toLowerCase() ||
        (req.session.login && targetUser === req.session.login.toLowerCase())
      );
      if (!isSelf) {
        return req.session ? res.redirect('/') : res.redirect('/login');
      }
    }

    // Auto-persist strict mode from URL to session if it's there
    if (req.session && (req.query?.strict !== undefined || req.url.qs?.strict !== undefined)) {
      req.session.strict_mode = (req.query?.strict === '1' || req.url.qs?.strict === '1');
    }

    // Decode tag param once — browsers send title%3A... on hard reload, title:... via AJAX
    const reqTag = req.params.tag ? decodeURIComponent(req.params.tag) : req.params.tag;

    // Track tag browsing interest in user affinity profile
    if (reqTag && req.session?.id && !reqTag.startsWith('title:')) {
      f0cklib.updateUserTagAffinity({ user_id: req.session.id, tag: reqTag, scoreDelta: 2.0 }).catch(() => {});
    }

    const bypassFilter = !!(req.query?.force === '1' || req.query?.allow === '1' || req.query?.bypass === '1' || req.url.qs?.force === '1' || req.url.qs?.allow === '1' || req.url.qs?.bypass === '1' || req.query?.see_anyways === '1' || req.url.qs?.see_anyways === '1');

    const data = await (req.params.itemid ? f0cklib.getf0ck : f0cklib.getf0cks)({
      user: req.params.user,
      tag: reqTag,
      mime: req.cookies.mime !== undefined ? req.cookies.mime : (req.query?.mime || req.url.qs?.mime || req.params.mime || null),
      page: req.params.page,
      itemid: req.params.itemid,
      hall: req.params.hall,
      fav: req.params.mode == 'favs',
      mode: req.mode,
      bypass_filter: bypassFilter,
      ratings: (() => { if (req.mode === 2 || req.mode === 3) return null; const r = req.cookies.ratings; return r ? decodeURIComponent(r).split(/[|,]/).filter(x => ['sfw','nsfw','nsfl','untagged'].includes(x)) : null; })(),
      session: req.session,
      user_id: req.session?.id,
      is_admin: req.session?.admin,
      exclude: req.session ? (req.session.excluded_tags || []) : [],
      url: decodeURIComponent(req.url.pathname || req.url),
      strict: !!(req.query?.strict || req.url.qs?.strict || req.session?.strict_mode),
      explicitStrict: !!(req.query?.strict || req.url.qs?.strict),
      random: req.cookies.random_mode === '1',
      minXdScore: req.params.itemid ? 0 : (req.url.qs?.min_xd !== undefined ? +req.url.qs.min_xd : (req.session?.min_xd_score || 0)),
      lang: req.lang,
      tagger: req.url.qs?.tagger || null,
      subf0ck: req.query?.subf0ck || req.url.qs?.subf0ck || null
    });
    console.log(`[DEBUG] Checking strict mode: query=${req.query?.strict}, session=${req.session?.strict_mode}, effective=${!!(req.query?.strict || req.url.qs?.strict || req.session?.strict_mode)}`);
    console.log(`[${new Date().toISOString()}] [ROUTE] Data fetch complete in ${Date.now() - tRouteStart}ms`);

    if (!data.success) {
      if (data.is_private && !req.session && (mode === 'item' || data.message === '403 - private upload')) {
        render502(req, res);
        return;
      }
      if (data.is_private && (data.message === 'private favorites' || req.params.mode === 'favs')) {
        const { t: tErr } = createI18n(req.session?.language || req.lang || 'en');
        return res.reply({
          code: 403,
          body: tpl.render('error', {
            message: tErr('profile.private_favorites'),
            domain: cfg.main.url.domain,
            tmp: null,
            session: req.session ? { ...req.session } : false,
            error_filter_hint: null,
            error_filter_hint_link: null
          }, req)
        });
      }
      // For index/grid views with zero items (empty DB), render an empty grid instead of error
      if (mode !== 'item') {
        data.items = [];
        data.pagination = { start: 1, end: 1, current: 1, page: 1, cheat: [1], prev: null, next: null };
        data.total = 0;
        data.success = true;
        if (!data.link) {
          if (req.params.hall) data.link = { main: '/h/' + encodeURIComponent(req.params.hall) + '/', path: 'p/', suffix: '' };
          else if (reqTag) data.link = { main: '/tag/' + encodeURIComponent(reqTag) + '/', path: 'p/', suffix: '' };
          else data.link = { main: '/', path: 'p/', suffix: '' };
        }
        data.tmp = data.tmp || {};
        if (req.params.hall && !data.tmp.hall) {
          const hallRow = await db`SELECT id, name, slug, description FROM halls WHERE slug = ${req.params.hall} LIMIT 1`;
          data.tmp.hall = hallRow.length ? hallRow[0] : req.params.hall;
        }
        if (reqTag && !data.tmp.tag) data.tmp.tag = reqTag;
      } else {
        // Return 200 for filtered NSFW items (has item data) so Discord parses og:image
        // Return 404 only for truly missing items
        const statusCode = data.item ? 200 : 404;
        const reqMode = req.mode ?? 0;
        const modeLabels = { 0: 'SFW', 1: 'NSFW', 2: 'Untagged', 4: 'NSFL' };
        const errorModeLabel = reqMode !== 3 ? (modeLabels[reqMode] || 'SFW') : null;
        const { t: tErr } = createI18n(req.session?.language || req.lang || 'en');
        return res.reply({
          code: statusCode,
          body: tpl.render('error', {
            message: tErr('error.post_not_visible'),
            item: data.item, // For OG meta tags on filtered NSFW items
            item_id: data.item?.id || req.params.itemid,
            item_slug: data.item?.slug || (typeof req.params.itemid === 'string' ? req.params.itemid : null),
            domain: cfg.main.url.domain,
            tmp: null,
            session: req.session ? { ...req.session } : false,
            error_mode_label: errorModeLabel,
            error_filter_hint: errorModeLabel ? tErr('error.filter_hint', { mode: `<strong>${errorModeLabel}</strong>` }) : null,
            error_filter_hint_link: tErr('error.filter_hint_link'),
            error_see_anyways: tErr('error.see_anyways')
          }, req)
        });
      }
    }

    if (mode === 'item') {
      data.hidePagination = true;
      // Precompute hall display data for the template
      if (data.item && data.item.halls && data.item.halls.length) {
        const currentHallSlug = data.tmp && data.tmp.hall
          ? (typeof data.tmp.hall === 'object' ? data.tmp.hall.slug : data.tmp.hall)
          : null;
        data.item.primaryHall = data.item.halls.find(h => h.slug === currentHallSlug) || data.item.halls[0];
        data.item.otherHalls = data.item.halls.filter(h => h.slug !== data.item.primaryHall.slug);
      } else if (data.item) {
        data.item.primaryHall = null;
        data.item.otherHalls = [];
      }
      if (req.session || !cfg.main.hide_comments_from_public) {
        const isPrefetch = !!(
          req.headers?.['x-purpose'] === 'prefetch' ||
          req.headers?.['purpose'] === 'prefetch' ||
          req.headers?.['sec-purpose'] === 'prefetch'
        );
        // Mark notifications as read (only when actually viewed, not on prefetch)
        if (req.session?.id && !isPrefetch) {
          f0cklib.markNotificationsRead(req.session.id, req.params.itemid).catch(() => {});
        }
        // Subscription status — just a boolean, cheap to embed
        const sub = req.session ? await f0cklib.getSubscriptionStatus(req.session.id, req.params.itemid) : false;
        data.isSubscribed = sub;

        // xD Score — fetch comments only for the score; do NOT embed into the page
        // Comments are always loaded async by the client via /api/comments/:id
        // This avoids blocking the browser's main thread when a comment has a huge xD payload.
        const commentsForScore = await f0cklib.getComments(req.params.itemid, 'old', false);
        const xdScore = f0cklib.computeXdScore(commentsForScore);
        const xdMeta  = f0cklib.xdScoreMeta(xdScore);
        data.item.xd_score = xdScore;
        data.item.xd_tier  = xdMeta.tier;
        data.item.xd_label = xdMeta.label;

        // Do NOT set commentsJSON — client will fetch async
        data.commentsJSON = null;
        data.comments = [];
      } else {
        data.isSubscribed = false;
        data.commentsJSON = null;
        data.comments = [];
        data.item.xd_score = 0;
        data.item.xd_tier  = 0;
        data.item.xd_label = '';
      }
    } else {
      // Ensure total is defined for list views (to prevent template error)
      if (data.total === undefined) data.total = 0;
    }

    // Explicitly inject session for template logic (Navbar)
    // Only inject session for authenticated users to avoid showing member UI to guests
    data.session = (req.session && req.session.user) ? { ...req.session } : false;

    // Precompute boolean helpers for template @if() — the flummpress template engine uses a
    // non-greedy regex to parse @if(condition) and stops at the FIRST ')' it encounters.
    // This means any nested parens (e.g. indexOf('x'), .some(fn), (a || b)) inside @if()
    // will produce broken JS and a "Unexpected token '{'" parse error.
    // Solution: precompute all such conditions as plain booleans here.
    if (mode === 'item' && data.item) {
      const session = data.session;
      const item = data.item;
      // Is the current user a moderator/admin?
      data.is_mod_or_admin = !!(session && (session.admin || session.is_moderator));
      // Can the current user manage this item (owner, admin, or mod)?
      const isAnon = !!(session && (session.is_anon || (session.user && (session.user === 'anonymous' || session.user.startsWith('anon_')))));
      data.can_manage_item = !isAnon && !!(session && (session.admin || session.is_moderator || (session.user && item.username && session.user.toLowerCase() === item.username.toLowerCase())));
      // Rating may also be changed by an anonymous uploader on their own item
      const _ownerName = getSessionOwnerName(session);
      data.can_rate_item = data.can_manage_item || (isAnon && canAnonDo('rate_item') && !!(_ownerName && item.username && _ownerName.toLowerCase() === item.username.toLowerCase()));
      // Is the item's MIME type suitable for metadata extraction?
      // YouTube items use oEmbed via /meta/fetch; all non-flash MIME types are eligible.
      data.can_extract_meta = !!(item.mime && item.mime.indexOf('flash') === -1 && !(item.mime.startsWith('application/') && cfg.mimes[item.mime] && !['swf', 'pdf'].includes(cfg.mimes[item.mime])));
      // Has the current user favorited this item?
      data.user_has_favorited = lib.userHasFavorited(session, item.favorites);
      // Hall columns for display
      data.halls_slugs = Array.isArray(item.halls) ? item.halls.map(h => h.slug).join(',') : '';
      data.user_halls_slugs = Array.isArray(item.user_halls) ? item.user_halls.map(h => h.slug).join(',') : '';
      // When guest or anon anonymization is active, suppress uploader identity, banner, avatar, and source URL
      if (isAnonymizeSession(req.session)) {
        if (item.src) item.src = null;
        item.username = 'anonymous';
        item.author_banner_file = null;
        item.author_banner_position = null;
        item.author_banner_size = null;
        item.author_avatar = null;
        item.author_avatar_file = null;
        item.author_color = null;
        item.author_description = null;
        item.author_display_name = null;
        item.author_id = null;
        if (data.uploader) {
          data.uploader.name = 'anonymous';
          data.uploader.id = null;
          data.uploader.color = null;
        }
        if (Array.isArray(item.favorites)) {
          item.favorites = item.favorites.map(f => {
            const isSelf = session && session.id && f.user_id && Number(f.user_id) === Number(session.id);
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
          });
        }
      }
      // Precomputed for template engine compatibility (avoids nested { } inside {{ }})
      data.item_rating_class = item.is_nsfl ? 'is-nsfl' : (item.is_nsfw ? 'is-nsfw' : (item.is_sfw ? 'is-sfw' : 'is-untagged'));
      data.item_rating_label = item.is_nsfl ? 'NSFL' : (item.is_nsfw ? 'NSFW' : (item.is_sfw ? 'SFW' : '?'));
      data.item_username_lower = (item.username || '').toLowerCase();
      data.is_flash_item = !!(item.mime && (item.mime.indexOf('flash') !== -1 || item.mime.indexOf('shockwave') !== -1));
      data.is_archive_item = !!(item.mime && item.mime.startsWith('application/') && cfg.mimes[item.mime] && !['swf', 'pdf'].includes(cfg.mimes[item.mime]));
      data.current_hall_slug = (data.tmp && data.tmp.hall && typeof data.tmp.hall === 'object') ? data.tmp.hall.slug : (data.tmp && data.tmp.hall ? data.tmp.hall : '');
      data.current_user_hall_slug = (data.tmp && data.tmp.userHall && typeof data.tmp.userHall === 'object') ? data.tmp.userHall.slug : (data.tmp && data.tmp.userHall ? data.tmp.userHall : '');
      data.current_user_hall_owner = (data.tmp && data.tmp.userHallOwner) ? data.tmp.userHallOwner : '';
      data.item_has_dimensions = !!(item.width && item.height);
      data.show_repost_row = !!((data.session || cfg.websrv.expose_repost_links_to_guests || cfg.websrv.expose_repost_links) && (item.is_repost || (item.reposts && item.reposts.length > 0)));
      data.item.show_repost_row = data.show_repost_row;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    const tRenderStart = Date.now();

    // Check if AJAX request for standard grid view
    if (req.headers['x-requested-with'] === 'XMLHttpRequest' && mode === 'index') {
      const body = tpl.render('index-partial', data, req);
      console.log(`[${new Date().toISOString()}] [ROUTE] Render complete (partial) in ${Date.now() - tRenderStart}ms. Total route time: ${Date.now() - tRouteStart}ms`);
      return res.reply({ body });
    }

    const isOnara = isOnaraEnabledFor(req);
    if (mode === 'item' && isOnara) {
      const itemHtml = tpl.render('ajax-item', data, req);

      const isRandom = req.cookies.random_mode === '1' || req.url.qs?.random === '1' || req.query?.random === '1';
      let itemPage = 1;
      if (req.params.page) {
        itemPage = parseInt(req.params.page, 10) || 1;
      } else if (!isRandom && data.item) {
        try {
          itemPage = await f0cklib.getItemPage({
            targetItemId: data.item.id,
            targetItemPinned: data.item.is_pinned,
            user: req.params.user,
            tag: reqTag,
            mime: req.cookies.mime !== undefined ? req.cookies.mime : (req.query?.mime || req.url.qs?.mime || req.params.mime || null),
            hall: req.params.hall,
            fav: req.params.mode == 'favs',
            mode: req.mode,
            ratings: (() => { if (req.mode === 2 || req.mode === 3) return null; const r = req.cookies.ratings; return r ? decodeURIComponent(r).split(/[|,]/).filter(x => ['sfw','nsfw','nsfl','untagged'].includes(x)) : null; })(),
            session: req.session,
            user_id: req.session?.id,
            is_admin: req.session?.admin,
            exclude: req.session ? (req.session.excluded_tags || []) : [],
            strict: !!(req.query?.strict || req.url.qs?.strict || req.session?.strict_mode),
            minXdScore: req.url.qs?.min_xd !== undefined ? +req.url.qs.min_xd : (req.session?.min_xd_score || 0),
            tagger: req.url.qs?.tagger || null
          });
        } catch (err) {
          console.error('[ONARA] getItemPage error:', err);
          itemPage = 1;
        }
      }

      let gridData = await f0cklib.getf0cks({
        user: req.params.user,
        tag: reqTag,
        mime: req.cookies.mime !== undefined ? req.cookies.mime : (req.query?.mime || req.url.qs?.mime || req.params.mime || null),
        page: itemPage,
        hall: req.params.hall,
        fav: req.params.mode == 'favs',
        mode: req.mode,
        ratings: (() => { if (req.mode === 2 || req.mode === 3) return null; const r = req.cookies.ratings; return r ? decodeURIComponent(r).split(/[|,]/).filter(x => ['sfw','nsfw','nsfl','untagged'].includes(x)) : null; })(),
        session: req.session,
        user_id: req.session?.id,
        is_admin: req.session?.admin,
        exclude: req.session ? (req.session.excluded_tags || []) : [],
        url: decodeURIComponent(req.url.pathname || req.url),
        strict: !!(req.query?.strict || req.url.qs?.strict || req.session?.strict_mode),
        explicitStrict: !!(req.query?.strict || req.url.qs?.strict),
        random: isRandom,
        minXdScore: req.url.qs?.min_xd !== undefined ? +req.url.qs.min_xd : (req.session?.min_xd_score || 0),
        lang: req.lang,
        tagger: req.url.qs?.tagger || null
      });

      if (!gridData || !gridData.success) {
        gridData = {
          items: [],
          pagination: { start: 1, end: 1, current: 1, page: 1, cheat: [1], prev: null, next: null },
          total: 0,
          success: true,
          link: { main: '/', path: 'p/', suffix: '' },
          tmp: {}
        };
      }

      const activeId = data.item ? data.item.id : req.params.itemid;
      const activeSlug = data.item ? data.item.slug : null;

      // Mark the active item in the grid for instant highlight
      let foundInGrid = false;
      if (Array.isArray(gridData.items)) {
        for (const it of gridData.items) {
          if ((activeSlug && it.slug === activeSlug) || (it.id === activeId)) {
            it.is_onara_active = true;
            foundInGrid = true;
          } else {
            it.is_onara_active = false;
          }
        }
        // If not in first page of feed, add it so thumbnail is present in background
        if (!foundInGrid && data.item) {
          const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
          const tagId = data.item.tag_id || (data.item.is_nsfl ? nsflId : (data.item.is_nsfw ? 2 : (data.item.is_sfw ? 1 : null)));
          const thumbUrl = data.item.thumb || data.item.thumbnail || (data.item.id ? `/t/${data.item.id}.webp` : null);
          const cleanDest = data.item.dest ? String(data.item.dest).replace(/^\/b\//, '') : '';
          const gridItem = {
            ...data.item,
            id: data.item.id,
            slug: data.item.slug,
            tag_id: tagId,
            thumb: thumbUrl,
            dest: cleanDest,
            display_name: data.item.author_display_name || data.item.display_name || data.item.username,
            username: data.item.username,
            mime: data.item.matching_sub_mime || data.item.mime,
            thumb_size: data.item.thumb_size || 1,
            is_onara_active: true
          };

          if (isRandom && gridData.items.length > 0) {
            const insertIdx = Math.floor(Math.random() * (gridData.items.length + 1));
            gridData.items.splice(insertIdx, 0, gridItem);
          } else {
            gridData.items.unshift(gridItem);
          }
        }
      }

      gridData.session = data.session;
      gridData.is_onara_item = true;
      gridData.onara = true;
      gridData.onara_item_html = itemHtml;
      gridData.item = data.item;
      gridData.page_meta = data.page_meta;
      gridData.hidePagination = false;

      const body = tpl.render('index', gridData, req);
      console.log(`[${new Date().toISOString()}] [ROUTE] Render complete (onara direct item) in ${Date.now() - tRenderStart}ms. Total route time: ${Date.now() - tRouteStart}ms`);
      return res.reply({ body });
    }

    const body = tpl.render(mode, data, req);
    console.log(`[${new Date().toISOString()}] [ROUTE] Render complete in ${Date.now() - tRenderStart}ms. Total route time: ${Date.now() - tRouteStart}ms`);

    return res.reply({ body });
  };

  // Favorites route: redirect logged in users (or anon users) to /user/:user/favs, redirect clean guests to /login
  router.get(/^\/favs(?:\/p\/(?<page>\d+))?\/?(?:\?.*)?$/, async (req, res) => {
    if (req.session && req.session.user) {
      const targetUser = (req.session.is_anon && req.session.login) ? req.session.login : req.session.user;
      res.writeHead(302, { Location: `/user/${encodeURIComponent(targetUser.toLowerCase())}/favs` });
      return res.end();
    }
    res.writeHead(302, { Location: `/login` });
    return res.end();
  });

  router.get(/^\/favs\/(?<itemid>[a-zA-Z0-9_-]{11}|\d+)$/, (req, res) => {
    req.params.mode = 'favs';
    return handleGenericRoute(req, res);
  });

  // Specific route for direct item links: /user/:user/:itemid
  // This avoids ambiguity with the profile route. The other /user/:user/<page> routes (comments, tags, halls)
  // are excluded too, or an item lookup for "comments" etc. would answer "post not visible" before they run.
  router.get(/^\/user\/(?<user>[^/]+)\/(?<itemid>(?!(?:f0cks|uploads|favs|comments|tags|halls)$)[a-zA-Z0-9_-]+)$/, handleGenericRoute);

  // Generic router for everything else (Index, Tags, standard User Grids)
  // We exclude static paths (/s/, /b/, /t/, /ca/, /a/, system routes) to prevent the greedy regex from intercepting them.
  router.get(/^(?!\/(s|b|t|ca|a|4|login|register|settings|about|terms|rules|api|logout|auth|admin|comments|notifications|feed)\/)\/?(?:\/tag\/(?<tag>.+?))?(?:\/h\/(?<hall>.+?))?(?:\/user\/(?<user>.+?)\/(?<mode>f0cks|uploads|favs))?(?:\/(?<mime>(?:video|audio|image)(?:,(?:video|audio|image))*))?(?:\/p\/(?<page>\d+))?(?:\/(?<itemid>[a-zA-Z0-9_-]{11}|\d+))?\/?(?:\?.*)?$/, handleGenericRoute);
  /* </routing-refactor> */

  router.get(/^\/(about)$/, (req, res) => {
    res.reply({
      body: tpl.render('about', {
        tmp: null,
        mail: cfg.main.mail,
        session: (req.session && req.session.user) ? { ...req.session } : false,
        page_meta: {
          title: 'about',
          description: 'About',
          url: `https://${cfg.main.url.domain}/about`
        }
      }, req)
    });
  });

  router.get(/^\/(terms)$/, (req, res) => {
    res.reply({
      body: tpl.render('terms', {
        tmp: null,
        session: (req.session && req.session.user) ? { ...req.session } : false,
        page_meta: {
          title: 'terms',
          description: 'Terms of service',
          url: `https://${cfg.main.url.domain}/terms`
        }
      }, req)
    });
  });

  // Everything /privacy states is derived from the running config, so the page can't drift from reality
  const privacyState = () => {
    const r = getRetention();
    const period = (n) => n ? `${n} day${n === 1 ? '' : 's'}` : 'indefinitely';
    const logIps = getLogUserIps();
    const hashIps = getHashUserIps();
    return {
      log_ips: logIps,
      hash_ips: hashIps,
      ip_mode: !logIps ? 'off' : (hashIps ? 'hashed' : 'raw'),
      anon: getEnableAnonymousAccess(),
      hw: getEnableAnonymousAccess() && getHwFingerprintEnabled(),
      https: String(cfg.main?.url?.full || '').startsWith('https'),
      ip_secret_env: getIpHashSource().startsWith('env'),
      domain: cfg.main?.url?.domain || '',
      ret: {
        ip: period(r.ip),
        activity: period(r.activity_log),
        login: period(r.login_attempts),
        sessions: period(r.sessions),
        fp: period(r.fingerprint)
      },
      ret_on: {
        ip: !!r.ip, activity: !!r.activity_log, login: !!r.login_attempts, sessions: !!r.sessions, fp: !!r.fingerprint
      }
    };
  };

  router.get(/^\/privacy\/?$/, (req, res) => {
    res.reply({
      body: tpl.render('privacy', {
        tmp: null,
        mail: cfg.main.mail,
        pv: privacyState(),
        session: (req.session && req.session.user) ? { ...req.session } : false,
        page_meta: {
          title: 'privacy',
          description: 'Privacy: what is stored when you use the site',
          url: `https://${cfg.main.url.domain}/privacy`
        }
      }, req)
    });
  });

  router.get(/^\/(rules)$/, (req, res) => {
    res.reply({
      body: tpl.render('rules', {
        tmp: null,
        domain: cfg.main.url.domain,
        session: req.session ? { ...req.session } : false,
        page_meta: {
          title: 'rules',
          description: 'Rules and guidelines',
          url: `https://${cfg.main.url.domain}/rules`
        }
      }, req)
    });
  });



  router.get(/^\/mode\/(\d)/, async (req, res) => {
    const modeMatch = req.url.pathname.match(/^\/mode\/(\d)/);
    const mode = modeMatch ? +modeMatch[1] : 0;

    const isGuest = !req.session || !req.session.user;
    if (isGuest) {
      if (mode !== 0) {
        if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
          return res.reply({
            code: 403,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, msg: 'Only SFW mode is allowed for guests' })
          });
        }
        return res.redirect('/');
      }
    } else if (isAnonSession(req.session)) {
      if (!canAnonDo('filter') || !canAnonMode(mode)) {
        if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
          return res.reply({
            code: 403,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, msg: 'Mode not permitted for anonymous users' })
          });
        }
        return res.redirect('/');
      }
    }

    if (cfg.allowedModes[mode]) {
      if (req.session) {
        req.session.mode = mode;
        const blah = {
          user_id: req.session.id,
          mode: mode,
          theme: req.theme ?? (cfg.websrv.theme || "f0ck")
        };

        await db`
          insert into "user_options" ${db(blah, 'user_id', 'mode', 'theme')
          }
          on conflict ("user_id") do update set
            mode = excluded.mode,
            theme = excluded.theme,
            user_id = excluded.user_id
        `;
      }
    }
    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.reply({
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `mode=${mode}; ${lib.getCookieOptions(31536000, false)}`
        },
        body: JSON.stringify({ success: true, mode: mode })
      });
    }

    return res.writeHead(302, {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Set-Cookie": `mode=${mode}; ${lib.getCookieOptions(31536000, false)}`,
      "Location": "/"
    }).end();
  });

  router.get(/^\/strict\/(0|1)$/, async (req, res) => {
    const urlStr = req.url.pathname || req.url;
    const strict = +urlStr.split("/")[2] === 1;

    if (req.session) {
      console.log(`[DEBUG] Setting strict mode to ${strict} for user ${req.session.id}`);
      req.session.strict_mode = strict;

      await db`
          insert into "user_options" (user_id, strict_mode, mode, theme, fullscreen)
          values (${req.session.id}, ${strict}, ${req.session.mode ?? 0}, ${req.session.theme ?? (cfg.websrv.theme || 'f0ck')}, ${req.session.fullscreen ?? 0})
          on conflict ("user_id") do update set
            strict_mode = excluded.strict_mode
        `;
    } else {
      console.log(`[DEBUG] No session found for strict toggle!`);
    }

    return res.reply({
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ success: true, strict: strict })
    });
  });


  return router;
};
