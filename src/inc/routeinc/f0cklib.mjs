import db from "../sql.mjs";
import lib from "../lib.mjs";
import cfg from "../config.mjs";
import { getEnableItemSlugs, canAnonDo, getAnonAllowedModes, getAnonAllowedMimes, isAnonSession, getSessionOwnerName } from "../settings.mjs";
import { updateHallsCache } from "../halls_cache.mjs";
import queue from "../queue.mjs";
import fs from "fs";
import path from "path";
import url from "url";

const getGlobalfilter = (session) => {
  if (!cfg.nsfp?.length) return null;
  let filteredTags = [...cfg.nsfp];
  // allowed_modes controls access to NSFW/NSFL for anon/guests by stripping the RATING tags
  // (tag_id 2 = NSFW, nsfl_tag_id = NSFL) from the nsfp filter.
  // Any other nsfp tags (content-specific blocks) are never stripped — they always apply.
  const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
  if (session && isAnonSession(session)) {
    const allowedModes = getAnonAllowedModes();
    if (allowedModes.includes('nsfw')) {
      filteredTags = filteredTags.filter(id => id !== 2);
    }
    if (allowedModes.includes('nsfl')) {
      filteredTags = filteredTags.filter(id => id !== nsflId);
    }
  } else if (!session) {
    // Guest (not logged in): use public_nsfw / public_nsfl settings
    if (cfg.websrv.public_nsfw) {
      filteredTags = filteredTags.filter(id => id !== 2);
    }
  } else {
    // Logged-in member: rating tags are not filtered by nsfp
    filteredTags = filteredTags.filter(id => id !== 2 && id !== nsflId);
  }
  return filteredTags.length ? filteredTags.map(n => `tag_id = ${n}`).join(" or ") : null;
};

const computeBaseMode = (mode, ratings, session) => {
  let effMode = Number(mode ?? 0);
  const ratingsArr = (Array.isArray(ratings) && ratings.length > 0) ? ratings : null;

  // For guest sessions, strictly force SFW mode and SFW rating
  let safeRatingsArr = ratingsArr;
  const isGuest = !session || !session.user;
  if (isGuest) {
    effMode = 0;
    safeRatingsArr = ['sfw'];
  } else if (isAnonSession(session)) {
    const allowedModes = getAnonAllowedModes();
    const canFilter = canAnonDo('filter');

    if (!canFilter) {
      safeRatingsArr = null;
      effMode = 0;
    } else {
      if (safeRatingsArr) {
        safeRatingsArr = safeRatingsArr.filter(r => allowedModes.includes(r));
        if (safeRatingsArr.length === 0) {
          safeRatingsArr = (allowedModes.length === 1 && !allowedModes.includes('all'))
            ? [allowedModes[0]]
            : (allowedModes.length < 5 ? [...allowedModes] : null);
        }
      }
    }

    const modeNames = ['sfw', 'nsfw', 'untagged', 'all', 'nsfl'];
    const currentModeName = modeNames[effMode] || 'sfw';

    if (effMode === 3) {
      if (allowedModes.length < 5) {
        safeRatingsArr = [...allowedModes];
      }
    } else if (!allowedModes.includes(currentModeName)) {
      const fallbackModeName = allowedModes[0] || 'sfw';
      const fallbackModeIdx = modeNames.indexOf(fallbackModeName);
      effMode = fallbackModeIdx >= 0 ? fallbackModeIdx : 0;
    }
  }

  let baseMode;
  if (effMode === 2) {
    if (safeRatingsArr && safeRatingsArr.includes('untagged') && safeRatingsArr.length > 1) {
      baseMode = lib.getMultiRatingMode(safeRatingsArr);
    } else {
      baseMode = lib.getMode(2);
    }
  } else if (effMode === 3) {
    baseMode = (safeRatingsArr && safeRatingsArr.length > 1) ? lib.getMultiRatingMode(safeRatingsArr) : lib.getMode(3);
  } else {
    const multiRatingSQL = safeRatingsArr ? lib.getMultiRatingMode(safeRatingsArr) : null;
    baseMode = multiRatingSQL ?? lib.getMode(effMode);
  }

  if (!session) {
    const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
    if ((effMode === 0 || effMode === 3 || mode === undefined || mode === null) && (!safeRatingsArr || safeRatingsArr.length <= 1)) {
      if (cfg.websrv.public_nsfw) {
        baseMode = cfg.websrv.public_untagged
          ? `(items.id in (select item_id from tags_assign where tag_id in (1, 2)) or not exists (select 1 from tags_assign where item_id = items.id and tag_id in (1, 2, ${nsflId})))`
          : "items.id in (select item_id from tags_assign where tag_id in (1, 2))";
      } else {
        baseMode = cfg.websrv.public_untagged
          ? `(items.id in (select item_id from tags_assign where tag_id = 1) or not exists (select 1 from tags_assign where item_id = items.id and tag_id in (1, 2, ${nsflId})))`
          : "items.id in (select item_id from tags_assign where tag_id = 1)";
      }
    } else if (effMode === 2) {
      if (!cfg.websrv.public_untagged) {
        baseMode = "items.id in (select item_id from tags_assign where tag_id = 1)";
      }
    } else if (effMode === 1) {
      if (!cfg.websrv.public_nsfw) {
        baseMode = "items.id in (select item_id from tags_assign where tag_id = 1)";
      }
    } else if (effMode === 4) {
      baseMode = "1 = 0";
    }
  } else if (isAnonSession(session)) {
    const allowedModes = getAnonAllowedModes();
    const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
    if (!allowedModes.includes('nsfl')) {
      baseMode = `(${baseMode}) and not exists (select 1 from tags_assign where item_id = items.id and tag_id = ${nsflId})`;
    }
    if (!allowedModes.includes('nsfw')) {
      baseMode = `(${baseMode}) and not exists (select 1 from tags_assign where item_id = items.id and tag_id = 2)`;
    }
    if (!allowedModes.includes('untagged')) {
      baseMode = `(${baseMode}) and exists (select 1 from tags_assign where item_id = items.id and tag_id in (1, 2, ${nsflId}))`;
    }
    if (!allowedModes.includes('sfw')) {
      baseMode = `(${baseMode}) and not exists (select 1 from tags_assign where item_id = items.id and tag_id = 1)`;
    }
    // Uploaders always see their own untagged items, even when 'untagged' isn't an allowed anon mode.
    // The name is interpolated into raw SQL, so only accept the plain shadow-login charset.
    // Only `items.id` may reference the outer row: some callers alias items (e.g. comments.mjs rewrites items.id → i.id).
    const ownerName = getSessionOwnerName(session);
    if (!allowedModes.includes('untagged') && ownerName && /^[a-z0-9_]+$/i.test(ownerName)) {
      baseMode = `((${baseMode}) or items.id in (select own.id from items own where lower(own.username) = '${ownerName.toLowerCase()}' and not exists (select 1 from tags_assign ota where ota.item_id = own.id and ota.tag_id in (1, 2, ${nsflId}))))`;
    }
  }
  return baseMode;
};


const resolveNumericItemId = async (itemIdOrSlug) => {
  if (!itemIdOrSlug) return null;
  if (typeof itemIdOrSlug === 'number') return itemIdOrSlug;
  if (/^\d+$/.test(String(itemIdOrSlug))) return parseInt(itemIdOrSlug, 10);
  try {
    const rows = await db`SELECT id FROM items WHERE slug = ${String(itemIdOrSlug)} LIMIT 1`;
    if (rows[0]?.id) return rows[0].id;
    const subRows = await db`SELECT item_id FROM album_items WHERE slug = ${String(itemIdOrSlug)} LIMIT 1`;
    return subRows[0]?.item_id || null;
  } catch (e) {
    return null;
  }
};

// All MIME types that map to the 'swf' extension in config (e.g. application/x-shockwave-flash, application/vnd.adobe.flash.movie)
const flashMimes = Object.entries(cfg.mimes || {}).filter(([, ext]) => ext === 'swf').map(([mime]) => mime);

const resolveMimeSQL = (rawMime, session, itemAlias = 'items') => {
  let mimeParts = (rawMime || "").split(',').filter(m => ['video', 'audio', 'image', 'flash', 'pdf'].includes(m));
  if (isAnonSession(session)) {
    const allowedMimes = getAnonAllowedMimes();
    const canFilter = canAnonDo('filter');
    if (!canFilter || allowedMimes.length === 1) {
      mimeParts = allowedMimes.length < 5 ? [...allowedMimes] : [];
    } else {
      if (mimeParts.length > 0) {
        mimeParts = mimeParts.filter(m => allowedMimes.includes(m));
        if (mimeParts.length === 0) {
          mimeParts = allowedMimes.length < 5 ? [...allowedMimes] : [];
        }
      } else if (allowedMimes.length < 5) {
        mimeParts = [...allowedMimes];
      }
    }
  }

  const mimeSQL = mimeParts.length > 0
    ? db`and (${mimeParts.map(m => m === 'flash'
        ? (flashMimes.length > 0
            ? (itemAlias === 'i' ? flashMimes.map(fm => db`i.mime = ${fm}`).reduce((a, b) => db`${a} or ${b}`) : flashMimes.map(fm => db`items.mime = ${fm}`).reduce((a, b) => db`${a} or ${b}`))
            : db`false`)
        : (m === 'pdf' ? (itemAlias === 'i' ? db`i.mime = 'application/pdf'` : db`items.mime = 'application/pdf'`) : (itemAlias === 'i' ? db`i.mime ilike ${m + '/%'}` : db`items.mime ilike ${m + '/%'}`))).reduce((a, b) => db`${a} or ${b}`)})`
    : db``;

  return { mimeParts, mimeSQL };
};

// ── Count cache ─────────────────────────────────────────────────────────────
// The COUNT(DISTINCT items.id) in getf0cks is expensive (full filtered scan).
// Cache it per unique filter combination for 90 seconds so that navigating
// between pages 1→192 with the same filters skips the COUNT entirely.
const COUNT_CACHE_TTL_MS = 90_000;
const countCache = new Map(); // key → { total, expiresAt }

function buildCountCacheKey({ modequery, tag, user, hall, mime, fav, session, excludedTags, newerThan, minXd, userHallObj, tagger }) {
  return JSON.stringify([
    modequery,
    tag ?? '',
    user ?? '',
    hall ?? '',
    mime ?? '',
    fav ? 1 : 0,
    (session && !isAnonSession(session)) ? 1 : 0,          // guests and anon users get globalfilter applied; members don't
    excludedTags.slice().sort().join(','),
    newerThan ?? '',
    minXd,
    userHallObj?.id ?? '',
    tagger ?? ''
  ]);
}

function getCachedCount(key) {
  const entry = countCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { countCache.delete(key); return null; }
  return entry.total;
}

function setCachedCount(key, total) {
  countCache.set(key, { total, expiresAt: Date.now() + COUNT_CACHE_TTL_MS });
  // Prevent unbounded growth — evict all expired entries when cache grows large
  if (countCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of countCache) { if (now > v.expiresAt) countCache.delete(k); }
  }
}
// ────────────────────────────────────────────────────────────────────────────

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

async function checkFavoritesAccess(rawUser, { session, user_id, is_admin } = {}) {
  if (!rawUser) return { isPrivate: false, isAllowed: true };
  const decodedUser = decodeURI(rawUser);
  const targetUserRows = await db`
    select u.id, u."user", u.admin, uo.favorites_private
    from "user" u
    left join user_options uo on uo.user_id = u.id
    where u."user" ilike ${decodedUser} or u.login ilike ${decodedUser}
    limit 1
  `;
  if (!targetUserRows.length || !targetUserRows[0].favorites_private) {
    return { isPrivate: false, isAllowed: true };
  }

  const targetUser = targetUserRows[0];

  let reqUserId = user_id;
  let reqIsAdmin = is_admin;

  if (typeof session === 'object' && session !== null) {
    if (reqUserId === undefined) reqUserId = session.id;
    if (reqIsAdmin === undefined) reqIsAdmin = !!session.admin;
  }

  let isAllowed = false;
  if (reqUserId) {
    if (+reqUserId === +targetUser.id) {
      isAllowed = true;
    } else if (reqIsAdmin === true) {
      isAllowed = true;
    } else if (reqIsAdmin === undefined) {
      const reqUserRows = await db`select admin from "user" where id = ${+reqUserId} limit 1`;
      if (reqUserRows.length > 0 && reqUserRows[0].admin) {
        isAllowed = true;
      }
    }
  }

  return { isPrivate: true, isAllowed };
}

const buildFeedFilters = async ({
  rawUser,
  rawTag,
  rawHall,
  rawMime,
  mode,
  ratings,
  session,
  strict,
  exclude,
  newer,
  minXdScore,
  rawUserHall,
  rawUserHallOwner,
  rawTagger
}) => {
  const user = rawUser ? decodeURI(rawUser) : null;
  const userLike = user ? lib.escapeLike(user) : null;

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
  const { mimeParts, mimeSQL } = resolveMimeSQL(mime, session);

  const excludedTags = session && exclude ? (exclude || []) : [];
  const newerThan = newer ? parseInt(newer) : null;
  const minXd = (minXdScore && +minXdScore > 0) ? +minXdScore : 0;
  const xdFilter = minXd > 0 ? db`and items.xd_score >= ${minXd}` : db``;

  const strictParams = ((strict || (tag && tag.includes(','))) && tag) ? tag.split(',').map(t => lib.slugify(t)).filter(t => t) : [];
  const isStrict = strictParams.length > 0;

  const tagger = rawTagger ? lib.escapeLike(rawTagger) : null;
  const modequery = computeBaseMode(mode, ratings, session);

  let tagFilter = db``;
  let titleFilter = db``;
  if (isTitleSearch && titleQuery) {
    titleFilter = db`and items.title ILIKE ${'%' + titleQuery + '%'} and items.title IS NOT NULL`;
  } else if (tagger && tag) {
    const terms = tag.split(',').map(t => t.trim()).filter(Boolean);
    if (terms.length > 0) {
      const conditions = terms.map(term => {
        return db`and (items.id in (
          select ta.item_id from tags_assign ta
          join tags t on t.id = ta.tag_id
          join "user" u on u.id = ta.user_id
          where t.normalized like '%' || slugify(${term}) || '%'
          and u.user ilike ${tagger}
        ) or items.id in (
          select ai.item_id from album_items ai
          join album_items_tags_assign aita on aita.album_item_id = ai.id
          join tags t on t.id = aita.tag_id
          join "user" u on u.id = aita.user_id
          where t.normalized like '%' || slugify(${term}) || '%'
          and u.user ilike ${tagger}
        ))`;
      });
      tagFilter = db`${conditions}`;
    }
  } else if (tag) {
    const terms = tag.split(',').map(t => t.trim()).filter(Boolean);
    if (terms.length > 0) {
      if (isStrict) {
        tagFilter = db`and (items.id in (
          select ta.item_id 
          from tags_assign ta 
          join tags t on t.id = ta.tag_id 
          where t.normalized = ANY(ARRAY(SELECT slugify(x) FROM unnest(${terms}::text[]) AS x))
          group by ta.item_id 
          having count(distinct t.normalized) = ${terms.length}
        ) or items.id in (
          select ai.item_id 
          from album_items ai
          join album_items_tags_assign aita on aita.album_item_id = ai.id 
          join tags t on t.id = aita.tag_id 
          where t.normalized = ANY(ARRAY(SELECT slugify(x) FROM unnest(${terms}::text[]) AS x))
          group by ai.item_id 
          having count(distinct t.normalized) = ${terms.length}
        ))`;
      } else {
        const conditions = terms.map(term => {
          return db`and (items.id in (
            select ta.item_id from tags_assign ta join tags t on t.id = ta.tag_id where t.normalized like '%' || slugify(${term}) || '%'
          ) or items.id in (
            select ai.item_id from album_items ai join album_items_tags_assign aita on aita.album_item_id = ai.id join tags t on t.id = aita.tag_id where t.normalized like '%' || slugify(${term}) || '%'
          ))`;
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

  const isAdmin = !!session?.admin;
  const ownerName = getSessionOwnerName(session);
  const visibilityFilter = isAdmin
    ? db``
    : (ownerName
      ? db`and (coalesce(items.visibility, 0) = 0 or (lower(items.username) = ${ownerName.toLowerCase()} and items.visibility != 3))`
      : db`and coalesce(items.visibility, 0) = 0`);

  return {
    user,
    userLike,
    _decodedTag,
    isTitleSearch,
    titleQuery,
    tag,
    hall,
    hallObj,
    userHallSlug,
    userHallOwner,
    userHallObj,
    mime,
    mimeSQL,
    excludedTags,
    newerThan,
    minXd,
    xdFilter,
    strictParams,
    isStrict,
    tagger,
    modequery,
    tagFilter,
    titleFilter,
    hallFilter,
    userHallFilter,
    visibilityFilter
  };
};

const f0cklib = {
  getItemPage: async ({
    targetItemId,
    targetItemPinned,
    user: rawUser,
    tag: rawTag,
    hall: rawHall,
    mime: rawMime,
    mode,
    ratings,
    fav,
    session,
    limit,
    strict,
    newer,
    exclude,
    user_id,
    is_admin,
    userHall: rawUserHall,
    userHallOwner: rawUserHallOwner,
    minXdScore,
    tagger: rawTagger
  } = {}) => {
    const numId = await resolveNumericItemId(targetItemId);
    if (!numId) return 1;

    let isPinned = targetItemPinned;
    if (isPinned === undefined) {
      const rows = await db`SELECT is_pinned FROM items WHERE id = ${numId} LIMIT 1`;
      if (!rows.length) return 1;
      isPinned = Boolean(rows[0].is_pinned);
    } else {
      isPinned = Boolean(isPinned);
    }

    const eps = limit ?? cfg.websrv.eps;

    const filters = await buildFeedFilters({
      rawUser,
      rawTag,
      rawHall,
      rawMime,
      mode,
      ratings,
      session,
      strict,
      exclude,
      newer,
      minXdScore,
      rawUserHall,
      rawUserHallOwner,
      rawTagger
    });

    const {
      user,
      userLike,
      mimeSQL,
      excludedTags,
      newerThan,
      xdFilter,
      modequery,
      tagFilter,
      titleFilter,
      hallFilter,
      userHallFilter,
      visibilityFilter
    } = filters;

    // Check if the target item actually matches this feed's criteria
    const itemMatch = await db`
      select 1 from items
      ${fav ? db`inner join favorites on favorites.item_id = items.id inner join "user" fav_u on fav_u.id = favorites.user_id` : db``}
      where
        items.id = ${numId}
        and ${db.unsafe(modequery)}
        and items.active = true
        ${visibilityFilter}
        ${tagFilter}
        ${titleFilter}
        ${fav ? db`and (fav_u.user ilike ${userLike} or fav_u.login ilike ${userLike})` : db``}
        ${!fav && user ? db`and items.username ilike ${userLike}` : db``}
        ${mimeSQL}
        ${hallFilter}
        ${userHallFilter}
        ${(!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``}
        ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        ${newerThan ? db`and items.id > ${newerThan}` : db``}
        ${xdFilter}
      limit 1
    `;

    if (!itemMatch.length) {
      return 1;
    }

    const countRows = await db`
      select count(distinct items.id) as total_before
      from items
      ${fav ? db`inner join favorites on favorites.item_id = items.id inner join "user" fav_u on fav_u.id = favorites.user_id` : db``}
      where
        ${db.unsafe(modequery)}
        and items.active = true
        ${visibilityFilter}
        ${tagFilter}
        ${titleFilter}
        ${fav ? db`and (fav_u.user ilike ${userLike} or fav_u.login ilike ${userLike})` : db``}
        ${!fav && user ? db`and items.username ilike ${userLike}` : db``}
        ${mimeSQL}
        ${hallFilter}
        ${userHallFilter}
        ${(!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``}
        ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        ${newerThan ? db`and items.id > ${newerThan}` : db``}
        ${xdFilter}
        and (
          (items.is_pinned is true and ${isPinned} is false)
          or (items.is_pinned = ${isPinned} and items.id > ${numId})
        )
    `;

    const totalBefore = Number(countRows[0]?.total_before || 0);
    return Math.floor(totalBefore / eps) + 1;
  },
  getf0cks: async ({ user: rawUser, tag: rawTag, hall: rawHall, mime: rawMime, page, mode, ratings, fav, session, limit, strict, newer, exclude, user_id, is_admin, random, userHall: rawUserHall, userHallOwner: rawUserHallOwner, minXdScore, tagger: rawTagger, ids, total: explicitTotal } = {}) => {
    if (fav && rawUser) {
      const { isPrivate, isAllowed } = await checkFavoritesAccess(rawUser, { session, user_id, is_admin });
      if (isPrivate && !isAllowed) {
        return {
          success: false,
          is_private: true,
          message: "private favorites"
        };
      }
    }

    const cleanIds = Array.isArray(ids)
      ? ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : (typeof ids === 'string' ? ids.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0) : null);

    if (cleanIds !== null && cleanIds.length === 0) {
      return {
        success: false,
        message: "404 - no uploads found",
        items: [],
        total: 0
      };
    }
    const idsFilter = (cleanIds && cleanIds.length > 0) ? db`and items.id = ANY(${cleanIds}::int[])` : db``;

    const filters = await buildFeedFilters({
      rawUser,
      rawTag,
      rawHall,
      rawMime,
      mode,
      ratings,
      session,
      strict,
      exclude,
      newer,
      minXdScore,
      rawUserHall,
      rawUserHallOwner,
      rawTagger
    });

    const {
      user,
      userLike,
      _decodedTag,
      isTitleSearch,
      titleQuery,
      tag,
      hall,
      hallObj,
      userHallSlug,
      userHallOwner,
      userHallObj,
      mime,
      mimeSQL,
      excludedTags,
      newerThan,
      minXd,
      xdFilter,
      strictParams,
      isStrict,
      tagger,
      modequery,
      tagFilter,
      titleFilter,
      hallFilter,
      userHallFilter,
      visibilityFilter
    } = filters;

    const effMode = Number(mode ?? 0);
    const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
    const ratingsArr = (Array.isArray(ratings) && ratings.length > 0) ? ratings : null;
    let safeRatingsArr = ratingsArr;
    const isGuest = !session || !session.user;
    if (isGuest) {
      safeRatingsArr = ['sfw'];
    } else if (isAnonSession(session)) {
      const allowedModes = getAnonAllowedModes();
      const canFilter = canAnonDo('filter');
      if (!canFilter) {
        safeRatingsArr = null;
      } else if (safeRatingsArr) {
        safeRatingsArr = safeRatingsArr.filter(r => allowedModes.includes(r));
        if (safeRatingsArr.length === 0) {
          safeRatingsArr = (allowedModes.length === 1 && !allowedModes.includes('all'))
            ? [allowedModes[0]]
            : (allowedModes.length < 5 ? [...allowedModes] : null);
        }
      }
    }

    const actPage = +(page ?? 1);
    const eps = limit ?? cfg.websrv.eps;
    const tmp = { user, tag: isTitleSearch ? _decodedTag : tag, hall: hallObj || hall, mime, page: actPage, mode: mode, view_mode: fav ? 'favs' : 'uploads', strict: strict, userHall: userHallObj || userHallSlug, userHallOwner, tagger };

    const cacheKey = buildCountCacheKey({ modequery, tag, user, hall, mime, fav, session, excludedTags, newerThan, minXd, userHallObj, tagger });
    let total = (explicitTotal !== undefined && explicitTotal !== null) ? Number(explicitTotal) : getCachedCount(cacheKey);

    if (total === null) {
      const totalRows = await db`
        select count(distinct items.id) as total
        from items
        ${fav && user ? db`inner join favorites on favorites.item_id = items.id inner join "user" fav_u on fav_u.id = favorites.user_id` : db``}
        where
          ${db.unsafe(modequery)}
          and items.active = true
          ${visibilityFilter}
          ${tagFilter}
          ${titleFilter}
          ${idsFilter}
          ${fav && user ? db`and (fav_u.user ilike ${userLike} or fav_u.login ilike ${userLike})` : db``}
          ${!fav && user ? db`and items.username ilike ${userLike}` : db``}
          ${mimeSQL}
          ${hallFilter}
          ${userHallFilter}
          ${(!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``}
          ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
          ${newerThan ? db`and items.id > ${newerThan}` : db``}
          ${xdFilter}
      `;
      total = Number(totalRows[0].total);
      if (total > 0 && !cleanIds) setCachedCount(cacheKey, total);
    }

    if (!total || total === 0) {
      return {
        success: false,
        message: "404 - no uploads found"
      };
    }

    const pages = +Math.ceil(total / eps);
    const act_page = Math.min(page || 1, pages);
    const offset = Math.max(0, (act_page - 1) * eps);

    // ── Deferred-join pagination ──────────────────────────────────────────────
    // Step 1: Get only item IDs with all filters + OFFSET applied on the bare
    // items table. No expensive JOINs here, so Postgres can use the
    // (is_pinned DESC, id DESC) index efficiently even at page 192.
    // The fav case still needs the favorites join in step 1 for the WHERE clause.
    const pageIdRows = await db`
      select items.id, items.is_pinned
      from items
      ${fav && user ? db`
        inner join favorites on favorites.item_id = items.id
        inner join "user" fav_u on fav_u.id = favorites.user_id
      ` : db``}
      where
        ${db.unsafe(modequery)}
        and items.active = true
        ${visibilityFilter}
        ${tagFilter}
        ${titleFilter}
        ${idsFilter}
        ${fav && user ? db`and (fav_u.user ilike ${userLike} or fav_u.login ilike ${userLike})` : db``}
        ${!fav && user ? db`and items.username ilike ${userLike}` : db``}
        ${mimeSQL}
        ${hallFilter}
        ${userHallFilter}
        ${(!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``}
        ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        ${newerThan ? db`and items.id > ${newerThan}` : db``}
        ${xdFilter}
      ${fav && user ? db`group by items.id, items.is_pinned` : db``}
      order by ${
        random ? db`random()` : (
          (fav && !user && cleanIds && cleanIds.length > 0)
            ? db`array_position(${cleanIds}::int[], items.id)`
            : db`items.is_pinned desc, items.id desc`
        )
      }
      offset ${newerThan ? 0 : offset}
      limit ${eps}
    `;

    if (pageIdRows.length === 0) {
      // Off the end of the dataset (e.g. stale cached total sent user to a page that no longer exists)
      return { success: false, message: "404 - no uploads found" };
    }

    const pageIds = pageIdRows.map(r => r.id);
    // Preserve the page order returned by step 1 after the join scrambles it
    const pageOrder = Object.fromEntries(pageIds.map((id, i) => [id, i]));

    // Step 2: Enrich only those IDs — expensive JOINs on at most `eps` rows.
    const rows = (await db`
      select
        items.id,
        items.title,
        items.slug,
        items.stamp,
        items.visibility,
        items.mime,
        items.dest,
        items.username as username,
        items.is_pinned,
        items.is_oc,
        items.xd_score,
        items.has_coverart,
        items.is_album,
        items.album_count,
        ${user_id ? db`max(coalesce(uvv.view_count, 0)) as my_views,` : db``}
        ${user_id ? db`EXISTS (SELECT 1 FROM notifications WHERE user_id = ${user_id} AND item_id = items.id AND is_read = false) as has_notification,` : db`false as has_notification,`}
        (case when min(ta.tag_id) = 1 then 'SFW' when min(ta.tag_id) = 2 then 'NSFW' when min(ta.tag_id) = ${cfg.nsfl_tag_id || 3} then 'NSFL' else null end) as tag,
        min(ta.tag_id) as tag_id,
        max(uo.display_name) as display_name,
        max(uo.username_color) as username_color,
        ${cfg.websrv.enable_dynamic_thumbs ? db`
        (
          (SELECT count(*) FROM favorites WHERE item_id = items.id) +
          (SELECT count(*) FROM comments WHERE item_id = items.id AND is_deleted = false)
        ) as contribution
        ` : db`0 as contribution`}
      from items
      left join "user" author_u on author_u."user" = items.username or author_u.login = items.username
      left join user_options uo on uo.user_id = author_u.id
      left join tags_assign ta on ta.item_id = items.id and (ta.tag_id = 1 or ta.tag_id = 2 ${cfg.enable_nsfl ? db`or ta.tag_id = ${cfg.nsfl_tag_id || 3}` : db``})
      ${user_id ? db`left join user_video_views uvv on uvv.video_id = items.id and uvv.user_id = ${user_id}` : db``}
      where items.id = any(${pageIds})
      group by items.id
    `).sort((a, b) => pageOrder[a.id] - pageOrder[b.id]);
    // ─────────────────────────────────────────────────────────────────────────

    for (const row of rows) {
      const meta = xdScoreMeta(row.xd_score);
      row.xd_tier = meta.tier;
      row.xd_label = meta.label;
      row.is_audio = !!(row.mime && row.mime.startsWith('audio/'));
      const tId = row.tag_id != null ? Number(row.tag_id) : null;
      row.rating_class = tId === 1 ? 'sfw' : (tId === 2 ? 'nsfw' : (tId === nsflId ? 'nsfl' : 'untagged'));
      row.rating_label = tId === 1 ? 'SFW' : (tId === 2 ? 'NSFW' : (tId === nsflId ? 'NSFL' : '?'));
    }

    if (rows.some(r => r.is_album)) {
      const albumIds = rows.filter(r => r.is_album).map(r => r.id);
      if (albumIds.length > 0) {
        try {
          const subItemsRows = await db`
            SELECT
              ai.item_id,
              ai.id as subf0ck_id,
              ai.slug as subf0ck_slug,
              ai.dest as subf0ck_dest,
              ai.mime as subf0ck_mime,
              ai.order_index
            FROM album_items ai
            WHERE ai.item_id = ANY(${albumIds}::int[])
            ORDER BY ai.item_id, ai.order_index ASC
          `;

          const subIds = subItemsRows.map(s => s.subf0ck_id);
          const subTagsRows = subIds.length > 0 ? await db`
            SELECT aita.album_item_id, t.id, t.tag, t.normalized
            FROM album_items_tags_assign aita
            JOIN tags t ON t.id = aita.tag_id
            WHERE aita.album_item_id = ANY(${subIds}::int[])
          `.catch(() => []) : [];

          const tagsBySubId = new Map();
          for (const st of subTagsRows) {
            if (!tagsBySubId.has(st.album_item_id)) tagsBySubId.set(st.album_item_id, []);
            tagsBySubId.get(st.album_item_id).push(st);
          }

          const subsByItemId = new Map();
          for (const si of subItemsRows) {
            if (!subsByItemId.has(si.item_id)) subsByItemId.set(si.item_id, []);
            subsByItemId.get(si.item_id).push(si);
          }

          for (const row of rows) {
            if (!row.is_album || !subsByItemId.has(row.id)) continue;
            const subList = subsByItemId.get(row.id);
            const isOwnerOrAdmin = (session && session.user && row.username && session.user.toLowerCase() === row.username.toLowerCase()) || (session && (session.admin || session.is_moderator));

            const isSubVisible = (subTags) => {
              if (isOwnerOrAdmin) return true;

              const subIsNsfl = cfg.enable_nsfl && subTags.some(t => t.id == nsflId || t.normalized === 'nsfl');
              const subIsNsfw = subTags.some(t => t.id == 2);
              const subIsSfw = subTags.some(t => t.id == 1);
              const subIsUntagged = !subIsSfw && !subIsNsfw && !subIsNsfl;

              if (excludedTags && excludedTags.length > 0 && subTags.length > 0) {
                if (subTags.some(t => excludedTags.includes(t.normalized) || excludedTags.includes(lib.slugify(t.tag)))) {
                  return false;
                }
              }

              if (!session || !session.user) {
                if (subIsNsfl) return false;
                if (subIsNsfw && !cfg.websrv.public_nsfw) return false;
                if (subIsUntagged && !cfg.websrv.public_untagged) return false;
                if (effMode === 0 && (subIsNsfw || subIsNsfl || (subIsUntagged && !cfg.websrv.public_untagged))) return false;
                if (effMode === 1 && !subIsNsfw) return false;
                if (effMode === 2 && (!subIsUntagged || !cfg.websrv.public_untagged)) return false;
                return true;
              }

              if (isAnonSession(session)) {
                const allowedModes = getAnonAllowedModes();
                if (subIsNsfl && !allowedModes.includes('nsfl')) return false;
                if (subIsNsfw && !allowedModes.includes('nsfw')) return false;
                if (subIsUntagged && !allowedModes.includes('untagged')) return false;
                if (subIsSfw && !allowedModes.includes('sfw')) return false;

                if (safeRatingsArr && safeRatingsArr.length > 0) {
                  const subRatingName = subIsNsfl ? 'nsfl' : (subIsNsfw ? 'nsfw' : (subIsSfw ? 'sfw' : 'untagged'));
                  if (!safeRatingsArr.includes(subRatingName)) return false;
                } else if (effMode !== 3) {
                  if (effMode === 0 && (subIsNsfw || subIsNsfl || (subIsUntagged && !allowedModes.includes('untagged')))) return false;
                  if (effMode === 1 && !subIsNsfw) return false;
                  if (effMode === 2 && (!subIsUntagged || !allowedModes.includes('untagged'))) return false;
                  if (effMode === 4 && !subIsNsfl) return false;
                }
                return true;
              }

              if (safeRatingsArr && safeRatingsArr.length > 0) {
                const subRatingName = subIsNsfl ? 'nsfl' : (subIsNsfw ? 'nsfw' : (subIsSfw ? 'sfw' : 'untagged'));
                if (!safeRatingsArr.includes(subRatingName)) return false;
              } else if (effMode !== 3) {
                if (effMode === 0 && (subIsNsfw || subIsNsfl)) return false;
                if (effMode === 1 && !subIsNsfw) return false;
                if (effMode === 2 && !subIsUntagged) return false;
                if (effMode === 4 && !subIsNsfl) return false;
              }

              return true;
            };

            let visibleSubs = subList.filter((si) => {
              let st = tagsBySubId.get(si.subf0ck_id) || [];
              return isSubVisible(st);
            });

            if (tag && !isTitleSearch) {
              const terms = tag.split(',').map(t => t.trim()).filter(Boolean);
              if (terms.length > 0) {
                const tagMatchingSubs = visibleSubs.filter((si) => {
                  let st = tagsBySubId.get(si.subf0ck_id) || [];
                  if (isStrict) {
                    return strictParams.every(sp => st.some(t => t.normalized === sp));
                  }
                  return terms.some(term => {
                    const slugTerm = lib.slugify(term);
                    return st.some(t => t.normalized && t.normalized.includes(slugTerm));
                  });
                });
                if (tagMatchingSubs.length > 0) {
                  const ms = tagMatchingSubs[0];
                  row.target_subf0ck_slug = ms.subf0ck_slug || ms.subf0ck_id;
                  if (ms.subf0ck_dest) {
                    const subBase = ms.subf0ck_dest.replace(/\.[^.]+$/, '');
                    row.thumb = `/t/${subBase}.webp`;
                    row.matching_sub_thumb = `/t/${subBase}.webp`;
                    row.matching_sub_dest = ms.subf0ck_dest;
                    row.dest = ms.subf0ck_dest;
                  }
                  if (ms.subf0ck_mime) {
                    row.matching_sub_mime = ms.subf0ck_mime;
                    row.mime = ms.subf0ck_mime;
                  }
                  visibleSubs = tagMatchingSubs;
                }
              }
            }

            row.album_count = visibleSubs.length;
            if (visibleSubs.length <= 1) {
              row.is_album = false;
            }
          }
        } catch (err) {
          console.warn('[FEED] Error calculating visible album count for feed:', err.message);
        }
      }
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

    const link = lib.genLink({ user, tag, hall: hallObj ? hallObj.slug : hall, mime, type: fav ? 'favs' : 'uploads', path: 'p/', strict: strict, tagger });

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
  getf0ck: async ({ user: rawUser, tag: rawTag, hall: rawHall, mime: rawMime, itemid: rawItemid, mode, ratings, session, strict, exclude, user_id, is_admin, fav, random, userHall: rawUserHall, userHallOwner: rawUserHallOwner, lang, ids, subf0ck, bypass_filter } = {}) => {
    if (fav && rawUser) {
      const { isPrivate, isAllowed } = await checkFavoritesAccess(rawUser, { session, user_id, is_admin });
      if (isPrivate && !isAllowed) {
        return {
          success: false,
          is_private: true,
          message: "private favorites"
        };
      }
    }

    const cleanIds = Array.isArray(ids)
      ? ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : (typeof ids === 'string' ? ids.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0) : null);
    const idsFilter = (cleanIds && cleanIds.length > 0) ? db`and items.id = ANY(${cleanIds}::int[])` : db``;

    const user = rawUser ? decodeURI(rawUser) : null;
    const userLike = user ? lib.escapeLike(user) : null;

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
    const rawIdOrSlug = rawItemid ?? null;
    if (rawIdOrSlug === null || rawIdOrSlug === undefined || rawIdOrSlug === '') {
      return {
        success: false,
        message: "404 - upload not found"
      };
    }

    const isNumeric = /^\d+$/.test(String(rawIdOrSlug));
    let itemLookup = isNumeric ? db`items.id = ${+rawIdOrSlug}` : db`items.slug = ${String(rawIdOrSlug)}`;
    let requestedSubf0ckSlug = subf0ck || null;

    if (!isNumeric) {
      const itemRow = await db`SELECT id FROM items WHERE slug = ${String(rawIdOrSlug)} LIMIT 1`;
      if (!itemRow.length) {
        const subRow = await db`SELECT item_id, slug FROM album_items WHERE slug = ${String(rawIdOrSlug)} LIMIT 1`;
        if (subRow.length) {
          requestedSubf0ckSlug = subRow[0].slug;
          itemLookup = db`items.id = ${subRow[0].item_id}`;
        }
      }
    }

    const { mimeParts, mimeSQL } = resolveMimeSQL(mime, session);
    const excludedTags = exclude || [];

    const strictParams = ((strict || (tag && tag.includes(','))) && tag) ? tag.split(',').map(t => lib.slugify(t)).filter(t => t) : [];
    const isStrict = strictParams.length > 0;

    const tmp = { user, tag: isTitleSearch ? _decodedTag : tag, hall, mime, itemid: rawIdOrSlug, strict: strict, userHall: userHallObj || userHallSlug, userHallOwner };

    const effMode = Number(mode ?? 0);
    const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
    const ratingsArr = (Array.isArray(ratings) && ratings.length > 0) ? ratings : null;
    let safeRatingsArr = ratingsArr;
    if (!session || !session.user) {
      safeRatingsArr = ['sfw'];
    } else if (isAnonSession(session)) {
      const allowedModes = getAnonAllowedModes();
      if (safeRatingsArr) {
        safeRatingsArr = safeRatingsArr.filter(r => allowedModes.includes(r));
        if (safeRatingsArr.length === 0) {
          safeRatingsArr = (allowedModes.length === 1 && !allowedModes.includes('all'))
            ? [allowedModes[0]]
            : (allowedModes.length < 5 ? [...allowedModes] : null);
        }
      }
    }
    const itemModeQuery = computeBaseMode(mode, ratings, session);

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
      const isAdmin = !!session?.admin;
      const ownerName = getSessionOwnerName(session);
      const visibilityFilter = isAdmin
        ? db``
        : (ownerName
          ? db`and (coalesce(items.visibility, 0) = 0 or (lower(items.username) = ${ownerName.toLowerCase()} and items.visibility != 3))`
          : db`and coalesce(items.visibility, 0) = 0`);

      return db`
            ${db.unsafe(itemModeQuery)}
            and items.active = true
            ${visibilityFilter}
            and (items.expires_at IS NULL OR items.expires_at > ${Math.floor(Date.now() / 1000)})

            ${tagFilter}
            ${titleFilter}
            ${hallFilter}
            ${userHallFilter}
            ${fav && user ? db`and "user"."user" ilike ${userLike}` : db``}
            ${!fav && user ? db`and items.username ilike ${userLike}` : db``}
            ${idsFilter}
            ${mimeSQL}
            ${(!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``}
            ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        `;
    };

    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] [GETF0CK_OPT] Starting fetch for rawIdOrSlug=${rawIdOrSlug}`);

    // 1. Fetch the main item
    const items = await db`
      select
        items.*,
        items.username as username,
        uo.username_color as author_color,
        uo.display_name as author_display_name,
        uo.avatar as author_avatar,
        uo.avatar_file as author_avatar_file,
        uo.banner_file as author_banner_file,
        uo.banner_position as author_banner_position,
        uo.banner_size as author_banner_size,
        uo.description as author_description,
        author_u.id as author_id,
        items.is_pinned,

        ${user_id ? db`coalesce(uvv.view_count, 0) as my_views` : db`0 as my_views`}
      from items
      left join "user" author_u on author_u."user" = items.username
      left join "user_options" uo on uo.user_id = author_u.id
      ${user_id ? db`left join user_video_views uvv on uvv.video_id = items.id and uvv.user_id = ${user_id}` : db``}
      where
        ${itemLookup} and
        items.active = true
      limit 1
    `;

    const actitem = items[0];
    
    if (!actitem) {
      return {
        success: false,
        message: "404 - upload not found"
      };
    }

    const itemid = actitem.id;

    // Check visibility permissions:
    const ownerName = getSessionOwnerName(session);
    const isOwnerOrAdmin = session && (
      (ownerName && ownerName.toLowerCase() === (actitem.username || '').toLowerCase()) ||
      session.admin || session.is_moderator
    );

    // If item is Private (visibility === 2):
    // Direct link only allowed for owner/admin
    if (actitem.visibility === 2 && !isOwnerOrAdmin) {
      return {
        success: false,
        is_private: true,
        message: "403 - private upload"
      };
    }

    // If item is Unavailable (visibility === 3):
    // Only viewable by admins, not regular users or mods (renders normal post not found)
    if (actitem.visibility === 3 && !session?.admin) {
      return {
        success: false,
        message: "404 - upload not found"
      };
    }

    // If request was by sequential numeric ID (/123) and item visibility > 0 (unlisted/private):
    // Block numeric enumeration unless viewer is owner/admin
    if (isNumeric && (actitem.visibility === 1 || actitem.visibility === 2) && !isOwnerOrAdmin) {
      return {
        success: false,
        message: "404 - upload not found"
      };
    }

    if (user_id) {
       db`
        insert into user_video_views (user_id, video_id, view_count, last_viewed)
        values (${user_id}, ${itemid}, 1, now())
        on conflict (user_id, video_id) do update set
         view_count = user_video_views.view_count + 1,
         last_viewed = now()
       `.catch(e => console.error('Failed to track view:', e));
    }
    // Public visitor / guest rating restriction check for public items (unlisted items requested by direct link/slug bypass guest rating blocks)
    const isPublicVisitor = !session || !session.user || isAnonSession(session);
    if (isPublicVisitor && !isOwnerOrAdmin && (actitem.visibility || 0) === 0) {
        let blocked = false;
        if (getGlobalfilter(session)) {
          const filteredItem = await db`
            select 1 from tags_assign where item_id = ${itemid} and (${db.unsafe(getGlobalfilter(session))}) limit 1
          `;
          if (filteredItem.length > 0) blocked = true;
        }
        if (!blocked && !session && !cfg.websrv.public_untagged) {
          const ratingTag = await db`
            select 1 from tags_assign where item_id = ${itemid} and tag_id in (1, 2, ${nsflId}) limit 1
          `;
          if (ratingTag.length === 0) blocked = true;
        }
        if (blocked) {
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

    // 2. Fetch Next/Prev/Start/End/Cheat in parallel
    // Optimized: Use tags_assign driver for SFW (0) and NSFW (1) modes

    // Determine the effective mode for optimization check (similar to Random)
    const nsfl_id = cfg.nsfl_tag_id || 3;
    const useTagsDriver = !!session && !isAnonSession(session) && (effMode === 1 || effMode === 4) && !fav && !tag && !user && !hall && (!cleanIds || cleanIds.length === 0);

    const baseQuery = (whereClause, orderBy, limit = 1) => {
      return db`
            select items.id, items.slug
            from items
            left join tags_assign on tags_assign.item_id = items.id
            left join tags on tags.id = tags_assign.tag_id
            ${fav && user
          ? db`inner join favorites on favorites.item_id = items.id inner join "user" on "user".id = favorites.user_id`
          : db`left join favorites on favorites.item_id = items.id left join "user" on "user".id = favorites.user_id`
        }
            where
                ${buildConditions()}
                ${whereClause}
            group by items.id, items.slug
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
        const checkFilter = (!session || isAnonSession(session)) && nsfpIds.length > 0;

        const query = db`
                SELECT ta.item_id as id, items.slug
                FROM tags_assign ta
                INNER JOIN items ON items.id = ta.item_id
                ${checkFilter
            ? db`LEFT JOIN tags_assign filter_ta ON filter_ta.item_id = ta.item_id AND filter_ta.tag_id IN ${db(nsfpIds)}`
            : db``
          }
                WHERE ${useTagIdOpt ? db`ta.tag_id = ${tagId}` : db`${db.unsafe(modequery)}`}
                AND items.active = true
                AND coalesce(items.visibility, 0) = 0
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

    // 2. Neighbor queries — skip useless ones in random mode
    const [nextItem, prevItem, startItem, endItem, cheatItems] = await Promise.all([
      random
        ? optimizedBaseQuery(db`and items.id != ${itemid}`, db`order by random()`)
        : optimizedBaseQuery(db`and items.id > ${itemid}`, db`order by items.id asc`),
      random
        ? Promise.resolve(null) // reuse nextItem for prev in random mode
        : optimizedBaseQuery(db`and items.id < ${itemid}`, db`order by items.id desc`),
      random ? Promise.resolve([]) : optimizedBaseQuery(db``, db`order by items.id asc`),
      random ? Promise.resolve([]) : optimizedBaseQuery(db``, db`order by items.id desc`),
      random ? Promise.resolve([]) : optimizedBaseQuery(db`and items.id != ${itemid}`, db`order by abs(items.id - ${itemid}) asc`, 7)
    ]);
    console.log(`[GETF0CK_OPT] Neighbor queries finished in ${Date.now() - runTimings}ms (random=${!!random})`);

    // For random: prev reuses nextItem result (both are random, no point running 2 ORDER BY random())
    const effectivePrev = random ? nextItem : prevItem;

    // Cheat array should include current item and neighbors, sorted
    const cheat = [itemid, ...cheatItems.map(i => i.id)].sort((a, b) => a - b);

    // 3. Metadata queries — sequential to avoid pool saturation
    const repostBaseChecksum = actitem.checksum
      ? (actitem.checksum.includes('_bypass_') ? actitem.checksum.split('_bypass_')[0] : actitem.checksum)
      : null;
    const hasBypass = actitem.checksum && actitem.checksum.includes('_bypass_');

    const [tags, itemHalls, userHallsForItem, favorites, repostRows, phashMatches] = await Promise.all([
      lib.getTags(itemid, session),
      db`select h.name, h.slug from halls h join halls_assign ha on ha.hall_id = h.id where ha.item_id = ${itemid}`,
      user_id
        ? db`select uh.name, uh.slug from user_halls uh join user_halls_assign uha on uha.hall_id = uh.id where uha.item_id = ${itemid} and uh.user_id = ${user_id}`
        : [],
      db`
        select "favorites".user_id, "user".user, "user".login, "user_options".avatar, "user_options".avatar_file, "user_options".username_color, "user_options".display_name, "user_options".hide_fav_badge, "anon_identities".fingerprint as anon_fingerprint
        from "favorites"
        left join "user" on "user".id = "favorites".user_id
        left join "user_options" on "user_options".user_id = "favorites".user_id
        left join "anon_identities" on "anon_identities".user_id = "favorites".user_id
        where "favorites".item_id = ${itemid}
      `,
      repostBaseChecksum
        ? db`
            SELECT id, slug, username, stamp FROM items
            WHERE active = true
              AND id != ${itemid}
              AND ${hasBypass
                ? db`(checksum = ${repostBaseChecksum} OR checksum LIKE ${repostBaseChecksum + '_bypass_%'})`
                : db`checksum LIKE ${repostBaseChecksum + '_bypass_%'}`
              }
            ORDER BY id ASC
          `
        : [],
      (actitem.phash && actitem.phash !== 'ERROR' && actitem.phash !== 'MISSING')
        ? queue.findallrepostphash(actitem.phash, itemid).catch(() => [])
        : []
    ]);
    console.log(`[GETF0CK_OPT] All queries finished in ${Date.now() - runTimings}ms`);

    const link = lib.genLink({ user, tag, hall: (hall && typeof hall === 'object') ? hall.slug : hall, mime, type: fav ? 'favs' : 'uploads', path: '', strict: strict });
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

    for (const f of favorites) {
      if (f.anon_fingerprint || f.user === 'anonymous' || (typeof f.user === 'string' && f.user.startsWith('anon_'))) {
        f.is_anon = true;
        f.user = 'anonymous';
        f.login = 'anonymous';
        f.display_name = 'Anonymous';
        f.avatar = null;
        f.avatar_file = null;
        f.username_color = null;
        f.hide_fav_badge = true;
      }
    }

    // Merge checksum + phash repost results
    let repostItems = repostRows.map(r => ({ id: r.id, slug: r.slug, username: r.username, stamp: r.stamp, match_type: 'checksum' }));
    if (phashMatches.length > 0) {
      const existingIds = new Set(repostItems.map(r => r.id));
      for (const pm of phashMatches) {
        if (!existingIds.has(pm.id)) {
          repostItems.push({ id: pm.id, slug: pm.slug, username: pm.username, stamp: pm.stamp, match_type: 'phash' });
          existingIds.add(pm.id);
        }
      }
      repostItems.sort((a, b) => a.id - b.id);
    }

    let hasCoverart = false;
    if (actitem.mime && actitem.mime.startsWith('audio/')) {
      try {
        const caPath = path.join(cfg.paths.ca, `${actitem.id}.webp`);
        if (fs.existsSync(caPath) && fs.statSync(caPath).size > 0) {
          hasCoverart = true;
        } else {
          // On-demand cover art extraction fallback
          const audioFile = path.join(cfg.paths.b, actitem.dest);
          if (fs.existsSync(audioFile)) {
            await queue.spawn('ffmpeg', ['-y', '-i', audioFile, '-an', '-vcodec', 'webp', '-frames:v', '1', caPath], { quiet: true });
            if (fs.existsSync(caPath) && fs.statSync(caPath).size > 0) {
              hasCoverart = true;
              const tPath = path.join(cfg.paths.t, `${actitem.id}.webp`);
              await queue.spawn('magick', [caPath + '[0]', '-resize', '256x256^', '-gravity', 'center', '-crop', '256x256+0+0', '+repage', tPath], { quiet: true });
            } else {
              try { fs.unlinkSync(caPath); } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }
    const coverartUrl = hasCoverart 
        ? `${cfg.websrv.paths.coverarts}/${actitem.id}.webp`
        : null;

    let album = [];
    let effectiveItemTags = tags;
    if (actitem.is_album) {
      try {
        let albumRows = await db`
          SELECT id, dest, mime, size, width, height, order_index, slug, checksum
          FROM album_items
          WHERE item_id = ${itemid}
          ORDER BY order_index ASC
        `;
        if (albumRows.length > 0) {
          const itemIds = albumRows.map(r => r.id);
          const subTagsRows = await db`
            SELECT aita.album_item_id, t.id, t.tag, t.normalized
            FROM album_items_tags_assign aita
            JOIN tags t ON t.id = aita.tag_id
            WHERE aita.album_item_id IN ${db(itemIds)}
            ORDER BY (case when t.id = 1 then 0 when t.id = 2 then 1 when t.normalized = 'nsfl' then 2 else 3 end) asc, t.id asc
          `.catch(() => []);
          const tagsBySubId = new Map();
          for (const st of subTagsRows) {
            if (!tagsBySubId.has(st.album_item_id)) tagsBySubId.set(st.album_item_id, []);
            st.badge = lib.getBadge(st);
            tagsBySubId.get(st.album_item_id).push(st);
          }

          if (tag && !isTitleSearch) {
            const terms = tag.split(',').map(t => t.trim()).filter(Boolean);
            if (terms.length > 0 && tagsBySubId.size > 0) {
              const matching = albumRows.filter((r) => {
                let st = tagsBySubId.get(r.id) || [];
                if (isStrict) {
                  return strictParams.every(sp => st.some(t => t.normalized === sp));
                }
                return terms.some(term => {
                  const slugTerm = lib.slugify(term);
                  return st.some(t => t.normalized && t.normalized.includes(slugTerm));
                });
              });
              if (matching.length > 0) {
                albumRows = matching;
              }
            }
          }

          const parentRatingTags = tags.filter(t => t.id == 1 || t.id == 2 || (cfg.enable_nsfl && (t.id == nsfl_id || t.normalized === 'nsfl')));

          const isSubVisible = (subTags) => {
            if (bypass_filter) return true;

            const hasSubRating = subTags.some(t => t.id == 1 || t.id == 2 || (cfg.enable_nsfl && (t.id == nsfl_id || t.normalized === 'nsfl')));
            const effectiveSubTags = hasSubRating ? subTags : [...parentRatingTags, ...subTags];

            const subIsNsfl = cfg.enable_nsfl && effectiveSubTags.some(t => t.id == nsfl_id || t.normalized === 'nsfl');
            const subIsNsfw = effectiveSubTags.some(t => t.id == 2);
            const subIsSfw = effectiveSubTags.some(t => t.id == 1);
            const subIsUntagged = !subIsSfw && !subIsNsfw && !subIsNsfl;

            // Excluded tags check
            if (excludedTags && excludedTags.length > 0 && effectiveSubTags.length > 0) {
              if (effectiveSubTags.some(t => excludedTags.includes(t.normalized) || excludedTags.includes(lib.slugify(t.tag)))) {
                return false;
              }
            }

            // Guest check
            if (!session || !session.user) {
              if (subIsNsfl) return false;
              if (subIsNsfw && !cfg.websrv.public_nsfw) return false;
              if (subIsUntagged && !cfg.websrv.public_untagged) return false;
              if (effMode === 0 && (subIsNsfw || subIsNsfl || (subIsUntagged && !cfg.websrv.public_untagged))) return false;
              if (effMode === 1 && !subIsNsfw) return false;
              if (effMode === 2 && (!subIsUntagged || !cfg.websrv.public_untagged)) return false;
              return true;
            }

            // Anon session check
            if (isAnonSession(session)) {
              const allowedModes = getAnonAllowedModes();
              if (subIsNsfl && !allowedModes.includes('nsfl')) return false;
              if (subIsNsfw && !allowedModes.includes('nsfw')) return false;
              if (subIsUntagged && !allowedModes.includes('untagged')) return false;
              if (subIsSfw && !allowedModes.includes('sfw')) return false;

              if (safeRatingsArr && safeRatingsArr.length > 0) {
                const subRatingName = subIsNsfl ? 'nsfl' : (subIsNsfw ? 'nsfw' : (subIsSfw ? 'sfw' : 'untagged'));
                if (!safeRatingsArr.includes(subRatingName)) return false;
              } else if (effMode !== 3) {
                if (effMode === 0 && (subIsNsfw || subIsNsfl || (subIsUntagged && !allowedModes.includes('untagged')))) return false;
                if (effMode === 1 && !subIsNsfw) return false;
                if (effMode === 2 && (!subIsUntagged || !allowedModes.includes('untagged'))) return false;
                if (effMode === 4 && !subIsNsfl) return false;
              }
              return true;
            }

            // Logged-in member check
            if (safeRatingsArr && safeRatingsArr.length > 0) {
              const subRatingName = subIsNsfl ? 'nsfl' : (subIsNsfw ? 'nsfw' : (subIsSfw ? 'sfw' : 'untagged'));
              if (!safeRatingsArr.includes(subRatingName)) return false;
            } else if (effMode !== 3) {
              if (effMode === 0 && (subIsNsfw || subIsNsfl)) return false;
              if (effMode === 1 && !subIsNsfw) return false;
              if (effMode === 2 && !subIsUntagged) return false;
              if (effMode === 4 && !subIsNsfl) return false;
            }

            return true;
          };

          albumRows = albumRows.filter((r) => {
            let subTags = tagsBySubId.get(r.id) || [];
            return isSubVisible(subTags);
          });

          if (albumRows.length === 0) {
            const hallSlug = hall && typeof hall === 'object' ? hall.slug : hall;
            return {
              success: false,
              message: "Sorry, this post is currently not visible.",
              item: {
                id: itemid,
                slug: actitem.slug || null,
                og_thumbnail: `${cfg.websrv.paths.thumbnails}/${itemid}_blur.webp`,
                og_url: hallSlug
                  ? `https://${cfg.main.url.domain}/h/${encodeURIComponent(hallSlug)}/${itemid}`
                  : `https://${cfg.main.url.domain}/${itemid}`,
                og_description: `Content not visible in current mode`
              }
            };
          }

          album = await Promise.all(albumRows.map(async (r, idx) => {
            const order = idx;
            const subSlug = r.slug || r.id;
            const isYouTube = r.mime === 'video/youtube';
            const subBase = r.dest.replace(/\.[^.]+$/, '');
            const isAudio = (r.mime || '').startsWith('audio/');
            let subCover = null;
            // YouTube sub-items: thumbnail is stored by album_item row id (not by filename)
            let subThumb = isYouTube
              ? `${cfg.websrv.paths.thumbnails}/${r.id}.webp`
              : `${cfg.websrv.paths.thumbnails}/${subBase}.webp`;
            // Also try YouTube CDN thumbnail as fallback
            const ytVideoId = isYouTube ? r.dest.replace('yt:', '') : null;

            if (isAudio) {
              const caFile = path.join(cfg.paths.ca, `${subBase}.webp`);
              const tFile = path.join(cfg.paths.t, `${subBase}.webp`);
              let caExists = false;
              try {
                caExists = fs.existsSync(caFile) && fs.statSync(caFile).size > 0;
              } catch (_) {}

              if (!caExists && order === 0 && hasCoverart) {
                const parentCaFile = path.join(cfg.paths.ca, `${actitem.id}.webp`);
                try {
                  if (fs.existsSync(parentCaFile) && fs.statSync(parentCaFile).size > 0) {
                    subCover = `${cfg.websrv.paths.coverarts}/${actitem.id}.webp`;
                    subThumb = `${cfg.websrv.paths.thumbnails}/${actitem.id}.webp`;
                    caExists = true;
                  }
                } catch (_) {}
              }

              if (!caExists) {
                const audioSource = path.join(cfg.paths.b, r.dest);
                if (fs.existsSync(audioSource)) {
                  try {
                    await queue.spawn('ffmpeg', ['-y', '-i', audioSource, '-an', '-vcodec', 'webp', '-frames:v', '1', caFile], { quiet: true });
                    if (fs.existsSync(caFile) && fs.statSync(caFile).size > 0) {
                      caExists = true;
                      await queue.spawn('magick', [caFile + '[0]', '-resize', '256x256^', '-gravity', 'center', '-crop', '256x256+0+0', '+repage', tFile], { quiet: true });
                    } else {
                      try { fs.unlinkSync(caFile); } catch (_) {}
                    }
                  } catch (_) {}
                }
              }

              if (caExists) {
                if (!subCover) subCover = `${cfg.websrv.paths.coverarts}/${subBase}.webp`;
                try {
                  if (!fs.existsSync(tFile) || fs.statSync(tFile).size === 0) {
                    subThumb = subCover;
                  }
                } catch (_) {
                  subThumb = subCover;
                }
              } else {
                subCover = null;
                subThumb = null;
              }
            }

            let subSizeNum = r.size;
            if (!subSizeNum || isNaN(subSizeNum) || Number(subSizeNum) <= 0) {
              try {
                const bFile = path.join(cfg.paths.b, r.dest);
                if (fs.existsSync(bFile)) {
                  subSizeNum = fs.statSync(bFile).size;
                }
              } catch (_) {}
            }

            let subTags = tagsBySubId.get(r.id) || [];
            const hasSubRating = subTags.some(t => t.id == 1 || t.id == 2 || (cfg.enable_nsfl && (t.id == nsfl_id || t.normalized === 'nsfl')));
            const combinedSubTags = hasSubRating ? subTags : [...parentRatingTags, ...subTags];

            return {
              id: r.id,
              slug: r.slug,
              subf0ck_id: subSlug,
              dest: isYouTube ? r.dest : `${cfg.websrv.paths.images}/${r.dest}`,
              src: isYouTube ? `https://www.youtube.com/embed/${ytVideoId}?enablejsapi=1` : `${cfg.websrv.paths.images}/${r.dest}`,
              filename: r.dest,
              mime: r.mime,
              size: lib.formatSize(subSizeNum),
              width: r.width,
              height: r.height,
              checksum: r.checksum,
              order_index: order,
              display_index: order + 1,
              is_first: order === 0,
              is_video: (r.mime || '').startsWith('video/'),
              is_youtube: isYouTube,
              is_audio: isAudio,
              is_image: (r.mime || '').startsWith('image/'),
              has_coverart: isAudio ? !!subCover : false,
              coverart: isAudio ? subCover : null,
              // Use YouTube CDN thumb as fallback for strip thumbnails
              thumb: isYouTube
                ? `https://img.youtube.com/vi/${ytVideoId}/mqdefault.jpg`
                : subThumb,
              tags: combinedSubTags
            };
          }));

          let reqIdx = 0;
          if (requestedSubf0ckSlug && album.length > 0) {
            const found = album.findIndex(s => String(s.slug || '') === String(requestedSubf0ckSlug) || String(s.subf0ck_id || '') === String(requestedSubf0ckSlug) || String(s.id) === String(requestedSubf0ckSlug));
            if (found !== -1) {
              reqIdx = found;
            } else {
              const hallSlug = hall && typeof hall === 'object' ? hall.slug : hall;
              return {
                success: false,
                message: "Sorry, this post is currently not visible.",
                item: {
                  id: itemid,
                  slug: actitem.slug || null,
                  og_thumbnail: `${cfg.websrv.paths.thumbnails}/${itemid}_blur.webp`,
                  og_url: hallSlug
                    ? `https://${cfg.main.url.domain}/h/${encodeURIComponent(hallSlug)}/${itemid}`
                    : `https://${cfg.main.url.domain}/${itemid}`,
                  og_description: `Content not visible in current mode`
                }
              };
            }
          }

          if (album.length > 0 && album[reqIdx]) {
            album.forEach((s, i) => { s.is_first = (i === reqIdx); });
            const targetSub = album[reqIdx];
            if (requestedSubf0ckSlug || tag) {
              requestedSubf0ckSlug = targetSub.slug || targetSub.id;
            } else {
              requestedSubf0ckSlug = null;
            }
            actitem.dest = targetSub.filename || targetSub.dest.replace(/^\/b\//, '');
            actitem.mime = targetSub.mime;
            actitem.width = targetSub.width;
            actitem.height = targetSub.height;
            if (targetSub.size) {
              actitem.size = targetSub.size;
            }
            if (targetSub.coverart) {
              actitem.coverart = targetSub.coverart;
            }
            if (targetSub.tags && targetSub.tags.length > 0) {
              const hasSubRating = targetSub.tags.some(t => t.id == 1 || t.id == 2 || (cfg.enable_nsfl && (t.id == nsfl_id || t.normalized === 'nsfl')));
              effectiveItemTags = hasSubRating ? targetSub.tags : [...parentRatingTags, ...targetSub.tags];
            } else if (reqIdx === 0) {
              effectiveItemTags = tags;
            } else {
              effectiveItemTags = [...parentRatingTags];
            }
          }
        }
      } catch (err) {
        console.error('[GETF0CK] Failed to fetch album items:', err.message);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] [GETF0CK_OPT] Fetch complete in ${duration}ms`);

    const isNsfl = cfg.enable_nsfl && effectiveItemTags.some(t => t.id == nsfl_id || t.normalized === 'nsfl');
    const isNsfw = effectiveItemTags.some(t => t.id == 2);
    const isSfw = effectiveItemTags.some(t => t.id == 1);
    const isTagged = effectiveItemTags.length > 0;
    const isUntagged = !isSfw && !isNsfw && !isNsfl;
    // Guest rating restriction check for public uploads (visibility === 0)
    if (!session && !isOwnerOrAdmin && (actitem.visibility || 0) === 0) {
      let guestBlocked = false;
      if (isNsfw && !cfg.websrv.public_nsfw) guestBlocked = true;
      else if (isNsfl) guestBlocked = true;
      else if (isUntagged && !cfg.websrv.public_untagged) guestBlocked = true;

      if (guestBlocked) {
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
    } else if (isAnonSession(session) && !isOwnerOrAdmin && (actitem.visibility || 0) === 0) {
      const allowedModes = getAnonAllowedModes();
      let anonBlocked = false;
      if (isNsfw && !allowedModes.includes('nsfw')) anonBlocked = true;
      else if (isNsfl && !allowedModes.includes('nsfl')) anonBlocked = true;
      else if (isUntagged && !allowedModes.includes('untagged') && Number(mode ?? 0) !== 2) anonBlocked = true;
      else if (isSfw && !allowedModes.includes('sfw')) anonBlocked = true;

      if (anonBlocked) {
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

    // Mode-mismatch visibility check:
    // Mode 0=sfw, 1=nsfw, 2=untagged, 3=all
    const userMode = Number(mode ?? 0);
    if (userMode === 2) console.log(`[MODE2-DEBUG] item=${itemid} isTagged=${isTagged} isUntagged=${isUntagged} isSfw=${isSfw} isNsfw=${isNsfw} isNsfl=${isNsfl} tags=${effectiveItemTags.map(t => t.id + ':' + t.normalized).join(',')}`);
    if (!bypass_filter) {
      let modeBlocked = false;
      const untaggedDisallowed = (!session && !cfg.websrv.public_untagged) || (isAnonSession(session) && !getAnonAllowedModes().includes('untagged'));
      if (safeRatingsArr && safeRatingsArr.length > 0) {
        const itemRatingName = isNsfl ? 'nsfl' : (isNsfw ? 'nsfw' : (isSfw ? 'sfw' : 'untagged'));
        if (!safeRatingsArr.includes(itemRatingName)) modeBlocked = true;
      } else if (userMode !== 3) {
        if (userMode === 0 && (isNsfw || isNsfl || (isUntagged && untaggedDisallowed))) modeBlocked = true;       // SFW mode, item is NSFW or NSFL
        else if (userMode === 1 && !isNsfw) modeBlocked = true; // NSFW mode, item is not NSFW
        else if (userMode === 4 && (!cfg.enable_nsfl || !isNsfl)) modeBlocked = true; // NSFL mode, item is not NSFL
        else if (userMode === 2 && !isUntagged) modeBlocked = true; // Unrated mode, item has a rating (sfw/nsfw/nsfl)
      }

      if (modeBlocked) {
        const hallSlug = hall && typeof hall === 'object' ? hall.slug : hall;
        return {
          success: false,
          message: "Sorry, this post is currently not visible.",
          item: {
            id: itemid,
            slug: actitem.slug || null,
            og_thumbnail: `${cfg.websrv.paths.thumbnails}/${itemid}${isNsfw ? '_blur' : ''}.webp`,
            og_url: hallSlug
              ? `https://${cfg.main.url.domain}/h/${encodeURIComponent(hallSlug)}/${itemid}`
              : `https://${cfg.main.url.domain}/${itemid}`,
            og_description: `Content not visible in current mode`
          }
        };
      }
    }

    if (getEnableItemSlugs() && !actitem.slug) {
      actitem.slug = lib.generateSlug(11);
      db`UPDATE items SET slug = ${actitem.slug} WHERE id = ${actitem.id} AND (slug IS NULL OR slug = '')`.catch(e => console.error('[AUTO_SLUG] Failed DB update:', e.message));
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
        slug: (getEnableItemSlugs() && actitem.slug) ? actitem.slug : null,
        visibility: actitem.visibility !== undefined ? actitem.visibility : 0,
        username: actitem.username,
        author_id: actitem.author_id,
        author_color: actitem.author_color,
        author_display_name: actitem.author_display_name || null,
        author_avatar: actitem.author_avatar,
        author_avatar_file: actitem.author_avatar_file,
        author_banner_file: actitem.author_banner_file,
        author_banner_position: actitem.author_banner_position,
        author_banner_size: actitem.author_banner_size,
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
          const ratingLabel = isNsfl ? 'NSFL' : (isNsfw ? 'NSFW' : (isSfw ? 'SFW' : 'Unrated'));
          const titlePart = actitem.title ? ` · "${actitem.title}"` : '';
          return `${ratingLabel}${titlePart} · uploaded by ${actitem.username}`;
        })(),
        coverart: coverartUrl,
        has_coverart: !!hasCoverart,
        is_audio: (actitem.mime || '').startsWith('audio/'),
        dest: (() => {
          if (actitem.mime !== 'video/youtube') return `${cfg.websrv.paths.images}/${actitem.dest}`;
          if (actitem.dest && actitem.dest.startsWith('yt:')) return actitem.dest;
          // dest was corrupted by UUID backfill — recover from src
          const ytSrcRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\/?\?(?:\S*?&?v=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;
          const m = actitem.src && actitem.src.match(ytSrcRegex);
          return m ? `yt:${m[1]}` : actitem.dest;
        })(),
        mime: actitem.mime,
        size: lib.formatSize(actitem.size),
        checksum: actitem.checksum,
        timestamp: {
          timeago: lib.timeAgo(new Date(actitem.stamp * 1e3).toISOString(), lang),
          timefull: new Date(actitem.stamp * 1e3).toISOString()
        },
        favorites: favorites,
        tags: effectiveItemTags,
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
        show_repost_row: !!((session || cfg.websrv.expose_repost_links_to_guests || cfg.websrv.expose_repost_links) && (actitem.checksum?.includes('_bypass_') || (repostItems && repostItems.length > 0))),
        width: actitem.width || null,
        height: actitem.height || null,
        original_filename: actitem.original_filename || null,
        expires_at: actitem.expires_at || null,
        expires_in: lib.expiresIn(actitem.expires_at),
        is_album: !!(actitem.is_album && album.length > 1),
        album_count: album.length || actitem.album_count || 0,
        album: album,
        album_json: JSON.stringify(album),
        requested_subf0ck_slug: requestedSubf0ckSlug || null
      },
      title: `${(getEnableItemSlugs() && actitem.slug) ? actitem.slug : actitem.id} - ${cfg.websrv.domain}`,
      pagination: {
        end: (getEnableItemSlugs() && endItem[0]?.slug) ? endItem[0].slug : (endItem[0]?.id || itemid),
        start: (getEnableItemSlugs() && startItem[0]?.slug) ? startItem[0].slug : (startItem[0]?.id || itemid),
        next: (getEnableItemSlugs() && nextItem[0]?.slug) ? nextItem[0].slug : (nextItem[0]?.id || null),
        prev: (getEnableItemSlugs() && effectivePrev[0]?.slug) ? effectivePrev[0].slug : (effectivePrev[0]?.id || null),
        page: (getEnableItemSlugs() && actitem.slug) ? actitem.slug : actitem.id,
        cheat: cheat
      },
      phrase: cfg.websrv.phrases[~~(Math.random() * cfg.websrv.phrases.length)],
      link,
      tmp
    };
    return data;
  },
  getRandom: async ({ user: rawUser, tag: rawTag, hall: rawHall, mime: rawMime, mode, ratings, fav, session, strict, exclude, user_id, is_admin, userHall: rawUserHall, userHallOwner: rawUserHallOwner } = {}) => {
    if (fav && rawUser) {
      const { isPrivate, isAllowed } = await checkFavoritesAccess(rawUser, { session, user_id, is_admin });
      if (isPrivate && !isAllowed) {
        return null;
      }
    }
    const user = rawUser ? decodeURI(rawUser) : null;
    const userLike = user ? lib.escapeLike(user) : null;
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
    const { mimeParts, mimeSQL } = resolveMimeSQL(mime, session);
    const excludedTags = session && exclude ? (exclude || []) : [];
    
    const strictParams = ((strict || (tag && tag.includes(','))) && tag) ? tag.split(',').map(t => lib.slugify(t)).filter(t => t) : [];
    const isStrict = strictParams.length > 0;
    
    const ratingsArr = (Array.isArray(ratings) && ratings.length > 0) ? ratings : null;
    const multiRatingSQL = ratingsArr ? lib.getMultiRatingMode(ratingsArr) : null;
    const modequery = computeBaseMode(mode, ratings, session);

    let item;

    if (isTitleSearch && titleQuery) {
      // Title search random: filter by items.title, no tag join needed
      item = await db`
        SELECT items.id
        FROM items
        WHERE
          ${db.unsafe(modequery)}
          AND items.active = true
          AND coalesce(items.visibility, 0) = 0
          AND items.title ILIKE ${'%' + titleQuery + '%'}
          AND items.title IS NOT NULL
          ${mimeSQL}
          ${(!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``}
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
          and "user".user ilike ${userLike}
          and items.active = true
          and coalesce(items.visibility, 0) = 0
          ${mimeSQL}
          ${(!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``}
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
        where
          ${db.unsafe(modequery)}
          and items.active = true
          and coalesce(items.visibility, 0) = 0
          ${tagFilter}
          ${user ? db`and items.username ilike ${userLike}` : db``}
          ${hall ? db`and items.id in (select item_id from halls_assign ha join halls h on h.id = ha.hall_id where h.slug = ${hall})` : db``}
          ${mimeSQL}
          ${(!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``}
          ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
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
          and coalesce(items.visibility, 0) = 0
          ${mimeSQL}
          ${(!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``}
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
          and coalesce(items.visibility, 0) = 0
          ${mimeSQL}
          ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``}
        order by random()
        limit 1
      `;
    } else {
      // Uniform random logic for global requests (no user/tag/hall)
      // When multi-rating SQL is active, use it directly. Otherwise use the tag-join optimisation.
      const globalModeQuery = modequery;
      // tagId optimisation only applies for single native modes for logged-in users (not multi-rating or guest mode)
      const tagId = session && !isAnonSession(session) && !multiRatingSQL && (mode === 0 || mode === 1 || mode === 4)
        ? (mode === 4 ? (cfg.nsfl_tag_id || 3) : (mode === 1 ? 2 : 1))
        : null;
      // If audio is included, we avoid the strict tagId optimization to ensure audio is visible
      const useTagIdOpt = tagId && !mimeParts.includes('audio');
      const nsfpIds = cfg.nsfp || [];
      // Only apply nsfp filter for SFW/All modes — when user explicitly selected NSFW/NSFL, don't exclude those items
      const checkFilter = (!session || isAnonSession(session)) && nsfpIds.length > 0 && (mode === 0 || mode === 3 || mode === undefined || mode === null);

      // Use a single uniform query with ORDER BY random()
      // For 30k-100k items, this is performant enough and much more reliable than seeking.
      item = await db`
        SELECT items.id
        FROM items
        ${useTagIdOpt ? db`INNER JOIN tags_assign ta ON ta.item_id = items.id AND ta.tag_id = ${tagId}` : db``}
        ${checkFilter ? db`LEFT JOIN tags_assign filter_ta ON filter_ta.item_id = items.id AND filter_ta.tag_id IN ${db(nsfpIds)}` : db``}
        WHERE items.active = true
          AND coalesce(items.visibility, 0) = 0
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
  /**
   * getRandomPool — returns all candidate IDs/slugs for client-side random selection.
   * Mirrors getRandom() filter logic exactly (mode, ratings, strict, exclusions, visibility, mime, etc.)
   * Caps at 500 items; uses ORDER BY random() sampling for larger sets.
   */
  getRandomPool: async ({ user: rawUser, tag: rawTag, hall: rawHall, mime: rawMime, mode, ratings, fav, session, strict, exclude, user_id, is_admin, userHall: rawUserHall, userHallOwner: rawUserHallOwner } = {}) => {
    if (fav && rawUser) {
      const { isPrivate, isAllowed } = await checkFavoritesAccess(rawUser, { session, user_id, is_admin });
      if (isPrivate && !isAllowed) {
        return { items: [], total: 0 };
      }
    }
    const user = rawUser ? decodeURI(rawUser) : null;
    const userLike = user ? lib.escapeLike(user) : null;
    const hall = rawHall || null;

    const _decodedTag = rawTag ? decodeURIComponent(rawTag) : '';
    const isTitleSearch = _decodedTag.startsWith('title:');
    const titleQuery = isTitleSearch ? _decodedTag.substring(6).trim() : null;
    const tag = isTitleSearch ? null : lib.parseTag(rawTag ?? null);

    const mime = (rawMime ?? "");
    const userHallSlug = rawUserHall || null;
    const userHallOwner = rawUserHallOwner || null;

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

    const { mimeParts, mimeSQL } = resolveMimeSQL(mime, session);
    const excludedTags = session && exclude ? (exclude || []) : [];

    const strictParams = ((strict || (tag && tag.includes(','))) && tag) ? tag.split(',').map(t => lib.slugify(t)).filter(t => t) : [];
    const isStrict = strictParams.length > 0;

    const ratingsArr = (Array.isArray(ratings) && ratings.length > 0) ? ratings : null;
    const multiRatingSQL = ratingsArr ? lib.getMultiRatingMode(ratingsArr) : null;
    const modequery = computeBaseMode(mode, ratings, session);

    // Common filter fragments
    const globalFilter = (!session || isAnonSession(session)) && getGlobalfilter(session) ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))` : db``;
    const excludeFilter = excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id = any(${excludedTags}::int[]))` : db``;

    let rows;

    if (isTitleSearch && titleQuery) {
      rows = await db`
        SELECT items.id, items.slug FROM items
        WHERE ${db.unsafe(modequery)}
          AND items.active = true AND coalesce(items.visibility, 0) = 0
          AND items.title ILIKE ${'%' + titleQuery + '%'} AND items.title IS NOT NULL
          ${mimeSQL} ${globalFilter} ${excludeFilter}
        ORDER BY items.id
      `;
    } else if (fav && user) {
      rows = await db`
        SELECT DISTINCT items.id, items.slug FROM favorites
        INNER JOIN items ON favorites.item_id = items.id
        INNER JOIN "user" ON "user".id = favorites.user_id
        WHERE ${db.unsafe(modequery)}
          AND "user".user ILIKE ${userLike}
          AND items.active = true AND coalesce(items.visibility, 0) = 0
          ${mimeSQL} ${globalFilter}
        ORDER BY items.id
      `;
    } else if (user || tag) {
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

      rows = await db`
        SELECT items.id, items.slug FROM items
        WHERE ${db.unsafe(modequery)}
          AND items.active = true AND coalesce(items.visibility, 0) = 0
          ${tagFilter}
          ${user ? db`and items.username ilike ${userLike}` : db``}
          ${hall ? db`and items.id in (select item_id from halls_assign ha join halls h on h.id = ha.hall_id where h.slug = ${hall})` : db``}
          ${mimeSQL} ${globalFilter} ${excludeFilter}
        ORDER BY items.id
      `;
    } else if (hall) {
      rows = await db`
        SELECT items.id, items.slug FROM items
        JOIN halls_assign ha ON ha.item_id = items.id
        JOIN halls h ON h.id = ha.hall_id
        WHERE ${db.unsafe(modequery)}
          AND h.slug = ${hall}
          AND items.active = true AND coalesce(items.visibility, 0) = 0
          ${mimeSQL} ${globalFilter} ${excludeFilter}
        ORDER BY items.id
      `;
    } else if (userHallId) {
      rows = await db`
        SELECT items.id, items.slug FROM items
        JOIN user_halls_assign uha ON uha.item_id = items.id
        WHERE ${db.unsafe(modequery)}
          AND uha.hall_id = ${userHallId}
          AND items.active = true AND coalesce(items.visibility, 0) = 0
          ${mimeSQL} ${excludeFilter}
        ORDER BY items.id
      `;
    } else {
      // Global pool — use tag optimization where possible
      const globalModeQuery = modequery;
      const tagId = session && !isAnonSession(session) && !multiRatingSQL && (mode === 0 || mode === 1 || mode === 4)
        ? (mode === 4 ? (cfg.nsfl_tag_id || 3) : (mode === 1 ? 2 : 1))
        : null;
      const useTagIdOpt = tagId && !mimeParts.includes('audio');
      const nsfpIds = cfg.nsfp || [];
      const checkFilter = (!session || isAnonSession(session)) && nsfpIds.length > 0 && (mode === 0 || mode === 3 || mode === undefined || mode === null);

      rows = await db`
        SELECT items.id, items.slug FROM items
        ${useTagIdOpt ? db`INNER JOIN tags_assign ta ON ta.item_id = items.id AND ta.tag_id = ${tagId}` : db``}
        ${checkFilter ? db`LEFT JOIN tags_assign filter_ta ON filter_ta.item_id = items.id AND filter_ta.tag_id IN ${db(nsfpIds)}` : db``}
        WHERE items.active = true AND coalesce(items.visibility, 0) = 0
          ${mimeSQL}
          ${checkFilter ? db`AND filter_ta.tag_id IS NULL` : db``}
          ${excludeFilter}
          ${!useTagIdOpt ? db`AND ${db.unsafe(globalModeQuery)}` : db``}
        ORDER BY items.id LIMIT 10000
      `;
    }

    const items = rows.map(r => r.slug || String(r.id));
    const idMap = {};
    for (const r of rows) {
      if (r.slug) idMap[r.slug] = r.id;
    }
    return { items, id_map: idMap, total: items.length, sampled: items.length >= 10000 };
  },
  getComments: async (itemId, sort = 'new', process = true) => {
    const numericId = await resolveNumericItemId(itemId);
    if (!numericId) return [];
    const tStart = Date.now();
    try {
      const comments = await db`
            SELECT
                c.id, c.parent_id, c.content, c.created_at, c.vote_score, c.is_deleted,
                COALESCE(c.is_pinned, false) as is_pinned,
                c.video_time,
                u.user as username, u.id as user_id, uo.avatar, uo.avatar_file, uo.username_color, uo.display_name, uo.banner_file, uo.banner_position, uo.banner_size, uo.banner_repeat,
                (SELECT count(*) FROM comments r WHERE r.parent_id = c.id) as reply_count,
                ai.fingerprint as anon_fingerprint
            FROM comments c
            JOIN "user" u ON c.user_id = u.id
            LEFT JOIN user_options uo ON uo.user_id = u.id
            LEFT JOIN anon_identities ai ON ai.user_id = u.id
            WHERE c.item_id = ${numericId} AND c.is_deleted = false
            ORDER BY COALESCE(c.is_pinned, false) DESC,
                CASE WHEN ${sort !== 'new'} THEN c.created_at END ASC,
                CASE WHEN ${sort === 'new'} THEN c.created_at END DESC
        `;

      for (const c of comments) {
        if (c.anon_fingerprint) {
          c.is_anon = true;
          c.username = 'anonymous';
          c.display_name = 'Anonymous';
          c.anon_short_fingerprint = c.anon_fingerprint.slice(7, 15);
        }
      }

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
              COALESCE(cp.is_anonymous, true) as is_anonymous,
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
            GROUP BY cp.id, cp.comment_id, cp.question, cp.expires_at, cp.is_anonymous
          `;
          // For non-anonymous polls, fetch voter names
          const nonAnonIds = pollRows.filter(p => !p.is_anonymous).map(p => p.poll_id);
          let votersByOption = new Map();
          if (nonAnonIds.length > 0) {
            const voterRows = await db`
              SELECT cpv.option_id, u."user" as username, uo.avatar, uo.avatar_file
              FROM comment_poll_votes cpv
              JOIN public."user" u ON u.id = cpv.user_id
              LEFT JOIN public.user_options uo ON uo.user_id = cpv.user_id
              WHERE cpv.poll_id = ANY(${nonAnonIds}::int[])
            `;
            for (const v of voterRows) {
              if (!votersByOption.has(v.option_id)) votersByOption.set(v.option_id, []);
              votersByOption.get(v.option_id).push({ username: v.username, avatar: v.avatar, avatar_file: v.avatar_file });
            }
          }
          const pollMap = new Map();
          for (const p of pollRows) {
            const options = p.is_anonymous
              ? p.options
              : p.options.map(o => ({ ...o, voters: votersByOption.get(o.id) || [] }));
            pollMap.set(p.comment_id, {
              id: p.poll_id,
              question: p.question,
              expires_at: p.expires_at,
              is_anonymous: p.is_anonymous,
              options,
              total_votes: parseInt(p.total_votes) || 0,
              user_vote_option_id: null
            });
          }
          for (const c of comments) {
            c.poll = pollMap.get(c.id) || null;
          }
        } catch (e) {
          console.error('[POLLS] getComments poll fetch error:', e.message, e.code);
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
                u.user as username, u.id as user_id, uo.avatar, uo.avatar_file, uo.username_color, uo.display_name, uo.banner_file, uo.banner_position, uo.banner_size, uo.banner_repeat
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
    if (cfg.enable_comments === false) return false;
    const numericId = await resolveNumericItemId(itemId);
    if (!userId || !numericId) return false;
    const tStart = Date.now();
    try {
      const sub = await db`SELECT 1 FROM comment_subscriptions WHERE user_id = ${userId} AND item_id = ${numericId} AND is_subscribed = true`;
      console.log(`[${new Date().toISOString()}] [GETSUB] Checked sub for item ${numericId} in ${Date.now() - tStart}ms`);
      return sub.length > 0;
    } catch (e) {
      return false;
    }
  },
  processMentions,
  markNotificationsRead: async (userId, itemId) => {
    const numericId = await resolveNumericItemId(itemId);
    if (!userId || !numericId) return;
    try {
      await db`UPDATE notifications SET is_read = true WHERE user_id = ${userId} AND item_id = ${numericId} AND is_read = false`;
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

  getRandomRecommendations: async ({ limit = 20, mode, ratings, session, exclude, user_id, is_admin, mime, exclude_ids } = {}) => {
    const ratingsArr = (Array.isArray(ratings) && ratings.length > 0) ? ratings : null;
    const modequery = computeBaseMode(mode, ratingsArr, session);
    const globalfilter = (!session || isAnonSession(session)) ? getGlobalfilter(session) : null;
    const excludedTags = session && exclude ? (exclude || []) : [];
    const maxLimit = Math.min(Math.max(1, Number(limit) || 20), 50);

    const isOwnerOrAdmin = session && is_admin;

    const visibilityFilter = isOwnerOrAdmin
      ? db``
      : (session && user_id
          ? db`AND (COALESCE(items.visibility, 0) = 0 OR items.username = (SELECT "user" FROM "user" WHERE id = ${user_id}))`
          : db`AND COALESCE(items.visibility, 0) = 0`);

    const excludeItemIds = Array.isArray(exclude_ids)
      ? exclude_ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : (typeof exclude_ids === 'string'
          ? exclude_ids.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0)
          : []);

    const excludeIdsFilter = excludeItemIds.length > 0
      ? db`AND items.id != ALL(${excludeItemIds}::int[])`
      : db``;

    const { mimeParts, mimeSQL } = resolveMimeSQL(mime, session);

    let rows;
    if (mimeParts.length > 0) {
      rows = await db`
        WITH rand_items AS (
          SELECT items.id, items.title, items.slug, items.mime, items.dest, items.username, items.stamp, items.xd_score, items.width, items.height, items.has_coverart
          FROM items
          WHERE items.active = true
            AND (items.is_deleted IS NOT TRUE)
            ${mimeSQL}
            ${visibilityFilter}
            ${excludeIdsFilter}
            AND ${db.unsafe(modequery)}
            ${globalfilter ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(globalfilter)}))` : db``}
            ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
          ORDER BY random()
          LIMIT ${maxLimit}
        )
        SELECT 
          ri.*,
          uo.display_name,
          uo.username_color,
          uo.avatar,
          uo.avatar_file,
          (SELECT ta.tag_id FROM tags_assign ta WHERE ta.item_id = ri.id AND ta.tag_id = ANY(${[1, 2, cfg.nsfl_tag_id || 3]}::int[]) LIMIT 1) as rating_tag_id,
          ARRAY(
            SELECT t.tag 
            FROM tags_assign ta 
            JOIN tags t ON t.id = ta.tag_id 
            WHERE ta.item_id = ri.id AND ta.tag_id NOT IN (1, 2, 3) 
            LIMIT 3
          ) as tags
        FROM rand_items ri
        LEFT JOIN "user" u ON LOWER(u."user") = LOWER(ri.username)
        LEFT JOIN user_options uo ON uo.user_id = u.id
      `;
    } else {
      // Balanced mix across all available media types: ensure audio/music gets guaranteed representation alongside images & videos
      const audioLimit = Math.max(1, Math.min(3, Math.floor(maxLimit * 0.15)));
      rows = await db`
        WITH rand_audio AS (
          SELECT items.id, items.title, items.slug, items.mime, items.dest, items.username, items.stamp, items.xd_score, items.width, items.height, items.has_coverart
          FROM items
          WHERE items.active = true
            AND (items.is_deleted IS NOT TRUE)
            AND items.mime ILIKE 'audio/%'
            ${visibilityFilter}
            ${excludeIdsFilter}
            AND ${db.unsafe(modequery)}
            ${globalfilter ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(globalfilter)}))` : db``}
            ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
          ORDER BY random()
          LIMIT ${audioLimit}
        ),
        rand_other AS (
          SELECT items.id, items.title, items.slug, items.mime, items.dest, items.username, items.stamp, items.xd_score, items.width, items.height, items.has_coverart
          FROM items
          WHERE items.active = true
            AND (items.is_deleted IS NOT TRUE)
            AND items.mime NOT ILIKE 'audio/%'
            ${visibilityFilter}
            ${excludeIdsFilter}
            AND ${db.unsafe(modequery)}
            ${globalfilter ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(globalfilter)}))` : db``}
            ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
          ORDER BY random()
          LIMIT ${maxLimit}
        ),
        rand_items AS (
          SELECT * FROM (
            SELECT * FROM rand_audio
            UNION ALL
            SELECT * FROM rand_other
          ) sub
          ORDER BY random()
          LIMIT ${maxLimit}
        )
        SELECT 
          ri.*,
          uo.display_name,
          uo.username_color,
          uo.avatar,
          uo.avatar_file,
          (SELECT ta.tag_id FROM tags_assign ta WHERE ta.item_id = ri.id AND ta.tag_id = ANY(${[1, 2, cfg.nsfl_tag_id || 3]}::int[]) LIMIT 1) as rating_tag_id,
          ARRAY(
            SELECT t.tag 
            FROM tags_assign ta 
            JOIN tags t ON t.id = ta.tag_id 
            WHERE ta.item_id = ri.id AND ta.tag_id NOT IN (1, 2, 3) 
            LIMIT 3
          ) as tags
        FROM rand_items ri
        LEFT JOIN "user" u ON LOWER(u."user") = LOWER(ri.username)
        LEFT JOIN user_options uo ON uo.user_id = u.id
      `;
    }

    return rows.map(r => {
      const meta = xdScoreMeta(r.xd_score);
      const tagId = r.rating_tag_id;
      const ratingClass = tagId === 1 ? 'sfw' : (tagId === 2 ? 'nsfw' : (tagId === 3 ? 'nsfl' : 'untagged'));
      return {
        id: r.id,
        title: r.title || null,
        slug: r.slug || null,
        mime: r.mime,
        dest: r.dest,
        username: r.username,
        display_name: r.display_name || r.username,
        username_color: r.username_color || null,
        avatar: r.avatar || null,
        avatar_file: r.avatar_file || null,
        stamp: r.stamp,
        tags: r.tags || [],
        rating_tag_id: tagId,
        rating_class: ratingClass,
        xd_score: r.xd_score,
        xd_tier: meta.tier,
        xd_label: meta.label,
        width: r.width,
        height: r.height,
        has_coverart: !!r.has_coverart,
        score: 0,
        rank_score: 0
      };
    });
  },

  getRandomVideos: (args) => f0cklib.getRandomRecommendations({ ...args, mime: 'video' }),

  updateUserAffinity: async ({ user_id, item_id, scoreDelta = 1.0 }) => {
    if (!user_id || !item_id || !scoreDelta) return;
    try {
      const itemInfo = await db`
        SELECT i.username, COALESCE(array_agg(ta.tag_id) FILTER (WHERE ta.tag_id IS NOT NULL), '{}') as tag_ids
        FROM items i
        LEFT JOIN tags_assign ta ON ta.item_id = i.id
        WHERE i.id = ${item_id}
        GROUP BY i.id, i.username
        LIMIT 1
      `;
      if (itemInfo.length === 0) return;
      const { username: creator, tag_ids } = itemInfo[0];

      // 1. Update tag affinities
      if (tag_ids && tag_ids.length > 0) {
        await db`
          INSERT INTO user_tag_affinity (user_id, tag_id, score, interaction_count, last_interacted)
          SELECT 
            ${user_id}, 
            unnest(${tag_ids}::int[]), 
            ${scoreDelta}, 
            1, 
            now()
          ON CONFLICT (user_id, tag_id) DO UPDATE SET
            score = GREATEST(-10.0, LEAST(1000.0, user_tag_affinity.score + EXCLUDED.score)),
            interaction_count = user_tag_affinity.interaction_count + 1,
            last_interacted = now()
        `;
      }

      // 2. Update creator affinity
      if (creator && creator.trim()) {
        await db`
          INSERT INTO user_creator_affinity (user_id, creator_username, score, interaction_count, last_interacted)
          VALUES (${user_id}, ${creator.trim()}, ${scoreDelta}, 1, now())
          ON CONFLICT (user_id, creator_username) DO UPDATE SET
            score = GREATEST(-10.0, LEAST(1000.0, user_creator_affinity.score + EXCLUDED.score)),
            interaction_count = user_creator_affinity.interaction_count + 1,
            last_interacted = now()
        `;
      }
    } catch (err) {
      console.error("[AFFINITY] Failed to update user affinity:", err);
    }
  },

  updateUserTagAffinity: async ({ user_id, tag, scoreDelta = 2.0 }) => {
    if (!user_id || !tag || !scoreDelta) return;
    try {
      const rawList = typeof tag === 'string'
        ? tag.split(',')
        : (Array.isArray(tag) ? tag : [tag]);

      const tagsList = rawList
        .map(t => typeof t === 'string' ? t.trim().toLowerCase() : '')
        .filter(t => t && !t.startsWith('title:') && !t.startsWith('src:'))
        .slice(0, 10);

      if (tagsList.length === 0) return;

      const slugList = tagsList.map(t => lib.slugify(t)).filter(Boolean);

      const tagRows = await db`
        SELECT DISTINCT id FROM tags 
        WHERE LOWER(tag) = ANY(${tagsList}::text[]) 
           OR (normalized != '' AND normalized = ANY(${slugList}::text[]))
      `;
      if (tagRows.length === 0) return;

      const tagIds = tagRows.map(r => r.id);

      // Guard: Only increment score and interaction_count if last_interacted was more than 10s ago,
      // avoiding duplicate score inflation from rapid page refreshes or dual beacon/page loads.
      await db`
        INSERT INTO user_tag_affinity (user_id, tag_id, score, interaction_count, last_interacted)
        SELECT 
          ${user_id}, 
          unnest(${tagIds}::int[]), 
          ${scoreDelta}, 
          1, 
          now()
        ON CONFLICT (user_id, tag_id) DO UPDATE SET
          score = CASE 
            WHEN user_tag_affinity.last_interacted < now() - interval '10 seconds'
            THEN GREATEST(-10.0, LEAST(1000.0, user_tag_affinity.score + EXCLUDED.score))
            ELSE user_tag_affinity.score
          END,
          interaction_count = CASE
            WHEN user_tag_affinity.last_interacted < now() - interval '10 seconds'
            THEN user_tag_affinity.interaction_count + 1
            ELSE user_tag_affinity.interaction_count
          END,
          last_interacted = now()
      `;
    } catch (err) {
      console.error("[AFFINITY] Failed to update user tag affinity from search:", err);
    }
  },

  decayUserAffinities: async () => {
    try {
      await db`
        UPDATE user_tag_affinity 
        SET score = score * 0.85 
        WHERE last_interacted < now() - interval '7 days' AND score > 0.1
      `;
      await db`
        UPDATE user_creator_affinity 
        SET score = score * 0.85 
        WHERE last_interacted < now() - interval '7 days' AND score > 0.1
      `;
      await db`DELETE FROM user_tag_affinity WHERE score < 0.05 AND interaction_count < 2`;
      await db`DELETE FROM user_creator_affinity WHERE score < 0.05 AND interaction_count < 2`;
    } catch (err) {
      console.error("[AFFINITY] Decay job error:", err);
    }
  },

  getPersonalizedRecommendations: async ({ 
    limit = 20, 
    mode, 
    ratings, 
    session, 
    exclude, 
    user_id, 
    is_admin, 
    mime, 
    exclude_ids,
    session_tags = '',
    session_creators = '',
    continuation = false,
    prefer_personalized = null
  } = {}) => {
    const ratingsArr = (Array.isArray(ratings) && ratings.length > 0) ? ratings : null;
    const modequery = computeBaseMode(mode, ratingsArr, session);
    const globalfilter = (!session || isAnonSession(session)) ? getGlobalfilter(session) : null;
    const excludedTags = session && exclude ? (exclude || []) : [];
    const maxLimit = Math.min(Math.max(1, Number(limit) || 20), 50);

    const isOwnerOrAdmin = session && is_admin;

    const visibilityFilter = isOwnerOrAdmin
      ? db``
      : (session && user_id
          ? db`AND (COALESCE(items.visibility, 0) = 0 OR items.username = (SELECT "user" FROM "user" WHERE id = ${user_id}))`
          : db`AND COALESCE(items.visibility, 0) = 0`);

    const excludeItemIds = Array.isArray(exclude_ids)
      ? exclude_ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : (typeof exclude_ids === 'string'
          ? exclude_ids.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0)
          : []);

    // 1. Gather User & Session Profile
    const tagMap = new Map();
    const creatorSet = new Set();

    if (user_id) {
      try {
        const dbTags = await db`
          SELECT tag_id, score 
          FROM user_tag_affinity 
          WHERE user_id = ${user_id} AND score > 0 
          ORDER BY score DESC 
          LIMIT 30
        `;
        dbTags.forEach(r => tagMap.set(r.tag_id, Number(r.score)));

        const dbCreators = await db`
          SELECT creator_username 
          FROM user_creator_affinity 
          WHERE user_id = ${user_id} AND score > 0 
          ORDER BY score DESC 
          LIMIT 15
        `;
        dbCreators.forEach(r => { if (r.creator_username) creatorSet.add(r.creator_username); });
      } catch (err) {
        console.error("[RECS] Failed to load user affinity profile:", err);
      }
    }

    // Process session tags (for guests or live in-session acceleration)
    const stList = (typeof session_tags === 'string' ? session_tags.split(',') : (Array.isArray(session_tags) ? session_tags : []))
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 20);

    if (stList.length > 0) {
      try {
        const stRows = await db`SELECT id, tag FROM tags WHERE LOWER(tag) = ANY(${stList}::text[])`;
        stRows.forEach(r => {
          tagMap.set(r.id, (tagMap.get(r.id) || 0) + 8.0);
        });
      } catch (err) {
        console.error("[RECS] Failed to resolve session tags:", err);
      }
    }

    // Process session creators
    const scList = (typeof session_creators === 'string' ? session_creators.split(',') : (Array.isArray(session_creators) ? session_creators : []))
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 15);
    scList.forEach(c => creatorSet.add(c));

    const targetTagEntries = Array.from(tagMap.entries()).filter(([tid, s]) => s > 0).slice(0, 35);
    const targetCreators = Array.from(creatorSet);

    // If cold start (no learned tags and no creators): fallback directly to pure random recommendations
    if (targetTagEntries.length === 0 && targetCreators.length === 0) {
      return f0cklib.getRandomRecommendations({
        limit: maxLimit,
        mode,
        ratings,
        session,
        exclude,
        user_id,
        is_admin,
        mime,
        exclude_ids: excludeItemIds
      });
    }

    // 2. Personalization vs Serendipity Split
    // In the sidebar suggestions:
    // - 1 of the first 3 recommendations is a personalized recommendation and the other 2 are not.
    // - After that, recommendations appear sporadically (~20% rate, non-consecutive with 3-5 random items between them).
    const isFirstBatch = !continuation && excludeItemIds.length === 0;
    let personalizedTarget;

    if (maxLimit === 1) {
      if (prefer_personalized === true) {
        personalizedTarget = 1;
      } else if (prefer_personalized === false) {
        personalizedTarget = 0;
      } else {
        personalizedTarget = Math.random() < 0.20 ? 1 : 0;
      }
    } else if (isFirstBatch) {
      // 1 in top 3, plus sporadic recommendations in the remaining slots
      const topRec = maxLimit >= 1 ? 1 : 0;
      const remainingSlots = Math.max(0, maxLimit - 3);
      const sporadicRecs = Math.round(remainingSlots * 0.20);
      personalizedTarget = topRec + sporadicRecs;
    } else {
      // Continuation batch: sporadic recommendations throughout
      personalizedTarget = Math.max(1, Math.round(maxLimit * 0.20));
    }

    const targetTagIds = targetTagEntries.map(([tid]) => tid);
    const targetTagScores = targetTagEntries.map(([, score]) => score);

    const excludeIdsFilter = excludeItemIds.length > 0
      ? db`AND items.id != ALL(${excludeItemIds}::int[])`
      : db``;

    const { mimeParts, mimeSQL } = resolveMimeSQL(mime, session);

    let personalizedItems = [];
    if (personalizedTarget > 0 && targetTagIds.length > 0) {
      try {
        const poolLimit = Math.max(personalizedTarget * 3, 25);
        const candidateRows = await db`
          WITH user_tags AS (
            SELECT unnest(${targetTagIds}::int[]) as tag_id, unnest(${targetTagScores}::real[]) as score
          ),
          candidate_pool AS (
            SELECT 
              items.id, items.title, items.slug, items.mime, items.dest, items.username, items.stamp, items.xd_score, items.width, items.height, items.has_coverart,
              (
                SUM(ut.score) * 1.5 
                + CASE WHEN items.username = ANY(${targetCreators}::text[]) THEN 20.0 ELSE 0.0 END
                + (random() * 12.0)
              ) as rank_score
            FROM items
            JOIN tags_assign ta ON ta.item_id = items.id
            JOIN user_tags ut ON ut.tag_id = ta.tag_id
            WHERE items.active = true
              AND (items.is_deleted IS NOT TRUE)
              ${visibilityFilter}
              ${excludeIdsFilter}
              ${mimeSQL}
              AND ${db.unsafe(modequery)}
              ${globalfilter ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(globalfilter)}))` : db``}
              ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
            GROUP BY items.id, items.title, items.slug, items.mime, items.dest, items.username, items.stamp, items.xd_score, items.width, items.height, items.has_coverart
            ORDER BY rank_score DESC
            LIMIT ${poolLimit}
          )
          SELECT 
            cp.*,
            uo.display_name,
            uo.username_color,
            uo.avatar,
            uo.avatar_file,
            (SELECT ta.tag_id FROM tags_assign ta WHERE ta.item_id = cp.id AND ta.tag_id = ANY(${[1, 2, cfg.nsfl_tag_id || 3]}::int[]) LIMIT 1) as rating_tag_id,
            ARRAY(
              SELECT t.tag 
              FROM tags_assign ta 
              JOIN tags t ON t.id = ta.tag_id 
              WHERE ta.item_id = cp.id AND ta.tag_id NOT IN (1, 2, 3) 
              LIMIT 3
            ) as tags
          FROM (
            SELECT * FROM candidate_pool ORDER BY random() LIMIT ${personalizedTarget}
          ) cp
          LEFT JOIN "user" u ON LOWER(u."user") = LOWER(cp.username)
          LEFT JOIN user_options uo ON uo.user_id = u.id
        `;

        personalizedItems = candidateRows.map(r => {
          const meta = xdScoreMeta(r.xd_score);
          const tagId = r.rating_tag_id;
          const ratingClass = tagId === 1 ? 'sfw' : (tagId === 2 ? 'nsfw' : (tagId === 3 ? 'nsfl' : 'untagged'));
          return {
            id: r.id,
            title: r.title || null,
            slug: r.slug || null,
            mime: r.mime,
            dest: r.dest,
            username: r.username,
            display_name: r.display_name || r.username,
            username_color: r.username_color || null,
            avatar: r.avatar || null,
            avatar_file: r.avatar_file || null,
            stamp: r.stamp,
            tags: r.tags || [],
            rating_tag_id: tagId,
            rating_class: ratingClass,
            xd_score: r.xd_score,
            xd_tier: meta.tier,
            xd_label: meta.label,
            width: r.width,
            height: r.height,
            has_coverart: !!r.has_coverart,
            personalized: true,
            score: r.rank_score != null ? Math.round(Number(r.rank_score) * 10) / 10 : 0,
            rank_score: r.rank_score != null ? Math.round(Number(r.rank_score) * 10) / 10 : 0
          };
        });
      } catch (err) {
        console.error("[RECS] Error querying personalized candidate pool:", err);
      }
    }

    // 3. Fetch Random Exploration Items
    const neededRandom = maxLimit - personalizedItems.length;
    let randomItems = [];
    if (neededRandom > 0) {
      const allExclude = [...excludeItemIds, ...personalizedItems.map(p => p.id)];
      // Fetch extra buffer of random items to ensure ample spacing
      randomItems = await f0cklib.getRandomRecommendations({
        limit: Math.max(neededRandom + 3, maxLimit),
        mode,
        ratings,
        session,
        exclude,
        user_id,
        is_admin,
        mime,
        exclude_ids: allExclude
      });
    }

    // 4. Combine & Interweave
    if (maxLimit === 1) {
      return personalizedItems.length > 0 ? personalizedItems.slice(0, 1) : randomItems.slice(0, 1);
    }

    if (personalizedItems.length === 0) {
      return randomItems.slice(0, maxLimit);
    }

    if (randomItems.length === 0) {
      return personalizedItems.slice(0, maxLimit);
    }

    const result = [];
    if (isFirstBatch) {
      // First 3 items: exactly 1 is a recommendation, and the other 2 are not
      const topCount = Math.min(3, maxLimit);
      const topSlots = new Array(topCount);
      const recSlot = Math.floor(Math.random() * topCount);
      topSlots[recSlot] = personalizedItems.shift();

      for (let s = 0; s < topCount; s++) {
        if (s !== recSlot) {
          topSlots[s] = randomItems.length > 0 ? randomItems.shift() : personalizedItems.shift();
        }
      }
      for (let s = 0; s < topCount; s++) {
        if (topSlots[s]) result.push(topSlots[s]);
      }

      // Remaining slots: recommendations come sporadically (separated by 3 to 5 non-recommendations)
      let gapSinceRec = topCount - 1 - recSlot;
      let targetGap = Math.floor(Math.random() * 3) + 3; // 3, 4, or 5 random items

      while (result.length < maxLimit && (personalizedItems.length > 0 || randomItems.length > 0)) {
        if (personalizedItems.length > 0 && gapSinceRec >= targetGap && randomItems.length > 0) {
          result.push(personalizedItems.shift());
          gapSinceRec = 0;
          targetGap = Math.floor(Math.random() * 3) + 3;
        } else if (randomItems.length > 0) {
          result.push(randomItems.shift());
          gapSinceRec++;
        } else if (personalizedItems.length > 0) {
          result.push(personalizedItems.shift());
          gapSinceRec = 0;
        }
      }
    } else {
      // Continuation batch: recommendations come sporadically throughout
      let gapSinceRec = Math.floor(Math.random() * 2) + 1;
      let targetGap = Math.floor(Math.random() * 3) + 3;

      while (result.length < maxLimit && (personalizedItems.length > 0 || randomItems.length > 0)) {
        if (personalizedItems.length > 0 && gapSinceRec >= targetGap && randomItems.length > 0) {
          result.push(personalizedItems.shift());
          gapSinceRec = 0;
          targetGap = Math.floor(Math.random() * 3) + 3;
        } else if (randomItems.length > 0) {
          result.push(randomItems.shift());
          gapSinceRec++;
        } else if (personalizedItems.length > 0) {
          result.push(personalizedItems.shift());
          gapSinceRec = 0;
        }
      }
    }

    return result.slice(0, maxLimit);
  },

  getTagFeedItems: async ({ 
    tag, 
    order = 'desc', // 'desc' = newest first (default), 'asc' = oldest first (chronological)
    offset = 0, 
    limit = 20, 
    focus_id = null,
    mode, 
    ratings, 
    session, 
    exclude, 
    user_id, 
    is_admin, 
    mime,
    strict = false
  } = {}) => {
    if (!tag || !tag.trim()) return { items: [], total: 0 };

    const ratingsArr = (Array.isArray(ratings) && ratings.length > 0) ? ratings : null;
    const modequery = computeBaseMode(mode, ratingsArr, session);
    const globalfilter = (!session || isAnonSession(session)) ? getGlobalfilter(session) : null;
    const excludedTags = session && exclude ? (exclude || []) : [];
    const maxLimit = Math.min(Math.max(1, Number(limit) || 20), 50);
    const numOffset = Math.max(0, Number(offset) || 0);
    const isOwnerOrAdmin = session && is_admin;

    const visibilityFilter = isOwnerOrAdmin
      ? db``
      : (session && user_id
          ? db`AND (COALESCE(items.visibility, 0) = 0 OR items.username = (SELECT "user" FROM "user" WHERE id = ${user_id}))`
          : db`AND COALESCE(items.visibility, 0) = 0`);

    const { mimeParts, mimeSQL } = resolveMimeSQL(mime, session);

    const terms = tag.split(',').map(t => t.trim()).filter(Boolean);
    const isStrict = !!strict || (tag && tag.includes(','));
    let tagConditions;
    if (isStrict) {
      tagConditions = terms.length > 0 ? [db`and (items.id in (
        select ta.item_id 
        from tags_assign ta 
        join tags t on t.id = ta.tag_id 
        where t.normalized = ANY(ARRAY(SELECT slugify(x) FROM unnest(${terms}::text[]) AS x))
        group by ta.item_id 
        having count(distinct t.normalized) = ${terms.length}
      ) or items.id in (
        select ai.item_id 
        from album_items ai
        join album_items_tags_assign aita on aita.album_item_id = ai.id 
        join tags t on t.id = aita.tag_id 
        where t.normalized = ANY(ARRAY(SELECT slugify(x) FROM unnest(${terms}::text[]) AS x))
        group by ai.item_id 
        having count(distinct t.normalized) = ${terms.length}
      ))` ] : [];
    } else {
      tagConditions = terms.map(term => {
        return db`and (items.id in (
          select ta.item_id 
          from tags_assign ta 
          join tags t on t.id = ta.tag_id 
          where t.normalized like '%' || slugify(${term}) || '%'
        ) or items.id in (
          select ai.item_id 
          from album_items ai
          join album_items_tags_assign aita on aita.album_item_id = ai.id 
          join tags t on t.id = aita.tag_id 
          where t.normalized like '%' || slugify(${term}) || '%'
        ))`;
      });
    }

    const isDesc = String(order).toLowerCase() === 'desc';
    const sortOrderItems = isDesc ? db`items.id desc` : db`items.id asc`;
    const sortOrderMi = isDesc ? db`mi.id desc` : db`mi.id asc`;

    let computedOffset = numOffset;
    let computedLimit = maxLimit;

    if (focus_id) {
      const numFocusId = await resolveNumericItemId(focus_id);
      if (numFocusId) {
        try {
          const rankRes = await db`
            WITH ordered AS (
              SELECT items.id, ROW_NUMBER() OVER (ORDER BY ${sortOrderItems}) - 1 as row_num
              FROM items
              WHERE items.active = true
                AND (items.is_deleted IS NOT TRUE)
                ${visibilityFilter}
                ${mimeSQL}
                AND ${db.unsafe(modequery)}
                ${globalfilter ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(globalfilter)}))` : db``}
                ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
                ${tagConditions}
            )
            SELECT row_num FROM ordered WHERE id = ${numFocusId} LIMIT 1
          `;
          if (rankRes.length > 0) {
            const rowNum = parseInt(rankRes[0].row_num, 10);
            if (rowNum < 30) {
              computedOffset = 0;
              computedLimit = Math.min(50, Math.max(20, rowNum + 10));
            } else {
              computedOffset = Math.max(0, rowNum - 6);
              computedLimit = 25;
            }
          }
        } catch (err) {
          console.error('[TAG-FEED] Error computing focus_id offset:', err);
        }
      }
    }

    const countRes = await db`
      SELECT count(distinct items.id) as total
      FROM items
      WHERE items.active = true
        AND (items.is_deleted IS NOT TRUE)
        ${visibilityFilter}
        ${mimeSQL}
        AND ${db.unsafe(modequery)}
        ${globalfilter ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(globalfilter)}))` : db``}
        ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
        ${tagConditions}
    `;
    const total = parseInt(countRes[0]?.total || 0, 10);

    const rows = await db`
      WITH matched_items AS (
        SELECT items.id, items.title, items.slug, items.mime, items.dest, items.username, items.stamp, items.xd_score, items.width, items.height, items.has_coverart, items.is_album
        FROM items
        WHERE items.active = true
          AND (items.is_deleted IS NOT TRUE)
          ${visibilityFilter}
          ${mimeSQL}
          AND ${db.unsafe(modequery)}
          ${globalfilter ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND (${db.unsafe(globalfilter)}))` : db``}
          ${excludedTags.length > 0 ? db`AND NOT EXISTS (SELECT 1 FROM tags_assign WHERE item_id = items.id AND tag_id = ANY(${excludedTags}::int[]))` : db``}
          ${tagConditions}
        ORDER BY ${sortOrderItems}
        OFFSET ${computedOffset}
        LIMIT ${computedLimit}
      )
      SELECT 
        mi.*,
        uo.display_name,
        uo.username_color,
        uo.avatar,
        uo.avatar_file,
        (SELECT ta.tag_id FROM tags_assign ta WHERE ta.item_id = mi.id AND ta.tag_id = ANY(${[1, 2, cfg.nsfl_tag_id || 3]}::int[]) LIMIT 1) as rating_tag_id,
        ARRAY(
          SELECT t.tag 
          FROM tags_assign ta 
          JOIN tags t ON t.id = ta.tag_id 
          WHERE ta.item_id = mi.id AND ta.tag_id NOT IN (1, 2, 3) 
          LIMIT 3
        ) as tags
      FROM matched_items mi
      LEFT JOIN "user" u ON LOWER(u."user") = LOWER(mi.username)
      LEFT JOIN user_options uo ON uo.user_id = u.id
      ORDER BY ${sortOrderMi}
    `;

    if (rows.some(r => r.is_album)) {
      const albumIds = rows.filter(r => r.is_album).map(r => r.id);
      if (terms.length > 0 && albumIds.length > 0) {
        try {
          const matchingSubs = await db`
            SELECT
              ai.item_id,
              ai.id as subf0ck_id,
              ai.slug as subf0ck_slug,
              ai.dest as subf0ck_dest,
              ai.mime as subf0ck_mime,
              ai.order_index
            FROM album_items ai
            JOIN album_items_tags_assign aita ON aita.album_item_id = ai.id
            JOIN tags t ON t.id = aita.tag_id
            WHERE ai.item_id = ANY(${albumIds}::int[])
              AND (${isStrict
                ? db`t.normalized = ANY(ARRAY(SELECT slugify(x) FROM unnest(${terms}::text[]) AS x))`
                : db`${terms.map(term => db`t.normalized LIKE '%' || slugify(${term}) || '%'`).reduce((a, b) => db`${a} OR ${b}`)}`
              })
            ORDER BY ai.item_id, ai.order_index ASC
          `;

          const matchMap = new Map();
          for (const ms of matchingSubs) {
            if (!matchMap.has(ms.item_id)) {
              matchMap.set(ms.item_id, ms);
            }
          }

          for (const row of rows) {
            if (matchMap.has(row.id)) {
              const ms = matchMap.get(row.id);
              row.target_subf0ck_slug = ms.subf0ck_slug || ms.subf0ck_id;
              if (ms.subf0ck_dest) {
                const subBase = ms.subf0ck_dest.replace(/\.[^.]+$/, '');
                row.thumb = `/t/${subBase}.webp`;
                row.matching_sub_thumb = `/t/${subBase}.webp`;
                row.matching_sub_dest = ms.subf0ck_dest;
                row.dest = ms.subf0ck_dest;
              }
              if (ms.subf0ck_mime) {
                row.matching_sub_mime = ms.subf0ck_mime;
                row.mime = ms.subf0ck_mime;
              }
            }
          }
        } catch (err) {
          console.warn('[TAG-FEED] Error resolving matching subf0cks for tag feed:', err.message);
        }
      }
    }

    const items = rows.map(r => {
      const meta = xdScoreMeta(r.xd_score);
      const tagId = r.rating_tag_id;
      const ratingClass = tagId === 1 ? 'sfw' : (tagId === 2 ? 'nsfw' : (tagId === 3 ? 'nsfl' : 'untagged'));
      return {
        id: r.id,
        title: r.title || null,
        slug: r.slug || null,
        mime: r.matching_sub_mime || r.mime,
        dest: r.matching_sub_dest || r.dest,
        thumb: r.thumb || `/t/${r.id}.webp`,
        matching_sub_dest: r.matching_sub_dest || null,
        matching_sub_mime: r.matching_sub_mime || null,
        matching_sub_thumb: r.matching_sub_thumb || null,
        target_subf0ck_slug: r.target_subf0ck_slug || null,
        username: r.username,
        display_name: r.display_name || r.username,
        username_color: r.username_color || null,
        avatar: r.avatar || null,
        avatar_file: r.avatar_file || null,
        stamp: r.stamp,
        tags: r.tags || [],
        rating_tag_id: tagId,
        rating_class: ratingClass,
        xd_score: r.xd_score,
        xd_tier: meta.tier,
        xd_label: meta.label,
        width: r.width,
        height: r.height,
        has_coverart: !!r.has_coverart,
        score: r.xd_score || 0,
        rank_score: 0
      };
    });

    return { items, total, offset: computedOffset, limit: computedLimit };
  },


  resolveNumericItemId,
  computeBaseMode,
  getGlobalfilter,
  processMentions,
  processEmbeds,
  computeXdScore,
  xdScoreMeta,
  resolveMimeSQL,
  // Bust the count cache (call after a new upload is accepted so page totals stay accurate)
  clearCountCache: () => countCache.clear()
};

export { resolveNumericItemId };
export default f0cklib;


