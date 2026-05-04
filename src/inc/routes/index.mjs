import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";

const auth = async (req, res, next) => {
  if (!req.session)
    return res.redirect("/login");
  return next();
};

export default (router, tpl) => {
  router.get(/\/user\/(?<user>[^/]+)\/?$/, async (req, res) => {
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
      f0cks = await f0cklib.getf0cks({
        user: user,
        mode: req.mode,
        mime: mime,
        fav: false,
        session: !!req.session,
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
        favs = await f0cklib.getf0cks({
          user: user,
          mode: req.mode,
          mime: mime,
          fav: true,
          session: !!req.session,
          user_id: req.session?.id,
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
      timeago: lib.timeAgo(userData.created_at),
      timefull: userData.created_at
    };
    userData.age_days = Math.floor((Date.now() - new Date(userData.created_at).getTime()) / 86400000);

    if (userData.banned) {
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

    // Auto-persist strict mode from URL to session if it's there
    if (req.session && (req.query?.strict !== undefined || req.url.qs?.strict !== undefined)) {
      req.session.strict_mode = (req.query?.strict === '1' || req.url.qs?.strict === '1');
    }

    const data = await (req.params.itemid ? f0cklib.getf0ck : f0cklib.getf0cks)({
      user: req.params.user,
      tag: req.params.tag,
      mime: req.cookies.mime !== undefined ? req.cookies.mime : (req.query?.mime || req.url.qs?.mime || req.params.mime || null),
      page: req.params.page,
      itemid: req.params.itemid,
      hall: req.params.hall,
      fav: req.params.mode == 'favs',
      mode: req.mode,
      session: !!req.session,
      user_id: req.session?.id,
      exclude: req.session ? (req.session.excluded_tags || []) : [],
      url: decodeURIComponent(req.url.pathname || req.url),
      strict: !!(req.query?.strict || req.url.qs?.strict || req.session?.strict_mode),
      explicitStrict: !!(req.query?.strict || req.url.qs?.strict),
      random: req.cookies.random_mode === '1',
      minXdScore: req.params.itemid ? 0 : (req.url.qs?.min_xd !== undefined ? +req.url.qs.min_xd : (req.session?.min_xd_score || 0))
    });
    console.log(`[DEBUG] Checking strict mode: query=${req.query?.strict}, session=${req.session?.strict_mode}, effective=${!!(req.query?.strict || req.url.qs?.strict || req.session?.strict_mode)}`);
    console.log(`[${new Date().toISOString()}] [ROUTE] Data fetch complete in ${Date.now() - tRouteStart}ms`);

    if (!data.success) {
      // For index/grid views with zero items (empty DB), render an empty grid instead of error
      if (mode !== 'item') {
        data.items = [];
        data.pagination = { start: 1, end: 1, current: 1, page: 1, cheat: [1], prev: null, next: null };
        data.total = 0;
        data.success = true;
        if (!data.link) {
          if (req.params.hall) data.link = { main: '/h/' + encodeURIComponent(req.params.hall) + '/', path: 'p/', suffix: '' };
          else if (req.params.tag) data.link = { main: '/tag/' + encodeURIComponent(req.params.tag) + '/', path: 'p/', suffix: '' };
          else data.link = { main: '/', path: 'p/', suffix: '' };
        }
        data.tmp = data.tmp || {};
        if (req.params.hall && !data.tmp.hall) {
          const hallRow = await db`SELECT id, name, slug, description FROM halls WHERE slug = ${req.params.hall} LIMIT 1`;
          data.tmp.hall = hallRow.length ? hallRow[0] : req.params.hall;
        }
        if (req.params.tag && !data.tmp.tag) data.tmp.tag = req.params.tag;
      } else {
        // Return 200 for filtered NSFW items (has item data) so Discord parses og:image
        // Return 404 only for truly missing items
        const statusCode = data.item ? 200 : 404;
        return res.reply({
          code: statusCode,
          body: tpl.render('error', {
            message: data.message,
            item: data.item, // For OG meta tags on filtered NSFW items
            domain: cfg.main.url.domain,
            tmp: null
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
        // Mark notifications as read
        if (req.session?.id) {
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
      data.can_manage_item = !!(session && (session.admin || session.is_moderator || session.user === item.username));
      // Is the item's MIME type suitable for metadata extraction?
      data.can_extract_meta = !!(item.mime && item.mime.indexOf('flash') === -1 && item.mime.indexOf('youtube') === -1);
      // Has the current user favorited this item?
      data.user_has_favorited = !!(session && Array.isArray(item.favorites) && item.favorites.some(f => f.user === session.user));
      // Hall columns for display
      data.halls_slugs = Array.isArray(item.halls) ? item.halls.map(h => h.slug).join(',') : '';
      data.user_halls_slugs = Array.isArray(item.user_halls) ? item.user_halls.map(h => h.slug).join(',') : '';
      // Precomputed for template engine compatibility (avoids nested { } inside {{ }})
      data.item_rating_class = item.is_nsfl ? 'is-nsfl' : (item.is_nsfw ? 'is-nsfw' : (item.is_sfw ? 'is-sfw' : 'is-untagged'));
      data.item_rating_label = item.is_nsfl ? 'NSFL' : (item.is_nsfw ? 'NSFW' : (item.is_sfw ? 'SFW' : '?'));
      data.item_username_lower = (item.username || '').toLowerCase();
      data.is_flash_item = !!(item.mime && (item.mime.indexOf('flash') !== -1 || item.mime.indexOf('shockwave') !== -1));
      data.current_hall_slug = (data.tmp && data.tmp.hall && typeof data.tmp.hall === 'object') ? data.tmp.hall.slug : (data.tmp && data.tmp.hall ? data.tmp.hall : '');
      data.current_user_hall_slug = (data.tmp && data.tmp.userHall && typeof data.tmp.userHall === 'object') ? data.tmp.userHall.slug : (data.tmp && data.tmp.userHall ? data.tmp.userHall : '');
      data.current_user_hall_owner = (data.tmp && data.tmp.userHallOwner) ? data.tmp.userHallOwner : '';
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

    const body = tpl.render(mode, data, req);
    console.log(`[${new Date().toISOString()}] [ROUTE] Render complete in ${Date.now() - tRenderStart}ms. Total route time: ${Date.now() - tRouteStart}ms`);

    return res.reply({ body });
  };

  // Specific route for direct item links: /user/:user/:itemid
  // This avoids ambiguity with the profile route
  router.get(/\/user\/(?<user>[^/]+)\/(?<itemid>\d+)$/, handleGenericRoute);

  // Generic router for everything else (Index, Tags, standard User Grids)
  // We exclude static paths (/s/, /b/, /t/, /ca/, /a/) to prevent the greedy regex from intercepting them.
  router.get(/^(?!\/(s|b|t|ca|a)\/)\/?(?:\/tag\/(?<tag>.+?))?(?:\/h\/(?<hall>.+?))?(?:\/user\/(?<user>.+?)\/(?<mode>f0cks|uploads|favs))?(?:\/(?<mime>(?:video|audio|image)(?:,(?:video|audio|image))*))?(?:\/p\/(?<page>\d+))?(?:\/(?<itemid>\d+))?\/?(?:\?.*)?$/, handleGenericRoute);
  /* </routing-refactor> */

  router.get(/^\/(about)$/, (req, res) => {
    res.reply({
      body: tpl.render('about', {
        tmp: null,
        mail: cfg.main.mail,
        discord: cfg.main.discord,
        session: (req.session && req.session.user) ? { ...req.session } : false,
        page_meta: {
          title: 'about',
          description: 'About w0bm.com',
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
