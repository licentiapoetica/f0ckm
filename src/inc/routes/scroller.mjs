import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";

export default (router, tpl) => {
  // Serve the scroller page
  router.get(/^\/abyss(?:\/(?<id>[a-zA-Z0-9_\/-]+))?\/?$/, async (req, res) => {
    if (cfg.websrv.abyss_enabled === false) return res.reply({ code: 404, body: tpl.render('error', { message: 'Not found', tmp: null }, req) });
    if (cfg.websrv.private_society && !req.session) {
      return res.reply({ code: 502, body: '<html><body>502 Bad Gateway</body></html>' });
    }

    const id = req.params?.id || req.params?.[0];
    console.log('[SCROLLER] URL:', req.url.pathname, 'Params:', req.params, 'ID:', id);
    let page_meta = {
      title: 'doomscroll',
      description: 'Scroll through content endlessly',
      url: `https://${cfg.main.url.domain}/abyss`
    };

    if (id && /^\d+$/.test(id.trim())) {
      try {
        const items = await db`
          select i.*, uo.display_name
          from "items" i
          left join "user" u on u."user" = i.username or u.login = i.username
          left join user_options uo on uo.user_id = u.id
          where i.id = ${+id} and i.active = true
          limit 1
        `;
        if (items.length > 0) {
          const item = items[0];
          
          // Fetch tags to check for NSFW/NSFL
          const tags = await db`
            select tag_id from tags_assign where item_id = ${+id}
          `;
          const tagIds = tags.map(t => t.tag_id);
          const isBlurred = tagIds.includes(2) || tagIds.includes(cfg.nsfl_tag_id || 3);

          page_meta.title = `${id}`;
          page_meta.description = cfg.websrv.description || "The webs dumpster";
          page_meta.url = `https://${cfg.main.url.domain}/abyss/${id}`;
          page_meta.image = `https://${cfg.main.url.domain}/t/${id}${isBlurred ? '_blur' : ''}.webp`;
        }
      } catch (e) {
        console.error('[SCROLLER] Failed to fetch meta for ID:', id, e);
      }
    }

    return res.reply({
      body: tpl.render('scroller', {
        tmp: null,
        session: req.session ? { ...req.session } : false,
        enable_nsfl: !!cfg.enable_nsfl,
        enable_swf: !!cfg.websrv.enable_swf,
        page_meta
      }, req)
    });
  });

  // Lightweight meta refresh — returns live counts + tags for a batch of item IDs
  // GET /api/v2/scroller/meta?ids=1,2,3
  router.get(/^\/api\/v2\/scroller\/meta\/?$/, async (req, res) => {
    if (cfg.websrv.abyss_enabled === false) return res.reply({ code: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false }) });
    if (cfg.websrv.private_society && !req.session) {
      return res.reply({ code: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    }
    const qs = req.url.qs || {};
    const ids = (qs.ids || '').split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n > 0).slice(0, 50);
    if (!ids.length) return res.reply({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const sid = req.session ? +req.session.id : null;
    try {
      const rows = await db`
        SELECT
          items.id,
          (SELECT string_agg(t.tag, ', ' ORDER BY ta2.tag_id)
           FROM tags_assign ta2 JOIN tags t ON t.id = ta2.tag_id
           WHERE ta2.item_id = items.id AND ta2.tag_id > 2 LIMIT 5) AS tag_list,
          (SELECT COUNT(*) FROM favorites WHERE favorites.item_id = items.id) AS fav_count,
          (SELECT COUNT(*) FROM comments WHERE comments.item_id = items.id AND comments.is_deleted = false) AS comment_count,
          ${sid ? db`EXISTS (SELECT 1 FROM favorites WHERE favorites.item_id = items.id AND favorites.user_id = ${sid})` : db`false`} AS is_faved
        FROM items
        WHERE items.id = ANY(${ids}::int[])
      `;
      const result = {};
      for (const row of rows) {
        result[row.id] = {
          tags: row.tag_list || '',
          fav_count: +row.fav_count || 0,
          comment_count: +row.comment_count || 0,
          is_faved: row.is_faved || false
        };
      }
      return res.reply({
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache' },
        body: JSON.stringify(result)
      });
    } catch (e) {
      return res.reply({ code: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    }
  });

  // Tag autocomplete endpoint
  router.get(/^\/api\/v2\/scroller\/tags\/?$/, async (req, res) => {
    if (cfg.websrv.abyss_enabled === false) return res.reply({ code: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) });
    if (cfg.websrv.private_society && !req.session) {
      return res.reply({ code: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) });
    }
    const qs = req.url.qs || {};
    const q = (qs.q || '').trim();
    if (q.length < 1) {
      return res.reply({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) });
    }
    try {
      const slug = '%' + lib.slugify(q) + '%';
      const rows = await db`
        SELECT t.tag, t.normalized, COUNT(ta.item_id) as uses
        FROM tags t
        JOIN tags_assign ta ON ta.tag_id = t.id
        WHERE t.id > 2
          AND lower(t.normalized) ILIKE ${slug}
        GROUP BY t.tag, t.normalized
        ORDER BY uses DESC
        LIMIT 10
      `;
      return res.reply({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rows.map(r => ({ tag: r.tag, normalized: r.normalized, uses: +r.uses })))
      });
    } catch (e) {
      return res.reply({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) });
    }
  });

  // JSON API: returns a batch of items for the scroller
  router.get(/^\/api\/v2\/scroller\/feed\/?$/, async (req, res) => {
    if (cfg.websrv.abyss_enabled === false) return res.reply({
      code: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, items: [] })
    });
    if (cfg.websrv.private_society && !req.session) {
      return res.reply({
        code: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, items: [] })
      });
    }

    const qs = req.url.qs || {};
    const mode = qs.mode !== undefined ? +qs.mode : req.mode;
    const limit = Math.min(+qs.limit || 12, 30);
    const after = qs.after ? +qs.after : null;
    const mime = qs.mime || null;
    const tagFilter = qs.tag ? qs.tag.trim() : null;
    const orderby = qs.orderby === 'newest' ? 'newest' : (qs.orderby === 'oldest' ? 'oldest' : 'random');
    const excludedTags = req.session ? (req.session.excluded_tags || []) : [];
    // exclude= is a comma-separated list of item IDs already seen by the client (random mode dedup)
    const excludeIds = qs.exclude
      ? qs.exclude.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n > 0).slice(0, 500)
      : [];
    const modeQuery = lib.getMode(mode ?? 0);
    const nsfp = cfg.nsfp?.length ? cfg.nsfp.map(n => `tag_id = ${n}`).join(' or ') : null;
    // anchor= is a specific item ID to include first in the batch (used for hash-based deep links)
    const anchorId = qs.anchor ? parseInt(qs.anchor, 10) : null;

    const swfMimes = ['application/x-shockwave-flash', 'application/vnd.adobe.flash.movie'];
    const excludeSwfSQL = !cfg.websrv.enable_swf ? db`AND items.mime != ALL(${swfMimes})` : db``;
    const excludePdfSQL = db`AND items.mime != 'application/pdf'`;
    const mimeParts = (mime || '').split(',').filter(m => ['video', 'audio', 'image'].includes(m));
    const mimeSQL = mimeParts.length > 0
      ? db`AND (${mimeParts.map(m => db`items.mime ilike ${m + '/%'}`).reduce((a, b) => db`${a} OR ${b}`)})`
      : db``;

    // Tag filter — support comma-separated list; items matching ANY tag are included (OR)
    let tagSQL = db``;
    if (tagFilter) {
      const tagTerms = tagFilter.split(',').map(t => t.trim()).filter(Boolean);
      if (tagTerms.length === 1) {
        // Single tag: partial ILIKE match
        const slug = '%' + lib.slugify(tagTerms[0]) + '%';
        tagSQL = db`AND items.id IN (
          SELECT ta.item_id FROM tags_assign ta
          JOIN tags t ON t.id = ta.tag_id
          WHERE lower(t.normalized) ILIKE ${slug}
        )`;
      } else {
        // Multiple tags: item must match at least ONE tag (OR / union)
        const slugs = tagTerms.map(term => '%' + lib.slugify(term) + '%');
        tagSQL = db`AND items.id IN (
          SELECT ta.item_id FROM tags_assign ta
          JOIN tags t ON t.id = ta.tag_id
          WHERE ${slugs.map(s => db`lower(t.normalized) ILIKE ${s}`).reduce((a, b) => db`${a} OR ${b}`)}
        )`;
      }
    }

    // Cursor (pagination) — direction depends on order
    let cursorSQL = db``;
    if (after) {
      if (orderby === 'newest') cursorSQL = db`AND items.id < ${after}`;
      else if (orderby === 'oldest') cursorSQL = db`AND items.id > ${after}`;
      // random: after-param not used; use exclude list instead
    }
    // Random mode: exclude all IDs the client has already seen
    const excludeSQL = (orderby === 'random' && excludeIds.length > 0)
      ? db`AND items.id != ALL(${excludeIds}::int[])`
      : db``;

    // Order
    const orderSQL = orderby === 'newest'
      ? db`ORDER BY items.id DESC`
      : orderby === 'oldest'
        ? db`ORDER BY items.id ASC`
        : db`ORDER BY random()`;

    // Reusable SELECT columns fragment helper
    const selectCols = (sessionId) => db`
      items.id, items.mime, items.dest, items.username, items.stamp, items.src, items.is_oc,
      uo.display_name, uo.avatar, uo.avatar_file, uo.username_color,
      (
        SELECT string_agg(t.tag, ', ' ORDER BY ta2.tag_id)
        FROM tags_assign ta2 JOIN tags t ON t.id = ta2.tag_id
        WHERE ta2.item_id = items.id AND ta2.tag_id > 2 LIMIT 5
      ) AS tag_list,
      (SELECT ta3.tag_id FROM tags_assign ta3
       WHERE ta3.item_id = items.id AND ta3.tag_id IN (1,2,${cfg.nsfl_tag_id || 3})
       ORDER BY ta3.tag_id LIMIT 1) AS rating_tag_id,
      (SELECT COUNT(*) FROM favorites WHERE favorites.item_id = items.id) AS fav_count,
      (SELECT COUNT(*) FROM comments WHERE comments.item_id = items.id AND comments.is_deleted = false) AS comment_count,
      ${sessionId ? db`EXISTS (SELECT 1 FROM favorites WHERE favorites.item_id = items.id AND favorites.user_id = ${sessionId})` : db`false`} AS is_faved
    `;
    const sid = req.session ? +req.session.id : null;

    try {
      let rows;

      if (anchorId) {
        // Fetch the anchor item guaranteed first, then fill the rest randomly
        const anchorRows = await db`
          SELECT ${selectCols(sid)}
          FROM items
          LEFT JOIN "user" author_u ON author_u.user = items.username
          LEFT JOIN user_options uo ON uo.user_id = author_u.id
          WHERE items.id = ${anchorId}
            AND items.active = true
            AND ${db.unsafe(modeQuery)}
            ${excludePdfSQL}
            ${!req.session && nsfp ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(nsfp)}))` : db``}
        `;
        // If the anchor item doesn't pass the rating filter, it's inaccessible to this user.
        // Return empty so the frontend shows "This post is currently unavailable".
        if (anchorRows.length === 0) {
          rows = [];
        } else {
          const restRows = await db`
            SELECT ${selectCols(sid)}
            FROM items
            LEFT JOIN "user" author_u ON author_u.user = items.username
            LEFT JOIN user_options uo ON uo.user_id = author_u.id
            WHERE
              ${db.unsafe(modeQuery)}
              AND items.active = true
              ${excludeSwfSQL}
              ${excludePdfSQL}
              AND items.id != ${anchorId}
              ${excludeSQL}
              ${mimeSQL}
              ${tagSQL}
              ${!req.session && nsfp ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(nsfp)}))` : db``}
              ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
            ORDER BY random()
            LIMIT ${limit - 1}
          `;
          rows = [...anchorRows, ...restRows];
        }

      } else {
        rows = await db`
          SELECT ${selectCols(sid)}
          FROM items
          LEFT JOIN "user" author_u ON author_u.user = items.username
          LEFT JOIN user_options uo ON uo.user_id = author_u.id
          WHERE
            ${db.unsafe(modeQuery)}
            AND items.active = true
            ${excludeSwfSQL}
            ${excludePdfSQL}
            ${cursorSQL}
            ${excludeSQL}
            ${mimeSQL}
            ${tagSQL}
            ${!req.session && nsfp ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(nsfp)}))` : db``}
            ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
          ${orderSQL}
          LIMIT ${limit}
        `;
      }

      const ytSrcRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\/?\?(?:\S*?&?v=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;

      const items = rows.map(row => {
        const isVideo = row.mime && row.mime.startsWith('video') && row.mime !== 'video/youtube';
        const isYouTube = row.mime === 'video/youtube';
        const isAudio = row.mime && row.mime.startsWith('audio');
        const isImage = row.mime && row.mime.startsWith('image');

        let dest = row.dest;
        if (isYouTube) {
          // Guard against dest values corrupted by the UUID backfill script:
          // dest should be "yt:VIDEO_ID" — if it isn't, recover the ID from src.
          if (!dest || !dest.startsWith('yt:')) {
            const m = row.src && row.src.match(ytSrcRegex);
            if (m) dest = `yt:${m[1]}`;
          }
        } else if (dest) {
          dest = `${cfg.websrv.paths.images}/${row.dest}`;
        }
        const thumbnail = `${cfg.websrv.paths.thumbnails}/${row.id}.webp`;

        let ratingLabel = '?'; let ratingClass = 'untagged';
        if (row.rating_tag_id == 1) { ratingLabel = 'SFW'; ratingClass = 'sfw'; }
        else if (row.rating_tag_id == 2) { ratingLabel = 'NSFW'; ratingClass = 'nsfw'; }
        else if (row.rating_tag_id == (cfg.nsfl_tag_id || 3)) { ratingLabel = 'NSFL'; ratingClass = 'nsfl'; }

        return {
          id: row.id,
          mime: row.mime,
          dest,
          thumbnail,
          username: row.username,
          display_name: row.display_name || row.username,
          avatar: row.avatar_file ? `/a/${row.avatar_file}` : (row.avatar ? `/t/${row.avatar}.webp` : '/a/default.png'),
          username_color: row.username_color || null,
          stamp: row.stamp,
          timeago: lib.timeAgo(new Date(row.stamp * 1e3).toISOString(), req.lang),
          tags: row.tag_list || '',
          is_oc: row.is_oc || false,
          is_faved: row.is_faved || false,
          fav_count: +row.fav_count || 0,
          comment_count: +row.comment_count || 0,
          is_swf: !!(row.mime === 'application/x-shockwave-flash' || row.mime === 'application/vnd.adobe.flash.movie'),
          is_video: isVideo,
          is_youtube: isYouTube,
          is_audio: isAudio,
          is_image: isImage,
          rating_label: ratingLabel,
          rating_class: ratingClass,
          src_host: row.src ? (() => { try { return new URL(row.src).hostname; } catch { return ''; } })() : ''
        };
      });

      // For ordered feeds, track last id for cursor
      const lastItem = items[items.length - 1];
      const nextCursor = lastItem ? lastItem.id : null;

      return res.reply({
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache' },
        body: JSON.stringify({ success: true, items, nextCursor })
      });
    } catch (e) {
      console.error('[SCROLLER] Feed error:', e);
      return res.reply({
        code: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, items: [], error: 'Feed error' })
      });
    }
  });

  return router;
};
