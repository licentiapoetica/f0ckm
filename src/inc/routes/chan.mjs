import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";
import queue from "../queue.mjs";
import { chanCurl } from "../chan_http.mjs";
import { getSessionOwnerName, getEnableItemSlugs, isOnaraEnabledFor } from "../settings.mjs";

// Link path for a local item: its slug when slugs are enabled, else the numeric id
const itemPath = (id, slug) => (getEnableItemSlugs() && slug) ? slug : id;

/**
 * chan.mjs — 4chan thread viewer & catalogue routes
 * Restricted to users with the '4chan' group (and admins).
 */
export default (router, tpl) => {

  const COMMON_BOARDS = [
    { id: 'wsg', name: 'Worksafe GIF', icon: 'fa-film' },
    { id: 'gif', name: 'Adult GIF', icon: 'fa-video' },
    { id: 'b',   name: 'Random', icon: 'fa-dice' },
    { id: 'v',   name: 'Video Games', icon: 'fa-gamepad' },
    { id: 'vg',  name: 'Video Game Generals', icon: 'fa-gamepad' },
    { id: 'a',   name: 'Anime & Manga', icon: 'fa-tv' },
    { id: 'g',   name: 'Technology', icon: 'fa-microchip' },
    { id: 'pol', name: 'Politically Incorrect', icon: 'fa-globe' },
    { id: 'tv',  name: 'Television & Film', icon: 'fa-tv' },
    { id: 'mu',  name: 'Music', icon: 'fa-music' },
    { id: 'fit', name: 'Fitness', icon: 'fa-dumbbell' },
    { id: 'ck',  name: 'Food & Cooking', icon: 'fa-utensils' }
  ];

  /**
   * Helper to fetch data via curl respecting SOCKS5 proxy if configured.
   */
  async function fetchWithProxy(url) {
    const { bin, args } = chanCurl(url, ['--max-time', '30']);
    const { stdout } = await queue.spawn(bin, args, { encoding: 'utf8' });
    const text = typeof stdout === 'string' ? stdout.trim() : stdout.toString().trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 100)}`);
    }
    return JSON.parse(text);
  }

  function formatComment(com) {
    if (!com) return '';
    let formatted = com;
    // 1. Normalize existing 4chan intra-thread quotelinks to standard format
    formatted = formatted.replace(/<a\s+[^>]*href="#p(\d+)"[^>]*>.*?<\/a>/gi, '___CHANREF_$1___');
    // 2. Normalize cross-thread/cross-board quotelinks if any
    formatted = formatted.replace(/<a\s+[^>]*href="(\/[^"]+)"[^>]*>(.*?)<\/a>/gi, '<a href="$1" class="chan-ref chan-cross-ref" target="_blank">$2</a>');
    // 3. Format any unlinked quotes &gt;&gt;123456
    formatted = formatted.replace(/(?<!&gt;)&gt;&gt;(\d+)\b/g, '___CHANREF_$1___');
    // 4. Also support plain >>123456 if plain text was supplied
    formatted = formatted.replace(/(?<![>\w])>>(\d+)\b/g, '___CHANREF_$1___');
    // 5. Restore CHANREF placeholders
    formatted = formatted.replace(/___CHANREF_(\d+)___/g, '<a href="#p$1" class="chan-ref quotelink" data-post="$1">&gt;&gt;$1</a>');
    // 6. Format quote lines (greentext)
    formatted = formatted.replace(/(^|<br\s*\/?>)&gt;(?!&gt;)([^\n<]+)/g, '$1<span class="chan-quote">&gt;$2</span>');
    return formatted;
  }

  function extractQuotes(com) {
    if (!com) return [];
    const quotes = new Set();
    for (const m of com.matchAll(/href="#p(\d+)"/g)) {
      quotes.add(Number(m[1]));
    }
    for (const m of com.matchAll(/(?<!&gt;)&gt;&gt;(\d+)\b/g)) {
      quotes.add(Number(m[1]));
    }
    for (const m of com.matchAll(/(?<![>\w])>>(\d+)\b/g)) {
      quotes.add(Number(m[1]));
    }
    return Array.from(quotes);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 0. GET /4 -> redirect to default board catalogue
  // ───────────────────────────────────────────────────────────────────────────
  router.get(/^\/4\/?$/, lib.chanAuth, (req, res) => res.redirect('/4/wsg/catalogue'));

  // ───────────────────────────────────────────────────────────────────────────
  // 1. GET /4/:board/catalogue (and alias /4/:board/catalog)
  // ───────────────────────────────────────────────────────────────────────────
  router.get(/^\/4\/(?<board>[a-z0-9]+)\/(?:catalogue|catalog)\/?$/, lib.chanAuth, async (req, res) => {
    const board = req.params.board.toLowerCase();

    try {
      const pages = await fetchWithProxy(`https://a.4cdn.org/${board}/catalog.json`);
      const threads = [];
      for (const page of pages) {
        for (const t of (page.threads || [])) {
          threads.push({
            no: t.no,
            sub: t.sub || '',
            com: t.com ? t.com.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').slice(0, 180) : '',
            replies: t.replies || 0,
            images: t.images || 0,
            tim: t.tim,
            ext: t.ext,
            sticky: !!t.sticky,
            closed: !!t.closed,
            time: t.time,
            thumb: t.tim ? `/api/v2/scroller/external/4chan/${board}/media/${t.tim}s.jpg` : null
          });
        }
      }

      const opUrls = [];
      threads.forEach(t => {
        if (t.tim && t.ext) {
          const ext = (t.ext || '').toLowerCase();
          opUrls.push(`https://i.4cdn.org/${board}/${t.tim}${t.ext}`);
          opUrls.push(`https://i.4cdn.org/${board}/${t.tim}${ext}`);
          opUrls.push(`http://i.4cdn.org/${board}/${t.tim}${t.ext}`);
          opUrls.push(`http://i.4cdn.org/${board}/${t.tim}${ext}`);
          opUrls.push(`/api/v2/scroller/external/4chan/${board}/media/${t.tim}${ext}`);
        }
      });
      const rehosts = {};
      const rehostPaths = {};
      if (opUrls.length > 0) {
        try {
          const rows = await db`SELECT id, src, slug FROM items WHERE src = ANY(${opUrls})`;
          rows.forEach(r => {
            rehostPaths[r.id] = itemPath(r.id, r.slug);
            rehosts[r.src] = r.id;
            const m = r.src.match(/(\d{13,20})/);
            if (m) rehosts[m[1]] = r.id;
          });
        } catch (_) {}
      }
      threads.forEach(t => {
        t.local_id = (t.tim && rehosts[t.tim]) || (t.tim && t.ext && rehosts[`https://i.4cdn.org/${board}/${t.tim}${t.ext}`]) || null;
        t.local_path = t.local_id ? rehostPaths[t.local_id] : null;
      });

      const data = {
        board,
        threads,
        common_boards: COMMON_BOARDS,
        session: req.session ? { ...req.session } : false,
        domain: cfg.main.url.domain,
        tmp: null,
        page_meta: {
          title: `/${board}/ - Catalogue`,
          description: `4chan /${board}/ thread catalogue`,
          url: `https://${cfg.main.url.domain}/4/${board}/catalogue`
        }
      };

      return res.reply({
        body: tpl.render('chan/catalogue', data, req)
      });
    } catch (err) {
      console.error(`[CHAN] Failed to fetch catalogue for /${board}/:`, err.message);
      return res.reply({
        code: 500,
        body: tpl.render('error', {
          message: `Could not load catalogue for /${board}/. The board may not exist or 4chan is currently unreachable.`,
          domain: cfg.main.url.domain,
          tmp: null,
          session: req.session ? { ...req.session } : false
        }, req)
      });
    }
  });

  function formatPosts(posts, board, rehostMap, userFavSet, targetPostNo = null, lang = 'en') {
    // Build reply mapping (targetPostNo -> array of replier post numbers)
    const postNoSet = new Set(posts.map(p => p.no));
    const replyMap = new Map();

    for (const p of posts) {
      if (!p.com) continue;
      const quotes = extractQuotes(p.com);
      for (const qNo of quotes) {
        if (postNoSet.has(qNo) && qNo !== p.no) {
          if (!replyMap.has(qNo)) replyMap.set(qNo, []);
          replyMap.get(qNo).push(p.no);
        }
      }
    }

    return posts.map(p => {
      const ext = (p.ext || '').toLowerCase();
      const isVideo = ['.webm', '.mp4'].includes(ext);
      const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
      const externalMediaUrl = p.tim ? `https://i.4cdn.org/${board}/${p.tim}${ext}` : null;
      const rehostInfo = (p.tim && rehostMap[p.tim]) || (externalMediaUrl && rehostMap[externalMediaUrl]) || null;
      const localId = rehostInfo ? rehostInfo.id : null;
      const effectiveTime = (localId && rehostInfo?.stamp) ? Number(rehostInfo.stamp) : p.time;
      const isoStr = new Date(effectiveTime * 1000).toISOString();
      const postReplies = replyMap.get(p.no) || [];

      return {
        no: p.no,
        sub: p.sub || '',
        com_raw: p.com || '',
        com_formatted: formatComment(p.com || ''),
        name: p.name || 'Anonymous',
        trip: p.trip || '',
        time: effectiveTime,
        timeago: lib.timeAgo(effectiveTime * 1000, lang),
        date_str: (localId && rehostInfo?.stamp) ? new Date(effectiveTime * 1000).toLocaleString() : (p.now || new Date(effectiveTime * 1000).toLocaleString()),
        iso_str: isoStr,
        has_media: !!(p.tim && p.ext),
        tim: p.tim,
        ext: ext,
        filename: p.filename ? `${p.filename}${ext}` : null,
        w: p.w,
        h: p.h,
        fsize: p.fsize ? lib.formatSize(p.fsize) : null,
        dest: p.tim ? `/api/v2/scroller/external/4chan/${board}/media/${p.tim}${ext}` : null,
        thumb: p.tim ? `/api/v2/scroller/external/4chan/${board}/media/${p.tim}s.jpg` : null,
        external_media_url: externalMediaUrl,
        is_video: isVideo,
        is_image: isImage,
        local_id: localId,
        local_path: rehostInfo ? rehostInfo.path : null,
        rehosted: !!localId,
        user_has_favorited: localId ? userFavSet.has(Number(localId)) : false,
        is_onara_active: targetPostNo ? p.no === targetPostNo : false,
        replies: postReplies,
        replies_count: postReplies.length
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. GET /4/:board/:thread — Overview of all posts in that thread
  // ───────────────────────────────────────────────────────────────────────────
  router.get(/^\/4\/(?<board>[a-z0-9]+)\/(?<thread>\d+)\/?$/, lib.chanAuth, async (req, res) => {
    const board = req.params.board.toLowerCase();
    const tid = Number(req.params.thread);

    try {
      const data = await fetchWithProxy(`https://a.4cdn.org/${board}/thread/${tid}.json`);
      const posts = data.posts || [];
      if (!posts.length) throw new Error('Empty thread data');

      const op = posts[0];
      const mediaPosts = posts.filter(p => p.tim && p.ext);

      // Check which media URLs are already rehosted on this platform
      const rehosts = {};
      const cdnUrls = [];
      mediaPosts.forEach(p => {
        const ext = (p.ext || '').toLowerCase();
        cdnUrls.push(`https://i.4cdn.org/${board}/${p.tim}${p.ext}`);
        cdnUrls.push(`https://i.4cdn.org/${board}/${p.tim}${ext}`);
        cdnUrls.push(`http://i.4cdn.org/${board}/${p.tim}${p.ext}`);
        cdnUrls.push(`http://i.4cdn.org/${board}/${p.tim}${ext}`);
        cdnUrls.push(`/api/v2/scroller/external/4chan/${board}/media/${p.tim}${ext}`);
      });
      const rehostMap = {};
      const rehostPaths = {};
      if (cdnUrls.length > 0) {
        try {
          const rows = await db`SELECT id, src, stamp, slug FROM items WHERE src = ANY(${cdnUrls})`;
          rows.forEach(r => {
            const info = { id: r.id, stamp: r.stamp, path: itemPath(r.id, r.slug) };
            rehostPaths[r.id] = info.path;
            rehosts[r.src] = r.id;
            rehostMap[r.src] = info;
            const m = r.src.match(/(\d{13,20})/);
            if (m) {
              rehosts[m[1]] = r.id;
              rehostMap[m[1]] = info;
            }
          });
        } catch (e) {
          console.error('[CHAN] Rehost check error:', e.message);
        }
      }

      // Find which rehosted items the current user has favorited
      const userFavSet = new Set();
      const rehostedIdList = Object.values(rehosts).map(Number).filter(Boolean);
      if (req.session?.id && rehostedIdList.length > 0) {
        try {
          const userFavs = await db`SELECT item_id FROM favorites WHERE user_id = ${req.session.id} AND item_id = ANY(${rehostedIdList})`;
          userFavs.forEach(f => userFavSet.add(Number(f.item_id)));
        } catch (_) {}
      }

      // Format posts for template
      const formattedPosts = formatPosts(posts, board, rehostMap, userFavSet, null, req.lang || 'en');

      const firstMediaPost = formattedPosts.find(p => p.has_media);

      const viewData = {
        board,
        tid,
        op,
        posts: formattedPosts,
        media_count: mediaPosts.length,
        first_media_no: firstMediaPost ? firstMediaPost.no : null,
        rehosts_count: Object.keys(rehosts).length,
        session: req.session ? { ...req.session } : false,
        csrf_token: req.session?.csrf_token || '',
        domain: cfg.main.url.domain,
        tmp: null,
        page_meta: {
          title: `/${board}/${tid} - ${op.sub || 'Thread Overview'}`,
          description: op.sub || (op.com ? op.com.replace(/<[^>]+>/g, '').slice(0, 160) : `4chan /${board}/ thread ${tid}`),
          url: `https://${cfg.main.url.domain}/4/${board}/${tid}`
        }
      };

      return res.reply({
        body: tpl.render('chan/thread', viewData, req)
      });
    } catch (err) {
      console.error(`[CHAN] Failed to load thread /${board}/${tid}:`, err.message);
      return res.reply({
        code: 404,
        body: tpl.render('error', {
          message: `Could not load thread /${board}/${tid}. It may be archived or 4chan is currently unreachable.`,
          domain: cfg.main.url.domain,
          tmp: null,
          session: req.session ? { ...req.session } : false
        }, req)
      });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. GET /4/:board/:thread/:post — Show media item in normal item view
  // ───────────────────────────────────────────────────────────────────────────
  router.get(/^\/4\/(?<board>[a-z0-9]+)\/(?<thread>\d+)\/(?<post>\d+)\/?$/, lib.chanAuth, async (req, res) => {
    const board = req.params.board.toLowerCase();
    const tid = Number(req.params.thread);
    const postNo = Number(req.params.post);

    try {
      const threadData = await fetchWithProxy(`https://a.4cdn.org/${board}/thread/${tid}.json`);
      const posts = threadData.posts || [];
      if (!posts.length) throw new Error('Empty thread data');

      const op = posts[0];
      const mediaPosts = posts.filter(p => p.tim && p.ext);
      if (!mediaPosts.length) {
        // No media at all in thread, redirect to thread overview
        return res.redirect(`/4/${board}/${tid}`);
      }

      // Find target post
      let targetPost = mediaPosts.find(p => p.no === postNo);
      if (!targetPost) {
        // Post has no media or doesn't exist; pick closest or first media post
        targetPost = mediaPosts[0];
      }

      // Check rehost status in DB
      const cdnUrls = [];
      mediaPosts.forEach(p => {
        const ext = (p.ext || '').toLowerCase();
        cdnUrls.push(`https://i.4cdn.org/${board}/${p.tim}${p.ext}`);
        cdnUrls.push(`https://i.4cdn.org/${board}/${p.tim}${ext}`);
        cdnUrls.push(`http://i.4cdn.org/${board}/${p.tim}${p.ext}`);
        cdnUrls.push(`http://i.4cdn.org/${board}/${p.tim}${ext}`);
        cdnUrls.push(`/api/v2/scroller/external/4chan/${board}/media/${p.tim}${ext}`);
      });
      const rehosts = {};
      const rehostMap = {};
      const rehostPaths = {};
      if (cdnUrls.length > 0) {
        try {
          const rows = await db`SELECT id, src, stamp, slug FROM items WHERE src = ANY(${cdnUrls})`;
          rows.forEach(r => {
            const info = { id: r.id, stamp: r.stamp, path: itemPath(r.id, r.slug) };
            rehostPaths[r.id] = info.path;
            rehosts[r.src] = r.id;
            rehostMap[r.src] = info;
            const m = r.src.match(/(\d{13,20})/);
            if (m) {
              rehosts[m[1]] = r.id;
              rehostMap[m[1]] = info;
            }
          });
        } catch (e) {
          console.error('[CHAN] Rehost check error:', e.message);
        }
      }

      const mediaIndex = mediaPosts.findIndex(p => p.no === targetPost.no);
      const prevMedia = mediaIndex > 0 ? mediaPosts[mediaIndex - 1] : null;
      const nextMedia = mediaIndex < mediaPosts.length - 1 ? mediaPosts[mediaIndex + 1] : null;

      const ext = (targetPost.ext || '').toLowerCase();
      const isVideo = ['.webm', '.mp4'].includes(ext);
      const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
      const externalMediaUrl = targetPost.tim ? `https://i.4cdn.org/${board}/${targetPost.tim}${ext}` : null;
      const localId = (targetPost.tim && rehosts[targetPost.tim]) || (externalMediaUrl && rehosts[externalMediaUrl]) || null;

      let itemRating = null;
      let itemTags = [];
      let canManage = false;
      let localDest = null;
      let localThumb = null;
      let localTitle = null;
      let localStamp = null;
      let itemFavorites = [];
      let userHasFavorited = false;
      if (localId) {
        try {
          const localItem = await db`SELECT id, username, dest, title, mime, width, height, stamp FROM items WHERE id = ${localId} LIMIT 1`;
          if (localItem.length > 0) {
            const li = localItem[0];
            localStamp = li.stamp;
            if (li.title) localTitle = li.title;
            if (li.dest) {
              localDest = `/b/${li.dest}`;
              localThumb = `/t/${li.id}.webp`;
            }
            if (req.session) {
              canManage = !!((li.username && getSessionOwnerName(req.session) && li.username.toLowerCase() === getSessionOwnerName(req.session).toLowerCase()) ||
                             req.session.admin || req.session.is_moderator);
            }
          }
          itemTags = await lib.getTags(localId, req.session);
          const ratingTag = itemTags.find(t => ['sfw', 'nsfw', 'nsfl'].includes(t.normalized));
          if (ratingTag) itemRating = ratingTag.normalized;
          itemFavorites = await db`
            select "favorites".user_id, "user".user, "user".login, "user_options".avatar, "user_options".avatar_file, "user_options".display_name, "user_options".username_color, "user_options".hide_fav_badge, "anon_identities".fingerprint as anon_fingerprint
            from "favorites"
            left join "user" on "user".id = "favorites".user_id
            left join "user_options" on "user_options".user_id = "favorites".user_id
            left join "anon_identities" on "anon_identities".user_id = "favorites".user_id
            where "favorites".item_id = ${localId}
          `;
          userHasFavorited = lib.userHasFavorited(req.session, itemFavorites);
        } catch (e) {
          console.error('[CHAN] Failed to fetch tags for rehosted item:', e.message);
        }
      }

      // Construct item matching f0ckm's standard item view expectations
      const effectiveStamp = (localId && localStamp) ? Number(localStamp) : targetPost.time;
      const item = {
        id: targetPost.no,
        slug: null,
        title: localTitle || targetPost.sub || op.sub || `/${board}/${tid} #${targetPost.no}`,
        dest: localDest || `/api/v2/scroller/external/4chan/${board}/media/${targetPost.tim}${ext}`,
        thumbnail: localThumb || `/api/v2/scroller/external/4chan/${board}/media/${targetPost.tim}s.jpg`,
        mime: isVideo ? (ext === '.mp4' ? 'video/mp4' : 'video/webm') : (ext === '.gif' ? 'image/gif' : (ext === '.png' ? 'image/png' : 'image/jpeg')),
        width: targetPost.w || null,
        height: targetPost.h || null,
        size: targetPost.fsize ? lib.formatSize(targetPost.fsize) : '0 B',
        username: targetPost.name || 'Anonymous',
        stamp: effectiveStamp,
        timestamp: {
          timeago: lib.timeAgo(effectiveStamp * 1000, req.lang || 'en'),
          timefull: new Date(effectiveStamp * 1000).toISOString()
        },
        comment: targetPost.com ? targetPost.com.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') : '',
        is_chan: true,
        external_board: board,
        external_tid: tid,
        external_id: targetPost.no,
        external_thread_url: `https://boards.4chan.org/${board}/thread/${tid}#p${targetPost.no}`,
        external_media_url: externalMediaUrl,
        original_filename: targetPost.filename ? `${targetPost.filename}${ext}` : null,
        local_id: localId,
        local_path: localId ? (rehostPaths[localId] || localId) : null,
        rehosted: !!localId,
        is_sfw: itemRating === 'sfw',
        is_nsfw: itemRating === 'nsfw',
        is_nsfl: itemRating === 'nsfl',
        is_untagged: !itemRating,
        favorites: itemFavorites,
        user_has_favorited: userHasFavorited,
        halls: [],
        user_halls: [],
        tags: itemTags
      };

      // F0ckm convention: Next post (right arrow / D) corresponds to pagination.prev,
      // Previous post (left arrow / A) corresponds to pagination.next.
      const pagination = {
        prev: nextMedia ? nextMedia.no : null,
        next: prevMedia ? prevMedia.no : null
      };

      const link = {
        main: `/4/${board}/${tid}/`,
        mainDisplay: `/4/${board}/${tid}/`,
        suffix: ''
      };

      // Find which rehosted items the current user has favorited
      const userFavSet = new Set();
      const rehostedIdList = Object.values(rehosts).map(Number).filter(Boolean);
      if (req.session?.id && rehostedIdList.length > 0) {
        try {
          const userFavs = await db`SELECT item_id FROM favorites WHERE user_id = ${req.session.id} AND item_id = ANY(${rehostedIdList})`;
          userFavs.forEach(f => userFavSet.add(Number(f.item_id)));
        } catch (_) {}
      }

      const chanMediaList = mediaPosts.map((p, idx) => {
        const pExt = (p.ext || '').toLowerCase();
        const pVid = ['.webm', '.mp4'].includes(pExt);
        const pUrl = `https://i.4cdn.org/${board}/${p.tim}${pExt}`;
        const pLocalId = (p.tim && rehosts[p.tim]) || (pUrl && rehosts[pUrl]) || null;
        return {
          no: p.no,
          tim: p.tim,
          ext: pExt,
          dest: `/api/v2/scroller/external/4chan/${board}/media/${p.tim}${pExt}`,
          thumb: `/api/v2/scroller/external/4chan/${board}/media/${p.tim}s.jpg`,
          is_video: pVid,
          is_image: !pVid,
          is_active: p.no === targetPost.no,
          index: idx + 1,
          local_id: pLocalId,
          local_path: pLocalId ? (rehostPaths[pLocalId] || pLocalId) : null,
          rehosted: !!pLocalId,
          user_has_favorited: pLocalId ? userFavSet.has(Number(pLocalId)) : false,
          width: p.w || null,
          height: p.h || null
        };
      });

      const chanThreadMeta = {
        board,
        tid,
        subject: op.sub || `Thread #${tid}`,
        active_post: targetPost.no,
        active_index: mediaIndex + 1,
        media_count: mediaPosts.length,
        media_posts: chanMediaList
      };

      const data = {
        item,
        pagination,
        link,
        chan_thread: chanThreadMeta,
        session: req.session ? { ...req.session } : false,
        csrf_token: req.session?.csrf_token || '',
        domain: cfg.main.url.domain,
        tmp: null,
        hidePagination: true,
        enable_item_title: true,
        enable_item_slugs: false,
        user_alternative_steuerung: req.session?.user_alternative_steuerung,
        user_alternative_infobox: req.session?.user_alternative_infobox,
        can_manage_item: canManage,
        can_rate_item: canManage,
        can_extract_meta: !!(canManage && localId && item.mime && item.mime.indexOf('flash') === -1 && !(item.mime.startsWith('application/') && cfg.mimes[item.mime] && !['swf', 'pdf'].includes(cfg.mimes[item.mime]))),
        user_has_favorited: userHasFavorited,
        isSubscribed: false,
        item_username_lower: (item.username || '').toLowerCase(),
        item_rating_class: item.is_nsfl ? 'is-nsfl' : (item.is_nsfw ? 'is-nsfw' : (item.is_sfw ? 'is-sfw' : 'is-untagged')),
        item_rating_label: item.is_nsfl ? 'NSFL' : (item.is_nsfw ? 'NSFW' : (item.is_sfw ? 'SFW' : '?')),
        is_flash_item: false,
        is_archive_item: false,
        item_has_dimensions: !!(item.width && item.height),
        is_mod_or_admin: !!(req.session && (req.session.admin || req.session.is_moderator)),
        halls_enabled: false,
        default_layout: cfg.websrv?.default_layout || 'legacy',
        page_meta: {
          title: `/${board}/${tid}/${targetPost.no} - ${item.title}`,
          description: item.comment || `4chan media post #${targetPost.no} in /${board}/${tid}`,
          url: `https://${cfg.main.url.domain}/4/${board}/${tid}/${targetPost.no}`
        }
      };

      // Handle AJAX requests from loadItemAjax
      const isAjax = req.headers['x-requested-with'] === 'XMLHttpRequest' ||
                     req.url.qs?.ajax === '1' ||
                     (req.headers.accept && req.headers.accept.includes('application/json'));

      if (isAjax) {
        const isModern = req.session?.use_new_layout;
        const partialTpl = isModern ? 'item-partial-modern' : 'item-partial-legacy';
        const html = tpl.render(partialTpl, data, req);
        return res.reply({
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            html,
            item,
            pagination,
            chan_thread: chanThreadMeta
          })
        });
      }

      // Full page render: if Onara is active, render thread page with onara modal open
      const isOnara = isOnaraEnabledFor(req);

      if (isOnara) {
        const isModern = req.session?.use_new_layout;
        const partialTpl = isModern ? 'item-partial-modern' : 'item-partial-legacy';
        const itemHtml = tpl.render(partialTpl, data, req);

        const formattedPosts = formatPosts(posts, board, rehostMap, userFavSet, targetPost.no, req.lang || 'en');
        const firstMediaPost = formattedPosts.find(p => p.has_media);

        const threadViewData = {
          board,
          tid,
          op,
          posts: formattedPosts,
          media_count: mediaPosts.length,
          first_media_no: firstMediaPost ? firstMediaPost.no : null,
          rehosts_count: Object.keys(rehosts).length,
          session: req.session ? { ...req.session } : false,
          csrf_token: req.session?.csrf_token || '',
          domain: cfg.main.url.domain,
          tmp: null,
          page_meta: data.page_meta,
          is_onara_item: true,
          onara: true,
          onara_item_html: itemHtml,
          item: data.item
        };

        return res.reply({
          body: tpl.render('chan/thread', threadViewData, req)
        });
      }

      // Standard full page render (when Onara is disabled)
      return res.reply({
        body: tpl.render('item', data, req)
      });
    } catch (err) {
      console.error(`[CHAN] Failed to load item /4/${board}/${tid}/${postNo}:`, err.message);
      const isAjax = req.headers['x-requested-with'] === 'XMLHttpRequest' ||
                     req.url.qs?.ajax === '1' ||
                     (req.headers.accept && req.headers.accept.includes('application/json'));
      if (isAjax) {
        return res.reply({
          code: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            message: `Could not load media post #${postNo} in /${board}/${tid}: ${err.message}`
          })
        });
      }
      return res.reply({
        code: 404,
        body: tpl.render('error', {
          message: `Could not load media post #${postNo} in /${board}/${tid}.`,
          domain: cfg.main.url.domain,
          tmp: null,
          session: req.session ? { ...req.session } : false
        }, req)
      });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. GET /api/v2/chan/:board/:thread/media — Media list for thread (sidebar)
  // ───────────────────────────────────────────────────────────────────────────
  router.get(/^\/api\/v2\/chan\/(?<board>[a-z0-9]+)\/(?<thread>\d+)\/media\/?$/, lib.chanAuth, async (req, res) => {
    const board = req.params.board.toLowerCase();
    const tid = Number(req.params.thread);

    try {
      const threadData = await fetchWithProxy(`https://a.4cdn.org/${board}/thread/${tid}.json`);
      const posts = threadData.posts || [];
      const op = posts[0] || {};
      const mediaPosts = posts.filter(p => p.tim && p.ext);

      const cdnUrls = [];
      mediaPosts.forEach(p => {
        const ext = (p.ext || '').toLowerCase();
        cdnUrls.push(`https://i.4cdn.org/${board}/${p.tim}${p.ext}`);
        cdnUrls.push(`https://i.4cdn.org/${board}/${p.tim}${ext}`);
        cdnUrls.push(`http://i.4cdn.org/${board}/${p.tim}${p.ext}`);
        cdnUrls.push(`http://i.4cdn.org/${board}/${p.tim}${ext}`);
        cdnUrls.push(`/api/v2/scroller/external/4chan/${board}/media/${p.tim}${ext}`);
      });
      const rehosts = {};
      const rehostPaths = {};
      if (cdnUrls.length > 0) {
        try {
          const rows = await db`SELECT id, src, slug FROM items WHERE src = ANY(${cdnUrls})`;
          rows.forEach(r => {
            rehostPaths[r.id] = itemPath(r.id, r.slug);
            rehosts[r.src] = r.id;
            const m = r.src.match(/(\d{13,20})/);
            if (m) rehosts[m[1]] = r.id;
          });
        } catch (_) {}
      }

      const media = mediaPosts.map((p, idx) => {
        const ext = (p.ext || '').toLowerCase();
        const isVideo = ['.webm', '.mp4'].includes(ext);
        const externalMediaUrl = `https://i.4cdn.org/${board}/${p.tim}${ext}`;
        return {
          no: p.no,
          tim: p.tim,
          ext,
          filename: p.filename ? `${p.filename}${ext}` : null,
          w: p.w,
          h: p.h,
          dest: `/api/v2/scroller/external/4chan/${board}/media/${p.tim}${ext}`,
          thumb: `/api/v2/scroller/external/4chan/${board}/media/${p.tim}s.jpg`,
          is_video: isVideo,
          is_image: !isVideo,
          index: idx + 1,
          local_id: (p.tim && rehosts[p.tim]) || (externalMediaUrl && rehosts[externalMediaUrl]) || null,
          local_path: rehostPaths[(p.tim && rehosts[p.tim]) || (externalMediaUrl && rehosts[externalMediaUrl])] || null,
          rehosted: !!((p.tim && rehosts[p.tim]) || (externalMediaUrl && rehosts[externalMediaUrl]))
        };
      });

      return res.reply({
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' },
        body: JSON.stringify({
          success: true,
          board,
          tid,
          subject: op.sub || `Thread #${tid}`,
          total: media.length,
          items: media,
          media
        })
      });
    } catch (err) {
      console.error(`[CHAN] Media API error for /${board}/${tid}:`, err.message);
      return res.reply({
        code: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, msg: 'Failed to fetch thread media' })
      });
    }
  });

  return router;
};
