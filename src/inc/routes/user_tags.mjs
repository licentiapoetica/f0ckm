import db from "../../inc/sql.mjs";
import lib from "../../inc/lib.mjs";
import cfg from "../../inc/config.mjs";
import { isAnonymizeSession, isAnonSession, getAnonAllowedModes } from "../settings.mjs";
import url from "url";

const TAGS_PER_PAGE = 50; // Smaller chunks for better infinite scroll

export default (router, tpl) => {
  const getTagsQuery = async (userId, mode, offset, limit, sessionObj = false, strict = false) => {
    const excludedTags = sessionObj ? (sessionObj.excluded_tags || []) : [];
    const isGuest = !sessionObj;
    const isPublicVisitor = !sessionObj || isAnonSession(sessionObj);
    let baseMode = lib.getMode(mode);
    if (isGuest) {
      const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
      if (mode === 3 || mode === 0 || mode === undefined || mode === null) {
        if (cfg.websrv.public_nsfw) {
          baseMode = cfg.websrv.public_untagged
            ? `(items.id in (select item_id from tags_assign where tag_id in (1, 2)) or not exists (select 1 from tags_assign where item_id = items.id and tag_id in (1, 2, ${nsflId})))`
            : "items.id in (select item_id from tags_assign where tag_id in (1, 2))";
        } else {
          baseMode = cfg.websrv.public_untagged
            ? `(items.id in (select item_id from tags_assign where tag_id = 1) or not exists (select 1 from tags_assign where item_id = items.id and tag_id in (1, 2, ${nsflId})))`
            : "items.id in (select item_id from tags_assign where tag_id = 1)";
        }
      } else if (!cfg.websrv.public_untagged && mode === 2) {
        baseMode = "1 = 0";
      }
    }
    const modequery = baseMode;

    let restrictedFilter = db``;
    if (isPublicVisitor && cfg.nsfp && cfg.nsfp.length > 0) {
      let effectiveNsfp = [...cfg.nsfp];
      if (sessionObj && isAnonSession(sessionObj)) {
        const allowedModes = getAnonAllowedModes();
        if (allowedModes.includes('nsfw')) effectiveNsfp = effectiveNsfp.filter(id => id !== 2);
        const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
        if (allowedModes.includes('nsfl')) effectiveNsfp = effectiveNsfp.filter(id => id !== nsflId);
      } else if (cfg.websrv.public_nsfw) {
        effectiveNsfp = effectiveNsfp.filter(id => id !== 2);
      }
      if (effectiveNsfp.length > 0) {
        restrictedFilter = db`
          AND t.id NOT IN ${db(effectiveNsfp)}
          AND NOT EXISTS (
            SELECT 1 FROM tags_assign ta_res 
            WHERE ta_res.item_id = items.id 
            AND ta_res.tag_id IN ${db(effectiveNsfp)}
          )
        `;
      }
    }

    const userExcludeFilter = excludedTags.length > 0 
      ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign ta_ex WHERE ta_ex.item_id = items.id AND ta_ex.tag_id = ANY(${excludedTags}::int[]))`
      : db``;

    // Step 1: Get tags sorted by exact count (fast, indexed)
    // Group by normalized to merge duplicates (e.g. "Music" and "music")
    const baseTags = await db`
      SELECT MIN(t.id) as id, MIN(t.tag) as tag, t.normalized, COUNT(DISTINCT items.id) AS total_items
      FROM tags t
      JOIN tags_assign ta ON t.id = ta.tag_id
      JOIN items ON items.id = ta.item_id
      WHERE items.active = true
        AND items.is_deleted = false
        AND COALESCE(items.visibility, 0) = 0
        AND t.id NOT IN (1, 2)
        AND ta.user_id = ${userId}
        AND ${db.unsafe(modequery)}
        ${restrictedFilter}
        ${userExcludeFilter}
      GROUP BY t.normalized
      HAVING COUNT(DISTINCT items.id) >= 1
      ORDER BY total_items DESC, MIN(t.id) DESC
      OFFSET ${offset}
      LIMIT ${limit}
    `;

    // Step 2: In normal (non-strict) mode, replace counts with fuzzy counts
    // Only runs for the ~50 tags being displayed, not all tags
    if (!strict && baseTags.length > 0) {
      await Promise.all(baseTags.map(async (tag) => {
        if (!tag.normalized) return;
        const [row] = await db`
          SELECT COUNT(DISTINCT items.id) as total
          FROM tags t
          JOIN tags_assign ta ON t.id = ta.tag_id
          JOIN items ON items.id = ta.item_id
          WHERE t.normalized LIKE '%' || ${tag.normalized} || '%'
            AND items.active = true
            AND items.is_deleted = false
            AND COALESCE(items.visibility, 0) = 0
            AND ta.user_id = ${userId}
            AND ${db.unsafe(modequery)}
            ${restrictedFilter}
            ${userExcludeFilter}
        `;
        tag.total_items = +row.total;
      }));
    }

    return baseTags;
  };

  const processTags = (tags) => tags.map(t => ({
    ...t,
    safe_tag: t.normalized || encodeURIComponent(t.tag),
    encoded_tag: encodeURIComponent(t.tag)
  }));

  // API endpoint for lazy loading tags for a user
  router.get(/^\/api\/user\/(?<user>[^\/]+)\/tags$/, async (req, res) => {
    if (isAnonymizeSession(req.session)) {
      return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: "Access denied" }) });
    }
    const userParam = decodeURIComponent(req.params.user);
    
    const u = await db`
        SELECT "user".id, "user".user
        FROM "user" 
        WHERE "user".user ILIKE ${userParam}
    `;
    if (!u.length) {
        return res.reply({ code: 404, body: JSON.stringify({ success: false, msg: "User not found" }) });
    }
    const userId = u[0].id;
    const userName = u[0].user;

    let query = {};
    if (typeof req.url === 'string') {
      const parsedUrl = url.parse(req.url, true);
      query = parsedUrl.query;
    } else {
      query = req.url.qs || {};
    }

    const page = Math.max(1, +(query.page ?? 1));
    const offset = (page - 1) * TAGS_PER_PAGE;
    const mode = req.mode ?? 0;
    const isStrict = !!(query.strict === '1' || req.session?.strict_mode);

    const tags = processTags(await getTagsQuery(userId, mode, offset, TAGS_PER_PAGE, req.session, isStrict));

    if (req.headers['x-requested-with'] === 'XMLHttpRequest' || query.ajax) {
      const paginationHtml = tpl.render('snippets/pagination', {
        pagination: {
          page: page,
          prev: page > 1 ? page - 1 : null,
          next: tags.length === TAGS_PER_PAGE ? page + 1 : null,
          cheat: [1]
        },
        link: `/user/${encodeURIComponent(userName)}/tags`
      }, req);

      return res.json({
        success: true,
        html: tpl.render('tag-cards', { toptags: tags, tagger: userName, user: { user: userName }, session: (req.session && req.session.user) ? { ...req.session } : false }, req),
        currentPage: page,
        pagination: paginationHtml,
        hasMore: tags.length === TAGS_PER_PAGE
      });
    }

    res.json({
      success: true,
      tags,
      currentPage: page,
      hasMore: tags.length === TAGS_PER_PAGE
    });
  });

  // Main tags page
  router.get(/^\/user\/(?<user>[^\/]+)\/tags$/, async (req, res) => {
    if (isAnonymizeSession(req.session)) {
      return req.session ? res.redirect('/') : res.redirect('/login');
    }
    const userParam = decodeURIComponent(req.params.user);
    
    const u = await db`
        SELECT "user".id, "user".user, user_options.avatar, user_options.avatar_file, user_options.username_color
        FROM "user" 
        LEFT JOIN user_options ON "user".id = user_options.user_id 
        WHERE "user".user ILIKE ${userParam}
    `;
    if (!u.length) {
        return res.reply({ code: 404, body: "User not found" });
    }
    const userRow = u[0];
    const userId = userRow.id;

    const mode = req.mode ?? 0;
    const query = req.url.qs || {};
    const isStrict = !!(query.strict === '1' || req.session?.strict_mode);

    const toptags = processTags(await getTagsQuery(userId, mode, 0, TAGS_PER_PAGE, req.session, isStrict));

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    const data = {
      user: userRow,
      tagger: userRow.user,
      toptags: toptags,
      tmp: null,
      hidePagination: false,
      pagination: {
        page: 1,
        prev: null,
        next: toptags.length === TAGS_PER_PAGE ? 2 : null,
        cheat: [1]
      },
      link: `/user/${encodeURIComponent(userRow.user)}/tags`,
      session: (req.session && req.session.user) ? { ...req.session } : false,
      page_meta: {
        title: `${userRow.user}'s Tags`,
        description: `Browse ${toptags.length}+ tags made by ${userRow.user}`,
        url: `https://${cfg.main.url.domain}/user/${encodeURIComponent(userRow.user)}/tags`
      }
    };

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.reply({
        body: tpl.render('tags_user-partial', data, req)
      });
    }

    res.reply({
      body: tpl.render('tags_user', data, req)
    });
  });

  return router;
};
