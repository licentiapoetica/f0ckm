import db from "../sql.mjs";
import lib from "../lib.mjs";
import cfg from "../config.mjs";
import { updateHallsCache } from "../halls_cache.mjs";
import fs from "fs";
import url from "url";

const globalfilter = cfg.nsfp?.length ? cfg.nsfp.map(n => `tag_id = ${n}`).join(" or ") : null;

// All MIME types that map to the 'swf' extension in config (e.g. application/x-shockwave-flash, application/vnd.adobe.flash.movie)
const flashMimes = Object.entries(cfg.mimes || {}).filter(([, ext]) => ext === 'swf').map(([mime]) => mime);

const processMentions = async (comments) => {
  if (!comments || comments.length === 0) return comments;

  // 1. Collect all potential mentions
  const mentionRegex = /(?<!\[)@([a-zA-Z0-9_\-\.]+)(?!\])/g;
  const allMentions = new Set();
  comments.forEach(c => {
    const matches = [...c.content.matchAll(mentionRegex)];
    matches.forEach(m => allMentions.add(m[1].toLowerCase())); // normalize for lookup
  });

  if (allMentions.size === 0) return processEmbeds(comments);

  // 2. Validate against DB
  const validUsers = new Set();
  try {
    const users = await db`SELECT login FROM "user" WHERE login IN ${db([...allMentions])}`;
    users.forEach(u => validUsers.add(u.login)); // login is lowercase
  } catch (e) {
    console.error('Error verifying mentions:', e);
    return processEmbeds(comments); // Fail safe
  }

  // 3. Replace in content using original case from match but checking validity
  const processed = comments.map(c => {
    let newContent = c.content.replace(mentionRegex, (match, name) => {
      if (validUsers.has(name.toLowerCase())) {
        return `[@${name}](/user/${name})`;
      }
      return match;
    });
    return { ...c, content: newContent };
  });

  return processEmbeds(processed);
};

const processEmbeds = (comments) => {
  if (!comments || comments.length === 0) return comments;

  const siteUrl = cfg.main.url.full;
  if (!siteUrl) return comments;

  // Escape special characters in siteUrl for regex
  const escapedSiteUrl = siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
  // Regex to find site URLs pointing to images
  // Supports .jpg, .jpeg, .png, .gif, .webp
  // Case-insensitive
  const imageRegex = new RegExp(`(${escapedSiteUrl}(?:\\/\\S+\\.(?:jpg|jpeg|png|gif|webp)))`, 'gi');

  return comments.map(c => {
    if (!c.content) return c;
    
    let newContent = c.content.replace(imageRegex, (match, url) => {
      return `![site image](${url})`;
    });
    
    return { ...c, content: newContent };
  });
};

const computeXdScore = (comments) => {
  if (!comments || comments.length === 0) return 0;
  let score = 0;
  const xdRegex = /x(D+)/gi;
  for (const c of comments) {
    if (!c.content || c.is_deleted) continue;
    for (const m of c.content.matchAll(xdRegex)) {
      score += m[1].length;
    }
  }
  return score;
};

const xdScoreMeta = (score) => {
  if (score < 1)           return { tier: 0, label: '' };
  if (score < 200)         return { tier: 1, label: 'xD' };
  if (score < 1000)        return { tier: 2, label: 'xDD' };
  if (score < 100000)      return { tier: 3, label: 'xDDD' };
  if (score < 20000000)   return { tier: 4, label: 'xDDDD' };
  return                      { tier: 5, label: 'xDDDDD+' };
};

export default {
  getf0cks: async ({ user: rawUser, tag: rawTag, hall: rawHall, mime: rawMime, page, mode, ratings, fav, session, limit, strict, newer, exclude, user_id, random, userHall: rawUserHall, userHallOwner: rawUserHallOwner, minXdScore } = {}) => {
    const user = rawUser ? lib.escapeLike(decodeURI(rawUser)) : null;

    // --- title: prefix — search items.title instead of the tags table ---
    const _decodedTag = rawTag ? decodeURIComponent(rawTag) : '';
    const isTitleSearch = _decodedTag.startsWith('title:');
    const titleQuery = isTitleSearch ? _decodedTag.substring(6).trim() : null;

    const tag = isTitleSearch ? null : lib.parseTag(rawTag ?? null);
    let hall = rawHall ?? null;
    let hallObj = null;
    if (hall) {
      const hallData = await db`SELECT name, slug, description FROM halls WHERE slug = ${hall} LIMIT 1`;
      if (hallData.length) {
        hallObj = { name: hallData[0].name, slug: hallData[0].slug, description: hallData[0].description };
      }
    }
    // User hall context
    const userHallSlug = rawUserHall ?? null;
    const userHallOwner = rawUserHallOwner ?? null;
    let userHallObj = null;
    if (userHallSlug && userHallOwner) {
      const uhData = await db`
        SELECT uh.id, uh.name, uh.slug, uh.description, uh.is_private, u."user" as owner_name
        FROM user_halls uh
        JOIN "user" u ON u.id = uh.user_id
        WHERE u."user" ILIKE ${userHallOwner} AND uh.slug = ${userHallSlug}
        LIMIT 1
      `;
      if (uhData.length) userHallObj = uhData[0];
    }
    const mime = rawMime ?? null;
    const actPage = +(page ?? 1);
    
    // Support multiple MIME types (comma separated)
    const mimeParts = (mime || "").split(',').filter(m => ['video', 'audio', 'image', 'flash', 'pdf'].includes(m));
    const mimeSQL = mimeParts.length > 0
      ? db`and (${mimeParts.map(m => m === 'flash'
          ? (flashMimes.length > 0
              ? flashMimes.map(fm => db`items.mime = ${fm}`).reduce((a, b) => db`${a} or ${b}`)
              : db`false`)
          : (m === 'pdf' ? db`items.mime = 'application/pdf'` : db`items.mime ilike ${m + '/%'}`)).reduce((a, b) => db`${a} or ${b}`)})`
      : db``;
    const eps = limit ?? cfg.websrv.eps;
    const excludedTags = session && exclude ? (exclude || []) : [];
    const newerThan = newer ? parseInt(newer) : null;
    const minXd = (minXdScore && +minXdScore > 0) ? +minXdScore : 0;
    // xD filter: use materialized items.xd_score column (kept live by trigger) for fast indexed lookup
    const xdFilter = minXd > 0 ? db`and items.xd_score >= ${minXd}` : db``;

    const strictParams = ((strict || (tag && tag.includes(','))) && tag) ? tag.split(',').map(t => lib.slugify(t)).filter(t => t) : [];
    const isStrict = strictParams.length > 0;

    const tmp = { user, tag: isTitleSearch ? _decodedTag : tag, hall: hallObj || hall, mime, page: actPage, mode: mode, view_mode: fav ? 'favs' : 'uploads', strict: strict, userHall: userHallObj || userHallSlug, userHallOwner };
    // Multi-rating support: if `ratings` array provided, build an OR-based SQL fragment
    const multiRatingSQL = (Array.isArray(ratings) && ratings.length > 0) ? lib.getMultiRatingMode(ratings) : null;
    const baseMode = multiRatingSQL ?? lib.getMode(mode ?? 0);
    const modequery = baseMode;

    let tagFilter = db``;
    let titleFilter = db``;
    if (isTitleSearch && titleQuery) {
      // Title search: match items.title ILIKE '%query%'
      titleFilter = db`and items.title ILIKE ${'%' + titleQuery + '%'} and items.title IS NOT NULL`;
    } else if (tag) {
      const terms = tag.split(',').map(t => t.trim()).filter(Boolean);
      if (terms.length > 0) {
        if (isStrict) {
          tagFilter = db`and items.id in (
            select ta.item_id 
            from tags_assign ta 
            join tags t on t.id = ta.tag_id 
            where t.normalized = ANY(ARRAY(SELECT slugify(x) FROM unnest(${terms}::text[]) AS x))
            group by ta.item_id 
            having count(distinct t.normalized) = ${terms.length}
          )`;
        } else {
            // Non-strict intersection Logic (AND for partials)
            // For each term, ensure there is AT LEAST one matching tag assigned to the item
            const conditions = terms.map(term => {
                return db`and items.id in (select ta.item_id from tags_assign ta join tags t on t.id = ta.tag_id where t.normalized like '%' || slugify(${term}) || '%')`;
            });
            tagFilter = db`${conditions}`;
        }
      }
    }

    let hallFilter = db``;
    if (hall) {
      hallFilter = db`and items.id in (select item_id from halls_assign join halls on halls.id = halls_assign.hall_id where halls.slug = ${(hall && typeof hall === 'object') ? hall.slug : hall})`;
    }

    let userHallFilter = db``;
    if (userHallObj) {
      userHallFilter = db`and items.id in (select uha.item_id from user_halls_assign uha where uha.hall_id = ${userHallObj.id})`;
    }

    const totalRows = await db`
      select count(distinct items.id) as total
      from items
      ${fav ? db`inner join favorites on favorites.item_id = items.id inner join "user" fav_u on fav_u.id = favorites.user_id` : db``}
      where
        ${db.unsafe(modequery)}
        and items.active = true
        ${tagFilter}
        ${titleFilter}
        ${fav ? db`and fav_u.user ilike ${user}` : db``}
        ${!fav && user ? db`and items.username ilike ${user}` : db``}
        ${mimeSQL}
        ${hallFilter}
        ${userHallFilter}
        ${!session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(globalfilter)}))` : db``}
        ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        ${newerThan ? db`and items.id > ${newerThan}` : db``}
        ${xdFilter}
    `;
    const total = Number(totalRows[0].total);

    if (!total || total === 0) {
      return {
        success: false,
        message: "404 - no uploads found"
      };
    }

    const pages = +Math.ceil(total / eps);
    const act_page = Math.min(page || 1, pages);
    const offset = Math.max(0, (act_page - 1) * eps);

    const rows = await db`
      select
        items.id,
        items.mime,
        items.dest,
        items.username as username,
        items.is_pinned,
        items.is_oc,
        items.xd_score,
        ${user_id ? db`max(coalesce(uvv.view_count, 0)) as my_views,` : db``}
        ${user_id ? db`EXISTS (SELECT 1 FROM notifications WHERE user_id = ${user_id} AND item_id = items.id AND is_read = false) as has_notification,` : db`false as has_notification,`}
        (case when min(ta.tag_id) = 1 then 'SFW' when min(ta.tag_id) = 2 then 'NSFW' else 'NSFL' end) as tag,
        min(ta.tag_id) as tag_id,
        max(uo.display_name) as display_name,
        ${cfg.websrv.enable_dynamic_thumbs ? db`
        (
          (SELECT count(*) FROM favorites WHERE item_id = items.id) +
          (SELECT count(*) FROM comments WHERE item_id = items.id AND is_deleted = false)
        ) as contribution
        ` : db`0 as contribution`}
      from items
      left join "user" author_u on author_u."user" = items.username or author_u.login = items.username
      left join user_options uo on uo.user_id = author_u.id
      left join tags_assign on tags_assign.item_id = items.id
      left join tags on tags.id = tags_assign.tag_id
      left join favorites on favorites.item_id = items.id
      left join "user" fav_u on fav_u.id = favorites.user_id
      left join tags_assign ta on ta.item_id = items.id and (ta.tag_id = 1 or ta.tag_id = 2 ${cfg.enable_nsfl ? db`or ta.tag_id = ${cfg.nsfl_tag_id || 3}` : db``})
      left join tags badge_t on badge_t.id = ta.tag_id
      ${user_id ? db`left join user_video_views uvv on uvv.video_id = items.id and uvv.user_id = ${user_id}` : db``}
      where
        ${db.unsafe(modequery)}
        and items.active = true
        ${tagFilter}
        ${titleFilter}
        ${fav ? db`and fav_u.user ilike ${user}` : db``}
        ${!fav && user ? db`and items.username ilike ${user}` : db``}
        ${mimeSQL}
        ${hallFilter}
        ${userHallFilter}
        ${!session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(globalfilter)}))` : db``}
        ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        ${newerThan ? db`and items.id > ${newerThan}` : db``}
        ${xdFilter}
      group by items.id
      order by ${random ? db`random()` : db`items.is_pinned desc, items.id desc`}
      offset ${newerThan ? 0 : offset}
      limit ${eps}
    `;

    for (const row of rows) {
      const meta = xdScoreMeta(row.xd_score);
      row.xd_tier = meta.tier;
      row.xd_label = meta.label;
    }

    // Dynamic thumb sizing: applies to the main feed including mime/rating filters.
    // Only per-user profiles, tag searches, halls, and favorites disable it.
    const isMainFeed = cfg.websrv.enable_dynamic_thumbs
      && !rawUser && !rawTag && !rawHall && !rawUserHall && !fav;

    if (isMainFeed) {
      for (const row of rows) {
        const c = Number(row.contribution) || 0;
        row.thumb_size = c >= 5 ? 2 : 1;
      }
    } else {
      for (const row of rows) {
        row.thumb_size = 1;
      }
    }


    const cheat = [];
    // Increase range for better context
    const range = 3;
    for (let i = Math.max(1, act_page - range); i <= Math.min(act_page + range, pages); i++)
      cheat.push(i);

    const link = lib.genLink({ user, tag, hall: hallObj ? hallObj.slug : hall, mime, type: fav ? 'favs' : 'uploads', path: 'p/', strict: strict });

    // Override link for title searches — pagination must use the /tag/title:... prefix
    if (isTitleSearch && titleQuery) {
      link.main = `/tag/title:${encodeURIComponent(titleQuery)}/`;
      link.mainDisplay = `/tag/title:${titleQuery}/`;
      link.path = 'p/';
      link.suffix = '';
    }

    // Override link for user hall context
    if (userHallObj && userHallOwner) {
      const ownerName = userHallObj.owner_name || userHallOwner;
      link.main = `/user/${encodeURIComponent(ownerName)}/hall/${encodeURIComponent(userHallObj.slug)}/`;
      link.mainDisplay = `/user/${ownerName}/hall/${userHallObj.slug}/`;
      link.path = 'p/';
      link.suffix = '';
    }

    return {
      success: true,
      items: rows,
      pagination: {
        start: 1,
        end: pages,
        current: act_page,
        location: link.main + link.path,
        suffix: link.suffix,
        prev: (act_page > 1) ? act_page - 1 : null,
        next: (act_page < pages) ? act_page + 1 : null,
        page: act_page,
        cheat: cheat
      },
      link,
      tmp,
      total,
      view_mode: fav ? 'favs' : 'uploads'
    };
  },
  getf0ck: async ({ user: rawUser, tag: rawTag, hall: rawHall, mime: rawMime, itemid: rawItemid, mode, ratings, session, strict, exclude, user_id, fav, random, userHall: rawUserHall, userHallOwner: rawUserHallOwner, lang } = {}) => {
    const user = rawUser ? lib.escapeLike(decodeURI(rawUser)) : null;

    // --- title: prefix — search items.title instead of the tags table ---
    const _decodedTag = rawTag ? decodeURIComponent(rawTag) : '';
    const isTitleSearch = _decodedTag.startsWith('title:');
    const titleQuery = isTitleSearch ? _decodedTag.substring(6).trim() : null;
    const tag = isTitleSearch ? null : lib.parseTag(rawTag ?? null);
    let hall = rawHall ?? null;
    if (hall) {
        const hallData = await db`SELECT name, slug, description FROM halls WHERE slug = ${hall} LIMIT 1`;
        if (hallData.length) {
            hall = { name: hallData[0].name, slug: hallData[0].slug, description: hallData[0].description };
        }
    }
    // User hall context
    const userHallSlug = rawUserHall ?? null;
    const userHallOwner = rawUserHallOwner ?? null;
    let userHallObj = null;
    if (userHallSlug && userHallOwner) {
      const uhData = await db`
        SELECT uh.id, uh.name, uh.slug, uh.description, uh.is_private, u."user" as owner_name
        FROM user_halls uh
        JOIN "user" u ON u.id = uh.user_id
        WHERE u."user" ILIKE ${userHallOwner} AND uh.slug = ${userHallSlug}
        LIMIT 1
      `;
      if (uhData.length) userHallObj = uhData[0];
    }
    const mime = (rawMime ?? "");
    const itemid = rawItemid ? +rawItemid : null;
    const mimeParts = (mime || "").split(',').filter(m => ['video', 'audio', 'image', 'flash', 'pdf'].includes(m));
    const mimeSQL = mimeParts.length > 0
      ? db`and (${mimeParts.map(m => m === 'flash'
          ? (flashMimes.length > 0
              ? flashMimes.map(fm => db`items.mime = ${fm}`).reduce((a, b) => db`${a} or ${b}`)
              : db`false`)
          : (m === 'pdf' ? db`items.mime = 'application/pdf'` : db`items.mime ilike ${m + '/%'}`)).reduce((a, b) => db`${a} or ${b}`)})`
      : db``;
    const excludedTags = exclude || [];

    const strictParams = ((strict || (tag && tag.includes(','))) && tag) ? tag.split(',').map(t => lib.slugify(t)).filter(t => t) : [];
    const isStrict = strictParams.length > 0;

    const tmp = { user, tag: isTitleSearch ? _decodedTag : tag, hall, mime, itemid, strict: strict, userHall: userHallObj || userHallSlug, userHallOwner };

    const effMode = Number(mode ?? 0);
    const multiRatingSQL = (Array.isArray(ratings) && ratings.length > 0) ? lib.getMultiRatingMode(ratings) : null;
    const modequery = multiRatingSQL ?? lib.getMode(effMode);

    if (itemid === null) {
      return {
        success: false,
        message: "404 - upload not found"
      };
    }

    let tagFilter = db``;
    let titleFilter = db``;
    if (isTitleSearch && titleQuery) {
      titleFilter = db`and items.title ILIKE ${'%' + titleQuery + '%'} and items.title IS NOT NULL`;
    } else if (tag) {
      const terms = tag.split(',').map(t => t.trim()).filter(Boolean);
      if (terms.length > 0) {
        if (isStrict) {
          tagFilter = db`and items.id in (
            select ta.item_id 
            from tags_assign ta 
            join tags t on t.id = ta.tag_id 
            where t.normalized = ANY(ARRAY(SELECT slugify(x) FROM unnest(${terms}::text[]) AS x))
            group by ta.item_id 
            having count(distinct t.normalized) = ${terms.length}
          )`;
        } else {
            const conditions = terms.map(term => {
                return db`and items.id in (select ta.item_id from tags_assign ta join tags t on t.id = ta.tag_id where t.normalized like '%' || slugify(${term}) || '%')`;
            });
            tagFilter = db`${conditions}`;
        }
      }
    }

    let hallFilter = db``;
    if (hall) {
      hallFilter = db`and items.id in (select item_id from halls_assign join halls on halls.id = halls_assign.hall_id where halls.slug = ${(hall && typeof hall === 'object') ? hall.slug : hall})`;
    }

    let userHallFilter = db``;
    if (userHallObj) {
      userHallFilter = db`and items.id in (select uha.item_id from user_halls_assign uha where uha.hall_id = ${userHallObj.id})`;
    }

    // Helper to construct shared filter conditions
    const buildConditions = () => {
      return db`
            ${db.unsafe(modequery)}
            and items.active = true
            ${tagFilter}
            ${titleFilter}
            ${hallFilter}
            ${userHallFilter}
            ${fav ? db`and "user"."user" ilike ${user}` : db``}
            ${!fav && user ? db`and items.username ilike ${user}` : db``}
            ${mimeSQL}
            ${!session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(globalfilter)}))` : db``}
            ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        `;
    };

    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] [GETF0CK_OPT] Starting fetch for itemid=${itemid}`);

    // 1. Fetch the main item
    // We only apply the active check and global NSFW filter (for guests) here.
    // We skip the 'mode' preference filter so that switching modes on an item view doesn't result in a 404 (post not visible).
    const items = await db`
      select distinct on (items.id)
        items.*,
        items.username as username,
        uo.username_color as author_color,
        uo.display_name as author_display_name,
        uo.avatar as author_avatar,
        uo.avatar_file as author_avatar_file,
        uo.description as author_description,
        author_u.id as author_id,
        items.is_pinned,

        ${user_id ? db`coalesce(uvv.view_count, 0) as my_views` : db`0 as my_views`}
      from items
      left join favorites on favorites.item_id = items.id
      left join "user" fav_u on fav_u.id = favorites.user_id
      left join "user" author_u on author_u."user" = items.username or author_u.login = items.username
      left join "user_options" uo on uo.user_id = author_u.id
      ${user_id ? db`left join user_video_views uvv on uvv.video_id = items.id and uvv.user_id = ${user_id}` : db``}
      where
        items.id = ${itemid} and
        items.active = true
        ${!session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(globalfilter)}))` : db``}
      limit 1
    `;

    const actitem = items[0];
    
    if (actitem && user_id) {
       db`
        insert into user_video_views (user_id, video_id, view_count, last_viewed)
        values (${user_id}, ${itemid}, 1, now())
        on conflict (user_id, video_id) do update set
         view_count = user_video_views.view_count + 1,
         last_viewed = now()
       `.catch(e => console.error('Failed to track view:', e));
    }

    if (!actitem) {
      // Item not found or filtered out - check if it exists but was filtered (for OG meta tags)
      if (!session && globalfilter) {
        const unfilteredItem = await db`
          select id from items where id = ${itemid} and active = true limit 1
        `;
        if (unfilteredItem[0]) {
          // Item exists but was filtered - return minimal data for OG tags with blurred thumbnail
          const hallSlug = hall && typeof hall === 'object' ? hall.slug : hall;
          return {
            success: false,
            message: "Sorry, this post is currently not visible.",
            item: {
              id: itemid,
              og_thumbnail: `${cfg.websrv.paths.thumbnails}/${itemid}_blur.webp`,
              og_url: hallSlug
                ? `https://${cfg.main.url.domain}/h/${encodeURIComponent(hallSlug)}/${itemid}`
                : `https://${cfg.main.url.domain}/${itemid}`,
              og_description: `Content not visible in current mode`
            }
          };
        }
      }
      return {
        success: false,
        message: "Sorry, this post is currently not visible."
      };
    }

    // 2. Fetch Next/Prev/Start/End/Cheat in parallel
    // Optimized: Use tags_assign driver for SFW (0) and NSFW (1) modes

    // Determine the effective mode for optimization check (similar to Random)
    const nsfl_id = cfg.nsfl_tag_id || 3;
    const useTagsDriver = (effMode === 0 || effMode === 1 || effMode === 4) && !fav && !tag && !user && !hall;

    const baseQuery = (whereClause, orderBy, limit = 1) => {
      return db`
            select items.id
            from items
            left join tags_assign on tags_assign.item_id = items.id
            left join tags on tags.id = tags_assign.tag_id
            ${fav
          ? db`inner join favorites on favorites.item_id = items.id inner join "user" on "user".id = favorites.user_id`
          : db`left join favorites on favorites.item_id = items.id left join "user" on "user".id = favorites.user_id`
        }
            where
                ${buildConditions()}
                ${whereClause}
            group by items.id
            ${orderBy}
            limit ${limit}
        `;
    };
    const optimizedBaseQuery = (whereClause, orderBy, limit = 1) => {
      if (useTagsDriver) {
        const modequery = lib.getMode(effMode);
        const tagId = (effMode === 4 ? nsfl_id : (effMode === 1 ? 2 : 1));
        const useTagIdOpt = !mimeParts.includes('audio');

        const nsfpIds = cfg.nsfp || [];
        const checkFilter = !session && nsfpIds.length > 0;

        const query = db`
                SELECT ta.item_id as id
                FROM tags_assign ta
                INNER JOIN items ON items.id = ta.item_id
                ${checkFilter
            ? db`LEFT JOIN tags_assign filter_ta ON filter_ta.item_id = ta.item_id AND filter_ta.tag_id IN ${db(nsfpIds)}`
            : db``
          }
                WHERE ${useTagIdOpt ? db`ta.tag_id = ${tagId}` : db`${db.unsafe(modequery)}`}
                AND items.active = true
                ${mimeSQL}
                ${checkFilter ? db`AND filter_ta.tag_id IS NULL` : db``}
                ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = ta.item_id and tag_id = any(${excludedTags}::int[]))` : db``}
                ${whereClause}
                ${orderBy}
                LIMIT ${limit}
             `;
        return query;
      }
      return baseQuery(whereClause, orderBy, limit);
    };

    const runTimings = startTime;
    const [nextItem, prevItem, startItem, endItem, cheatItems] = await Promise.all([
      random ? optimizedBaseQuery(db`and items.id != ${itemid}`, db`order by random()`) : optimizedBaseQuery(db`and items.id > ${itemid}`, db`order by items.id asc`),
      random ? optimizedBaseQuery(db`and items.id != ${itemid}`, db`order by random()`) : optimizedBaseQuery(db`and items.id < ${itemid}`, db`order by items.id desc`),
      optimizedBaseQuery(db``, db`order by items.id asc`),
      optimizedBaseQuery(db``, db`order by items.id desc`),
      // Cheat items - try to get a few neighbors. Simplified: just get some newer ones
      optimizedBaseQuery(db`and items.id != ${itemid}`, db`order by abs(items.id - ${itemid}) asc`, 7)
    ]);
    console.log(`[GETF0CK_OPT] Neighbor queries finished in ${Date.now() - runTimings}ms`);

    // Cheat array should include current item and neighbors, sorted
    const cheat = [itemid, ...cheatItems.map(i => i.id)].sort((a, b) => a - b);

    const tags = await lib.getTags(itemid);
    const itemHalls = await db`select h.name, h.slug from halls h join halls_assign ha on ha.hall_id = h.id where ha.item_id = ${itemid}`;
    const userHallsForItem = user_id
      ? await db`select uh.name, uh.slug from user_halls uh join user_halls_assign uha on uha.hall_id = uh.id where uha.item_id = ${itemid} and uh.user_id = ${user_id}`
      : [];
    const link = lib.genLink({ user, tag, hall: (hall && typeof hall === 'object') ? hall.slug : hall, mime, type: fav ? 'favs' : 'uploads', path: '', strict: false });
    // Override link for title searches — pagination must use the /tag/title:... prefix
    if (isTitleSearch && titleQuery) {
      link.main = `/tag/title:${encodeURIComponent(titleQuery)}/`;
      link.mainDisplay = `/tag/title:${titleQuery}/`;
      link.path = '';
      link.suffix = '';
    }
    // Override link for user hall context
    if (userHallObj && userHallOwner) {
      const ownerName = userHallObj.owner_name || userHallOwner;
      link.main = `/user/${encodeURIComponent(ownerName)}/hall/${encodeURIComponent(userHallObj.slug)}/`;
      link.mainDisplay = `/user/${ownerName}/hall/${userHallObj.slug}/`;
      link.path = '';
      link.suffix = '';
    }
    const favorites = await db`
      select "user".user, "user_options".avatar, "user_options".avatar_file, "user_options".username_color, "user_options".display_name
      from "favorites"
      left join "user" on "user".id = "favorites".user_id
      left join "user_options" on "user_options".user_id = "favorites".user_id
      where "favorites".item_id = ${itemid}
    `;

    // Detect reposts: items uploaded with bypass_duplicate_check have checksum = `{hash}_bypass_{ts}`
    // Find all items (including this one) that share the same base checksum.
    let repostItems = [];
    if (actitem.checksum && actitem.checksum.includes('_bypass_')) {
      const baseChecksum = actitem.checksum.split('_bypass_')[0];
      const repostRows = await db`
        SELECT id, username, stamp FROM items
        WHERE active = true
          AND id != ${itemid}
          AND (checksum = ${baseChecksum} OR checksum LIKE ${baseChecksum + '_bypass_%'})
        ORDER BY id ASC
      `;
      repostItems = repostRows.map(r => ({ id: r.id, username: r.username, stamp: r.stamp }));
    } else if (actitem.checksum) {
      // Even without bypass, check if other bypass-entries exist with this same hash
      const baseChecksum = actitem.checksum;
      const repostRows = await db`
        SELECT id, username, stamp FROM items
        WHERE active = true
          AND id != ${itemid}
          AND checksum LIKE ${baseChecksum + '_bypass_%'}
        ORDER BY id ASC
      `;
      repostItems = repostRows.map(r => ({ id: r.id, username: r.username, stamp: r.stamp }));
    }

    // Efficient coverart fallback
    const coverartUrl = actitem.has_coverart 
        ? `${cfg.websrv.paths.coverarts}/${actitem.id}.webp`
        : `/s/img/music.webp`;

    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] [GETF0CK_OPT] Fetch complete in ${duration}ms`);

    const isNsfl = cfg.enable_nsfl && tags.some(t => t.id == nsfl_id);
    const isNsfw = tags.some(t => t.id == 2);
    const isSfw = tags.some(t => t.id == 1);
    const isTagged = tags.length > 0;

    // Mode-mismatch visibility check:
    // Only enforce for members (session users) with an explicit mode preference.
    // Mode 0=sfw, 1=nsfw, 2=untagged, 3=all
    const userMode = Number(mode ?? 0);
    if (userMode !== 3) {
      let modeBlocked = false;
      if (userMode === 0 && (isNsfw || isNsfl)) modeBlocked = true;       // SFW mode, item is NSFW or NSFL
      else if (userMode === 1 && !isNsfw) modeBlocked = true; // NSFW mode, item is not NSFW
      else if (userMode === 4 && (!cfg.enable_nsfl || !isNsfl)) modeBlocked = true; // NSFL mode, item is not NSFL
      else if (userMode === 2 && isTagged) modeBlocked = true; // Untagged mode, item has tags

      if (modeBlocked) {
        const hallSlug = hall && typeof hall === 'object' ? hall.slug : hall;
        return {
          success: false,
          message: "Sorry, this post is currently not visible.",
          item: {
            id: itemid,
            og_thumbnail: `${cfg.websrv.paths.thumbnails}/${itemid}${isNsfw ? '_blur' : ''}.webp`,
            og_url: hallSlug
              ? `https://${cfg.main.url.domain}/h/${encodeURIComponent(hallSlug)}/${itemid}`
              : `https://${cfg.main.url.domain}/${itemid}`,
            og_description: `Content not visible in current mode`
          }
        };
      }
    }

    const data = {
      success: true,
      user: {
        name: actitem.username,
        id: actitem.author_id,
        color: actitem.author_color,
        channel: actitem.usernetwork == "Telegram" && actitem.userchannel !== cfg.websrv.domain ? "anonymous" : actitem.userchannel,
        network: actitem.usernetwork
      },
      item: {
        id: actitem.id,
        username: actitem.username,
        author_id: actitem.author_id,
        author_color: actitem.author_color,
        author_display_name: actitem.author_display_name || null,
        author_avatar: actitem.author_avatar,
        author_avatar_file: actitem.author_avatar_file,
        author_description: actitem.author_description,
        title: actitem.title || null,

        src: {
          long: actitem.src,
          short: url.parse(actitem.src).hostname,
        },
        thumbnail: `${cfg.websrv.paths.thumbnails}/${actitem.id}.webp`,
        og_thumbnail: `${cfg.websrv.paths.thumbnails}/${actitem.id}${(isNsfw || isNsfl) ? '_blur' : ''}.webp`,
        // og_url: canonical URL for OG/bots — hall context preserved, plain /<id> as fallback
        og_url: (() => {
          const hallSlug = hall && typeof hall === 'object' ? hall.slug : hall;
          if (hallSlug) return `https://${cfg.main.url.domain}/h/${encodeURIComponent(hallSlug)}/${actitem.id}`;
          return `https://${cfg.main.url.domain}/${actitem.id}`;
        })(),
        // og_description: include rating + uploader for bots (Matrix, Discord, etc.)
        og_description: (() => {
          const ratingLabel = isNsfl ? 'NSFL' : (isNsfw ? 'NSFW' : (isSfw ? 'SFW' : 'Untagged'));
          const titlePart = actitem.title ? ` · "${actitem.title}"` : '';
          return `${ratingLabel}${titlePart} · uploaded by ${actitem.username}`;
        })(),
        coverart: coverartUrl,
        dest: actitem.mime === 'video/youtube' ? actitem.dest : `${cfg.websrv.paths.images}/${actitem.dest}`,
        mime: actitem.mime,
        size: lib.formatSize(actitem.size),
        checksum: actitem.checksum,
        timestamp: {
          timeago: lib.timeAgo(new Date(actitem.stamp * 1e3).toISOString(), lang),
          timefull: new Date(actitem.stamp * 1e3).toISOString()
        },
        favorites: favorites,
        tags: tags,
        halls: itemHalls,
        user_halls: userHallsForItem,
        is_nsfw: isNsfw,
        is_nsfl: isNsfl,
        is_sfw: isSfw,
        is_pinned: actitem.is_pinned || false,
        is_comments_locked: actitem.is_comments_locked || false,
        is_oc: actitem.is_oc || false,
        is_repost: actitem.checksum ? actitem.checksum.includes('_bypass_') : false,
        reposts: repostItems,
        width: actitem.width || null,
        height: actitem.height || null
      },
      title: `${actitem.id} - ${cfg.websrv.domain}`,
      pagination: {
        end: endItem[0]?.id || itemid,
        start: startItem[0]?.id || itemid,
        next: nextItem[0]?.id || null,
        prev: prevItem[0]?.id || null,
        page: actitem.id,
        cheat: cheat
      },
      phrase: cfg.websrv.phrases[~~(Math.random() * cfg.websrv.phrases.length)],
      link,
      tmp
    };
    return data;
  }, getRandom: async ({ user: rawUser, tag: rawTag, hall: rawHall, mime: rawMime, mode, ratings, fav, session, strict, exclude, userHall: rawUserHall, userHallOwner: rawUserHallOwner } = {}) => {
    const user = rawUser ? lib.escapeLike(decodeURI(rawUser)) : null;
    const hall = rawHall || null;

    // --- title: prefix — search items.title instead of the tags table ---
    const _decodedTag = rawTag ? decodeURIComponent(rawTag) : '';
    const isTitleSearch = _decodedTag.startsWith('title:');
    const titleQuery = isTitleSearch ? _decodedTag.substring(6).trim() : null;
    const tag = isTitleSearch ? null : lib.parseTag(rawTag ?? null);

    const mime = (rawMime ?? "");
    const userHallSlug = rawUserHall || null;
    const userHallOwner = rawUserHallOwner || null;

    // Resolve user hall to get its ID for filtering
    let userHallId = null;
    if (userHallSlug && userHallOwner) {
      const uhRows = await db`
        SELECT uh.id FROM user_halls uh
        JOIN "user" u ON u.id = uh.user_id
        WHERE u."user" ILIKE ${userHallOwner} AND uh.slug = ${userHallSlug}
        LIMIT 1
      `;
      userHallId = uhRows[0]?.id || null;
    }

    // Support multiple MIME types (comma separated)
    const mimeParts = (mime || "").split(',').filter(m => ['video', 'audio', 'image', 'flash', 'pdf'].includes(m));
    const mimeSQL = mimeParts.length > 0
      ? db`and (${mimeParts.map(m => m === 'flash'
          ? (flashMimes.length > 0
              ? flashMimes.map(fm => db`items.mime = ${fm}`).reduce((a, b) => db`${a} or ${b}`)
              : db`false`)
          : (m === 'pdf' ? db`items.mime = 'application/pdf'` : db`items.mime ilike ${m + '/%'}`)).reduce((a, b) => db`${a} or ${b}`)})`
      : db``;
    const excludedTags = session && exclude ? (exclude || []) : [];
    
    const strictParams = ((strict || (tag && tag.includes(','))) && tag) ? tag.split(',').map(t => lib.slugify(t)).filter(t => t) : [];
    const isStrict = strictParams.length > 0;
    
    const multiRatingSQL = (Array.isArray(ratings) && ratings.length > 0) ? lib.getMultiRatingMode(ratings) : null;
    const baseMode = multiRatingSQL ?? lib.getMode(mode ?? 0);
    const modequery = baseMode;

    let item;

    if (isTitleSearch && titleQuery) {
      // Title search random: filter by items.title, no tag join needed
      item = await db`
        SELECT items.id
        FROM items
        WHERE
          ${db.unsafe(modequery)}
          AND items.active = true
          AND items.title ILIKE ${'%' + titleQuery + '%'}
          AND items.title IS NOT NULL
          ${mimeSQL}
          ${!session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(globalfilter)}))` : db``}
          ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        ORDER BY random()
        LIMIT 1
      `;
    } else if (fav && user) {
      // Special case: random from user's favorites
      item = await db`
        select
          items.id
        from favorites
        inner join items on favorites.item_id = items.id
        inner join "user" on "user".id = favorites.user_id
        left join tags_assign on tags_assign.item_id = items.id
        left join tags on tags.id = tags_assign.tag_id
        where
          ${db.unsafe(modequery)}
          and "user".user ilike ${user}
          and items.active = true
          ${mimeSQL}
          ${!session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(globalfilter)}))` : db``}
        group by items.id
        order by random()
        limit 1
      `;
    } else if (user || tag) {
      // Normal random logic for filtered requests (user or tag specified)
      let tagFilter = db``;
      if (tag) {
        const terms = tag.split(',').map(t => t.trim()).filter(Boolean);
        if (terms.length > 0) {
            if (isStrict) {
                tagFilter = db`and items.id in (
                    select ta.item_id 
                    from tags_assign ta 
                    join tags t on t.id = ta.tag_id 
                    where t.normalized = ANY(ARRAY(SELECT slugify(x) FROM unnest(${terms}::text[]) AS x))
                    group by ta.item_id 
                    having count(distinct t.normalized) = ${terms.length}
                )`;
            } else {
                const conditions = terms.map(term => {
                    return db`and items.id in (select ta.item_id from tags_assign ta join tags t on t.id = ta.tag_id where t.normalized like '%' || slugify(${term}) || '%')`;
                });
                tagFilter = db`${conditions}`;
            }
        }
      }

      item = await db`
        select
          items.id
        from items
        left join tags_assign on tags_assign.item_id = items.id
        left join tags on tags.id = tags_assign.tag_id
        where
          ${db.unsafe(modequery)}
          and items.active = true
          ${tagFilter}
          ${user ? db`and items.username ilike ${user}` : db``}
          ${hall ? db`and items.id in (select item_id from halls_assign ha join halls h on h.id = ha.hall_id where h.slug = ${hall})` : db``}
          ${mimeSQL}
          ${!session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(globalfilter)}))` : db``}
          ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        group by items.id, tags.tag
        order by random()
        limit 1
      `;
    } else if (hall) {
      // Random within a site hall (no user or tag filter)
      item = await db`
        select
          items.id
        from items
        join halls_assign ha on ha.item_id = items.id
        join halls h on h.id = ha.hall_id
        where
          ${db.unsafe(modequery)}
          and h.slug = ${hall}
          and items.active = true
          ${mimeSQL}
          ${!session && globalfilter ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(globalfilter)}))` : db``}
          ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        order by random()
        limit 1
      `;
    } else if (userHallId) {
      // Random within a user hall
      item = await db`
        select items.id
        from items
        join user_halls_assign uha on uha.item_id = items.id
        where
          ${db.unsafe(modequery)}
          and uha.hall_id = ${userHallId}
          and items.active = true
          ${mimeSQL}
          ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        order by random()
        limit 1
      `;
    } else {
      // Uniform random logic for global requests (no user/tag/hall)
      // When multi-rating SQL is active, use it directly. Otherwise use the tag-join optimisation.
      const globalModeQuery = multiRatingSQL ?? lib.getMode(mode ?? 0);
      // tagId optimisation only applies for single native modes (not multi-rating)
      const tagId = !multiRatingSQL && (mode === 0 || mode === 1 || mode === 4)
        ? (mode === 4 ? (cfg.nsfl_tag_id || 3) : (mode === 1 ? 2 : 1))
        : null;
      // If audio is included, we avoid the strict tagId optimization to ensure audio is visible
      const useTagIdOpt = tagId && !mimeParts.includes('audio');
      const nsfpIds = cfg.nsfp || [];
      const checkFilter = !session && nsfpIds.length > 0;

      // Use a single uniform query with ORDER BY random()
      // For 30k-100k items, this is performant enough and much more reliable than seeking.
      item = await db`
        SELECT items.id
        FROM items
        ${useTagIdOpt ? db`INNER JOIN tags_assign ta ON ta.item_id = items.id AND ta.tag_id = ${tagId}` : db``}
        ${checkFilter ? db`LEFT JOIN tags_assign filter_ta ON filter_ta.item_id = items.id AND filter_ta.tag_id IN ${db(nsfpIds)}` : db``}
        WHERE items.active = true
          ${mimeSQL}
          ${checkFilter ? db`AND filter_ta.tag_id IS NULL` : db``}
          ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
          ${!useTagIdOpt ? db`AND ${db.unsafe(globalModeQuery)}` : db``}
        ORDER BY random()
        LIMIT 1
      `;
    }

    if (item.length === 0) {
      return {
        success: false,
        message: "no uploads found :("
      };
    }

    const link = lib.genLink({ user, tag, hall, mime, type: fav ? 'favs' : 'uploads' });

    return {
      success: true,
      link,
      itemid: item[0].id
    };
  },
  getComments: async (itemId, sort = 'new', process = true) => {
    if (!itemId) return [];
    const tStart = Date.now();
    try {
      const comments = await db`
            SELECT
                c.id, c.parent_id, c.content, c.created_at, c.vote_score, c.is_deleted,
                COALESCE(c.is_pinned, false) as is_pinned,
                c.video_time,
                u.user as username, u.id as user_id, uo.avatar, uo.avatar_file, uo.username_color, uo.display_name,
                (SELECT count(*) FROM comments r WHERE r.parent_id = c.id) as reply_count
            FROM comments c
            JOIN "user" u ON c.user_id = u.id
            LEFT JOIN user_options uo ON uo.user_id = u.id
            WHERE c.item_id = ${itemId} AND c.is_deleted = false
            ORDER BY COALESCE(c.is_pinned, false) DESC,
                CASE WHEN ${sort !== 'new'} THEN c.created_at END ASC,
                CASE WHEN ${sort === 'new'} THEN c.created_at END DESC
        `;

      // Fetch comment file attachments
      if (comments.length > 0) {
        const commentIds = comments.map(c => c.id);
        try {
          const files = await db`
            SELECT id, comment_id, dest, mime, size, original_filename
            FROM comment_files
            WHERE comment_id = ANY(${commentIds}::int[])
            ORDER BY id ASC
          `;
          const filesMap = new Map();
          for (const f of files) {
            if (!filesMap.has(f.comment_id)) filesMap.set(f.comment_id, []);
            filesMap.get(f.comment_id).push(f);
          }
          for (const c of comments) {
            c.files = filesMap.get(c.id) || [];
          }
        } catch (e) {
          // Table might not exist yet, gracefully degrade
          for (const c of comments) c.files = [];
        }

        // Fetch poll data for comments that have one
        try {
          const pollRows = await db`
            SELECT
              cp.id as poll_id,
              cp.comment_id,
              cp.question,
              cp.expires_at,
              json_agg(
                json_build_object(
                  'id', cpo.id,
                  'text', cpo.text,
                  'sort_order', cpo.sort_order,
                  'vote_count', COALESCE(vote_counts.cnt, 0)
                ) ORDER BY cpo.sort_order ASC, cpo.id ASC
              ) AS options,
              COALESCE(SUM(vote_counts.cnt), 0)::int AS total_votes
            FROM comment_polls cp
            JOIN comment_poll_options cpo ON cpo.poll_id = cp.id
            LEFT JOIN (
              SELECT option_id, COUNT(*) AS cnt
              FROM comment_poll_votes
              GROUP BY option_id
            ) vote_counts ON vote_counts.option_id = cpo.id
            WHERE cp.comment_id = ANY(${commentIds}::int[])
            GROUP BY cp.id, cp.comment_id, cp.question, cp.expires_at
          `;
          const pollMap = new Map();
          for (const p of pollRows) {
            pollMap.set(p.comment_id, {
              id: p.poll_id,
              question: p.question,
              expires_at: p.expires_at,
              options: p.options,
              total_votes: parseInt(p.total_votes) || 0,
              user_vote_option_id: null // filled in per-request context if needed
            });
          }
          for (const c of comments) {
            c.poll = pollMap.get(c.id) || null;
          }
        } catch (e) {
          // Poll tables might not exist yet
          for (const c of comments) c.poll = null;
        }
      }

      console.log(`[${new Date().toISOString()}] [GETCOMMENTS] Fetched ${comments.length} comments for item ${itemId} in ${Date.now() - tStart}ms`);

      // Process mentions (now includes embeds)
      return process ? await processMentions(comments) : comments;
    } catch (e) {
      console.error('[F0CKLIB] Error fetching comments:', e);
      return [];
    }
  },
  getComment: async (id, process = true) => {
    if (!id) return null;
    try {
      const comment = await db`
            SELECT
                c.id, c.parent_id, c.item_id, c.content, c.created_at, c.vote_score, c.is_deleted,
                COALESCE(c.is_pinned, false) as is_pinned,
                c.video_time,
                u.user as username, u.id as user_id, uo.avatar, uo.avatar_file, uo.username_color, uo.display_name
            FROM comments c
            JOIN "user" u ON c.user_id = u.id
            LEFT JOIN user_options uo ON uo.user_id = u.id
            WHERE c.id = ${id} AND c.is_deleted = false
            LIMIT 1
        `;
      if (!comment.length) return null;

      // Fetch comment file attachments
      try {
        const files = await db`
          SELECT id, comment_id, dest, mime, size, original_filename
          FROM comment_files
          WHERE comment_id = ${id}
          ORDER BY id ASC
        `;
        comment[0].files = files;
      } catch (e) {
        comment[0].files = [];
      }

      return process ? (await processMentions(comment))[0] : comment[0];
    } catch (e) {
      console.error('[F0CKLIB] Error fetching comment:', e);
      return null;
    }
  },
  getSubscriptionStatus: async (userId, itemId) => {
    if (!userId || !itemId) return false;
    const tStart = Date.now();
    try {
      const sub = await db`SELECT 1 FROM comment_subscriptions WHERE user_id = ${userId} AND item_id = ${itemId} AND is_subscribed = true`;
      console.log(`[${new Date().toISOString()}] [GETSUB] Checked sub for item ${itemId} in ${Date.now() - tStart}ms`);
      return sub.length > 0;
    } catch (e) {
      return false;
    }
  },
  processMentions,
  markNotificationsRead: async (userId, itemId) => {
    if (!userId || !itemId) return;
    try {
      await db`UPDATE notifications SET is_read = true WHERE user_id = ${userId} AND item_id = ${itemId} AND is_read = false`;
    } catch (e) {
      console.error('[F0CKLIB] Error marking notifications as read:', e);
    }
  },
  getHalls: async () => {
    try {
      return await db`
        SELECT h.*,
               COUNT(DISTINCT CASE WHEN i.active = true THEN ha.item_id END)::int AS item_count
        FROM halls h
        LEFT JOIN halls_assign ha ON ha.hall_id = h.id
        LEFT JOIN items i ON i.id = ha.item_id
        GROUP BY h.id
        ORDER BY h.name ASC
      `;
    } catch (e) {
      console.error('[F0CKLIB] Error fetching halls:', e);
      return [];
    }
  },
  getHallsOverview: async (mode = 0, excludedTags = []) => {
    const userExcludeFilter = excludedTags.length > 0
      ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign ta_ex WHERE ta_ex.item_id = i.id AND ta_ex.tag_id = ANY(${excludedTags}::int[]))`
      : db``;

    const modeNum = Number(mode) || 0;

    // Filter halls by their rating column to match the current mode.
    // The hall's own rating is the source of truth for mode gating — the old
    // item-level modeFilter (tag_id check) caused NSFW halls to show 0 posts
    // when items didn't carry the exact NSFW tag_id.
    // mode 0=sfw -> rating='sfw', mode 1=nsfw -> rating='nsfw', mode 4=nsfl -> rating='nsfl'
    // mode 3=all and mode 2=untagged show all halls
    const hallRating = modeNum === 0 ? 'sfw' : modeNum === 1 ? 'nsfw' : modeNum === 4 ? 'nsfl' : null;
    const ratingFilter = hallRating ? db`AND h.rating = ${hallRating}` : db``;

    try {
      return await db`
        SELECT
          h.id,
          h.name,
          h.slug,
          h.description,
          h.rating,
          h.custom_image,
          COALESCE(counts.total_items, 0) AS total_items,
          counts.latest_item_id
        FROM halls h
        LEFT JOIN (
          SELECT
            ha.hall_id,
            COUNT(DISTINCT ha.item_id) AS total_items,
            MAX(i.id) AS latest_item_id
          FROM halls_assign ha
          JOIN items i ON i.id = ha.item_id
          WHERE i.active = true
            ${userExcludeFilter}
          GROUP BY ha.hall_id
        ) counts ON counts.hall_id = h.id
        WHERE true ${ratingFilter}
        ORDER BY h.name ASC
      `;
    } catch (e) {
      console.error('[F0CKLIB] Error fetching halls overview:', e);
      return [];
    }
  },
  addItemToHall: async (itemId, hallInput, userId, description = null) => {
    try {
      // 1. Try to find by exact slug match (e.g. if selected from dropdown)
      let hall = await db`SELECT id, slug FROM halls WHERE slug = ${hallInput} LIMIT 1`;
      
      if (!hall.length) {
        // 2. Not found by exact slug, so it's likely a new name or a manually typed existing name.
        // Slugify the input to find a matching slug.
        const generatedSlug = lib.slugify(hallInput);
        hall = await db`SELECT id FROM halls WHERE slug = ${generatedSlug} LIMIT 1`;
        
        if (!hall.length) {
            // 3. Truly new hall - create it
            // Use the original input (trimmed) for the display name, but use the generated slug.
            const hallName = hallInput.trim();
            if (!hallName || !generatedSlug) throw new Error("Invalid hall name");

            await db`INSERT INTO halls (name, slug, description) VALUES (${hallName}, ${generatedSlug}, ${description})`;
            hall = await db`SELECT id FROM halls WHERE slug = ${generatedSlug} LIMIT 1`;
            
            // Update global cache (if there's a cached list used elsewhere)
            try {
                if (typeof updateHallsCache === 'function') await updateHallsCache();
            } catch (ce) {}
        } else if (description) {
            // Existing hall found by slug but created/selected, update description if provided
            await db`UPDATE halls SET description = ${description} WHERE id = ${hall[0].id}`;
        }
      } else if (description) {
        // Found by exact slug, update description if provided
        await db`UPDATE halls SET description = ${description} WHERE id = ${hall[0].id}`;
      }
      
      const insertResult = await db`
        INSERT INTO halls_assign (hall_id, item_id, user_id)
        VALUES (${hall[0].id}, ${+itemId}, ${userId})
        ON CONFLICT (hall_id, item_id) DO NOTHING
      `;
      if (insertResult.count === 0) {
        return { success: false, message: 'Item is already in this hall' };
      }
      return { success: true };
    } catch (e) {
      console.error('[F0CKLIB] Error adding item to hall:', e);
      return { success: false, message: e.message };
    }
  },
  updateHallMetadata: async (hallSlug, description) => {
    try {
      const result = await db`UPDATE halls SET description = ${description} WHERE slug = ${hallSlug}`;
      if (result.count === 0) throw new Error('Hall not found');
      
      // Update global cache
      try {
        if (typeof updateHallsCache === 'function') await updateHallsCache();
      } catch (ce) {}
      
      return { success: true };
    } catch (e) {
      console.error('[F0CKLIB] Error updating hall metadata:', e);
      return { success: false, message: e.message };
    }
  },
  removeItemFromHall: async (itemId, hallSlug) => {
    try {
      const hall = await db`SELECT id FROM halls WHERE slug = ${hallSlug} LIMIT 1`;
      if (!hall.length) throw new Error('Hall not found');

      await db`
        DELETE FROM halls_assign
        WHERE hall_id = ${hall[0].id} AND item_id = ${+itemId}
      `;
      
      return { success: true };
    } catch (e) {
      console.error('[F0CKLIB] Error removing item from hall:', e);
      return { success: false, message: e.message };
    }
  },

  // ── User Hall helpers ──────────────────────────────────────────────────────

  getUserHalls: async (userId, mode = 0, excludedTags = [], viewerUserId = null) => {
    const modeNum = Number(mode) || 0;
    const modeFilter = modeNum === 1 ? db`AND i.id IN (SELECT item_id FROM tags_assign WHERE tag_id = 2)`
      : modeNum === 2 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = i.id)`
      : modeNum === 3 ? db``
      : db`AND i.id IN (SELECT item_id FROM tags_assign WHERE tag_id = 1)`;

    const userExcludeFilter = excludedTags.length > 0
      ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign ta_ex WHERE ta_ex.item_id = i.id AND ta_ex.tag_id = ANY(${excludedTags}::int[]))`
      : db``;

    // Private halls: only visible to owner or admin
    const privateFilter = (viewerUserId && viewerUserId === userId)
      ? db``   // owner sees all
      : db`AND uh.is_private = false`;

    try {
      return await db`
        SELECT
          uh.id,
          uh.name,
          uh.slug,
          uh.description,
          uh.is_private,
          uh.custom_image,
          uh.created_at,
          COALESCE(counts.total_items, 0) AS total_items,
          counts.latest_item_id
        FROM user_halls uh
        LEFT JOIN (
          SELECT
            uha.hall_id,
            COUNT(DISTINCT uha.item_id) AS total_items,
            MAX(i.id) AS latest_item_id
          FROM user_halls_assign uha
          JOIN items i ON i.id = uha.item_id
          WHERE i.active = true
            ${modeFilter}
            ${userExcludeFilter}
          GROUP BY uha.hall_id
        ) counts ON counts.hall_id = uh.id
        WHERE uh.user_id = ${userId}
          ${privateFilter}
        ORDER BY uh.name ASC
      `;
    } catch (e) {
      console.error('[F0CKLIB] Error fetching user halls:', e);
      return [];
    }
  },

  getUserHall: async (userId, slug) => {
    try {
      const rows = await db`
        SELECT uh.*, u."user" as owner_name
        FROM user_halls uh
        JOIN "user" u ON u.id = uh.user_id
        WHERE uh.user_id = ${userId} AND uh.slug = ${slug}
        LIMIT 1
      `;
      return rows[0] || null;
    } catch (e) {
      console.error('[F0CKLIB] Error fetching user hall:', e);
      return null;
    }
  },

  getUserHallByOwnerName: async (ownerName, slug) => {
    try {
      const rows = await db`
        SELECT uh.*, u."user" as owner_name
        FROM user_halls uh
        JOIN "user" u ON u.id = uh.user_id
        WHERE u."user" ILIKE ${ownerName} AND uh.slug = ${slug}
        LIMIT 1
      `;
      return rows[0] || null;
    } catch (e) {
      console.error('[F0CKLIB] Error fetching user hall by owner name:', e);
      return null;
    }
  },

  createUserHall: async (userId, name, slug, description = null) => {
    try {
      if (!name || !slug) throw new Error('Missing name or slug');
      const exists = await db`SELECT id FROM user_halls WHERE user_id = ${userId} AND slug = ${slug} LIMIT 1`;
      if (exists.length) return { success: false, message: 'A hall with this slug already exists' };
      const result = await db`
        INSERT INTO user_halls (user_id, name, slug, description)
        VALUES (${userId}, ${name}, ${slug}, ${description || null})
        RETURNING id, name, slug
      `;
      return { success: true, hall: result[0] };
    } catch (e) {
      console.error('[F0CKLIB] Error creating user hall:', e);
      return { success: false, message: e.message };
    }
  },

  updateUserHall: async (userId, slug, { name, newSlug, description, is_private }) => {
    try {
      const hall = await db`SELECT id FROM user_halls WHERE user_id = ${userId} AND slug = ${slug} LIMIT 1`;
      if (!hall.length) return { success: false, message: 'Hall not found' };
      const hallId = hall[0].id;

      // Check slug conflict (if renaming)
      if (newSlug && newSlug !== slug) {
        const conflict = await db`SELECT id FROM user_halls WHERE user_id = ${userId} AND slug = ${newSlug} AND id != ${hallId} LIMIT 1`;
        if (conflict.length) return { success: false, message: 'Slug already taken' };
      }

      await db`
        UPDATE user_halls SET
          name        = COALESCE(${name       ?? null}, name),
          slug        = COALESCE(${newSlug    ?? null}, slug),
          description = ${description !== undefined ? (description || null) : db`description`},
          is_private  = COALESCE(${is_private ?? null}, is_private)
        WHERE id = ${hallId}
      `;
      return { success: true, newSlug: newSlug || slug };
    } catch (e) {
      console.error('[F0CKLIB] Error updating user hall:', e);
      return { success: false, message: e.message };
    }
  },

  deleteUserHall: async (userId, slug) => {
    try {
      const result = await db`DELETE FROM user_halls WHERE user_id = ${userId} AND slug = ${slug}`;
      if (result.count === 0) return { success: false, message: 'Hall not found' };
      return { success: true };
    } catch (e) {
      console.error('[F0CKLIB] Error deleting user hall:', e);
      return { success: false, message: e.message };
    }
  },

  addItemToUserHall: async (hallId, itemId, addedByUserId) => {
    try {
      // Verify item exists and is active
      const item = await db`SELECT id FROM items WHERE id = ${+itemId} AND active = true LIMIT 1`;
      if (!item.length) return { success: false, message: 'Item not found or not active' };

      const result = await db`
        INSERT INTO user_halls_assign (hall_id, item_id, user_id)
        VALUES (${hallId}, ${+itemId}, ${addedByUserId})
        ON CONFLICT (hall_id, item_id) DO NOTHING
      `;
      if (result.count === 0) return { success: false, message: 'Item is already in this hall' };
      return { success: true };
    } catch (e) {
      console.error('[F0CKLIB] Error adding item to user hall:', e);
      return { success: false, message: e.message };
    }
  },

  removeItemFromUserHall: async (hallId, itemId) => {
    try {
      await db`DELETE FROM user_halls_assign WHERE hall_id = ${hallId} AND item_id = ${+itemId}`;
      return { success: true };
    } catch (e) {
      console.error('[F0CKLIB] Error removing item from user hall:', e);
      return { success: false, message: e.message };
    }
  },

  computeXdScore,
  xdScoreMeta
};
