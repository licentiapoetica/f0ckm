import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";
import queue from "../queue.mjs";
import { chanCurl } from "../chan_http.mjs";
import { promises as fs } from "fs";
import path from "path";
import { getManualApproval, getBypassDuplicateCheck, canUseChan, getSessionOwnerName, getEnableItemSlugs } from "../settings.mjs";

// Link path for a local item: its slug when slugs are enabled, else the numeric id
const itemPath = async (id, slug) => {
  if (!getEnableItemSlugs()) return id;
  if (slug === undefined) slug = (await db`SELECT slug FROM items WHERE id = ${id} LIMIT 1`)[0]?.slug;
  return slug || id;
};
import { applyWordFilter } from "../wordfilter.mjs";

/**
 * external.mjs — External source handlers (4chan threads, etc.)
 */
export default (router) => {

  // --- F-001 Security: Per-user rate limiter for proxy routes ---
  const proxyRateMap = new Map();
  const PROXY_RATE_LIMIT = 5000;   // max requests per window
  const PROXY_RATE_WINDOW = 600000; // 10 minute window
  const proxyRateLimit = (req, res) => {
    if (!req.session) return true; // loggedin middleware handles auth; this is just a guard
    const key = req.session.id;
    const now = Date.now();
    let entry = proxyRateMap.get(key);
    if (!entry || now - entry.start > PROXY_RATE_WINDOW) {
      entry = { start: now, count: 0 };
      proxyRateMap.set(key, entry);
    }
    entry.count++;
    if (entry.count > PROXY_RATE_LIMIT) {
      res.reply({ code: 429, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, msg: 'Rate limit exceeded' }) });
      return false;
    }
    return true;
  };
  // Periodic cleanup to prevent memory leak
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of proxyRateMap) {
      if (now - v.start > PROXY_RATE_WINDOW * 2) proxyRateMap.delete(k);
    }
  }, PROXY_RATE_WINDOW * 2);

  /**
   * Helper to fetch data (JSON or Buffer) using curl if a proxy is configured.
   * This ensures we respect the SOCKS5 proxy for all external 4chan requests.
   */
  async function fetchWithProxy(url, asBuffer = false) {
    const { bin, args } = chanCurl(url, ['--max-time', '30']);
    const { stdout } = await queue.spawn(bin, args, { encoding: asBuffer ? 'buffer' : 'utf8' });
    if (asBuffer) return stdout;
    const text = typeof stdout === 'string' ? stdout.trim() : stdout.toString().trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      console.error('[EXTERNAL] Non-JSON response from', url, '— first 200 chars:', text.slice(0, 200));
      throw new Error('Expected JSON but got non-JSON response');
    }
    return JSON.parse(text);
  }

  // GET /api/v2/scroller/external/4chan/:board/:tid
  // Proxies 4chan thread JSON
  router.get(/^\/api\/v2\/scroller\/external\/4chan\/(?<board>[a-z0-9]+)\/(?<tid>\d+)\/?$/, lib.chanAuth, async (req, res) => {
    if (!proxyRateLimit(req, res)) return;
    const { board, tid } = req.params || {};

    if (!board || !tid) {
      console.error('[EXTERNAL] Missing board or tid:', req.params);
      return res.reply({ code: 400, body: JSON.stringify({ success: false, error: 'invalid_parameters' }) });
    }

    try {
      const url = `https://a.4cdn.org/${board}/thread/${tid}.json`;
      console.log(`[EXTERNAL] Fetching 4chan thread: ${url}`);
      
      const data = await fetchWithProxy(url);
      const posts = data.posts || [];

      // Check which media URLs are already rehosted on this platform
      const rehosts = {};
      const rehostPaths = {};
      const mediaPosts = posts.filter(p => p.tim && p.ext);
      const cdn4Urls = [];
      mediaPosts.forEach(p => {
        const ext = (p.ext || '').toLowerCase();
        cdn4Urls.push(`https://i.4cdn.org/${board}/${p.tim}${p.ext}`);
        cdn4Urls.push(`https://i.4cdn.org/${board}/${p.tim}${ext}`);
        cdn4Urls.push(`http://i.4cdn.org/${board}/${p.tim}${p.ext}`);
        cdn4Urls.push(`http://i.4cdn.org/${board}/${p.tim}${ext}`);
        cdn4Urls.push(`/api/v2/scroller/external/4chan/${board}/media/${p.tim}${ext}`);
      });
      if (cdn4Urls.length > 0) {
        try {
          const rows = await db`SELECT id, src, slug FROM items WHERE src = ANY(${cdn4Urls})`;
          for (const r of rows) rehostPaths[r.id] = await itemPath(r.id, r.slug);
          rows.forEach(r => {
            rehosts[r.src] = r.id;
            const m = r.src.match(/(\d{13,20})/);
            if (m) rehosts[m[1]] = r.id;
          });
        } catch (e) {
          console.error('[EXTERNAL] DB src check error:', e.message);
        }
      }

      return res.reply({
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({ success: true, posts, board, tid, rehosts, rehost_paths: rehostPaths })
      });

    } catch (err) {
      console.error('[EXTERNAL] 4chan fetch error:', err.message);
      return res.reply({
        code: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, msg: 'fetch_failed' })
      });
    }
  });

  // POST /api/v2/scroller/external/rehost-meta
  // Given item IDs, return their metadata (username, avatar, timestamp)
  router.post(/^\/api\/v2\/scroller\/external\/rehost-meta\/?$/, lib.loggedin, async (req, res) => {
    const ids = (req.post?.ids || '').split(',').map(Number).filter(n => n > 0);
    if (!ids.length) return res.reply({ headers: { 'Content-Type': 'application/json' }, body: '{}' });

    try {
      const ratingTagIds = [1, 2, cfg.nsfl_tag_id || 3];
      const rows = await db`
        SELECT i.id, i.username, i.stamp,
          COALESCE(uo.display_name, i.username) as display_name,
          uo.avatar_file, uo.avatar,
          (SELECT ta.tag_id FROM tags_assign ta
           WHERE ta.item_id = i.id AND ta.tag_id = ANY(${ratingTagIds}::int[])
           ORDER BY ta.tag_id LIMIT 1) AS rating_tag_id,
          (SELECT COUNT(*) FROM comments WHERE comments.item_id = i.id AND comments.is_deleted = false) AS comment_count
        FROM items i
        LEFT JOIN "user" u ON u."user" = i.username
        LEFT JOIN user_options uo ON uo.user_id = u.id
        WHERE i.id = ANY(${ids}::int[])`;
      const meta = {};
      rows.forEach(r => {
        let rating_label = '?', rating_class = 'untagged';
        if (r.rating_tag_id == 1) { rating_label = 'SFW'; rating_class = 'sfw'; }
        else if (r.rating_tag_id == 2) { rating_label = 'NSFW'; rating_class = 'nsfw'; }
        else if (r.rating_tag_id == (cfg.nsfl_tag_id || 3)) { rating_label = 'NSFL'; rating_class = 'nsfl'; }
        meta[r.id] = {
          username: r.username,
          display_name: r.display_name,
          avatar: r.avatar_file ? `/a/${r.avatar_file}` : (r.avatar ? `/t/${r.avatar}.webp` : '/a/default.png'),
          stamp: r.stamp,
          rating_class,
          rating_label,
          comment_count: +r.comment_count || 0
        };
      });
      return res.reply({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta)
      });
    } catch (e) {
      console.error('[EXTERNAL] rehost-meta error:', e.message);
      return res.reply({ code: 500, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }
  });

  // GET /api/v2/scroller/external/4chan/:board/catalog
  // Proxies 4chan board catalog JSON
  router.get(/^\/api\/v2\/scroller\/external\/4chan\/(?<board>[a-z0-9]+)\/catalog\/?$/, lib.chanAuth, async (req, res) => {
    if (!proxyRateLimit(req, res)) return;
    const { board } = req.params || {};
    if (!board) return res.reply({ code: 400, body: JSON.stringify({ success: false }) });

    try {
      const pages = await fetchWithProxy(`https://a.4cdn.org/${board}/catalog.json`);
      const threads = [];
      for (const page of pages) {
        for (const t of (page.threads || [])) {
          threads.push({
            no: t.no,
            sub: t.sub || '',
            com: (t.com || '').replace(/<[^>]+>/g, '').slice(0, 120),
            replies: t.replies || 0,
            images: t.images || 0,
            tim: t.tim,
            ext: t.ext,
            sticky: t.sticky || 0
          });
        }
      }
      return res.reply({
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=120' },
        body: JSON.stringify({ success: true, board, threads })
      });
    } catch (err) {
      console.error('[EXTERNAL] Catalog fetch error:', err.message);
      return res.reply({
        code: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, msg: 'catalog_fetch_failed' })
      });
    }
  });

  // GET /api/v2/scroller/external/4chan/:board/find/:postno
  // Resolves a post number to its parent thread ID
  router.get(/^\/api\/v2\/scroller\/external\/4chan\/(?<board>[a-z0-9]+)\/find\/(?<postno>\d+)\/?$/, lib.chanAuth, async (req, res) => {
    if (!proxyRateLimit(req, res)) return;
    const { board, postno } = req.params || {};
    if (!board || !postno) return res.reply({ code: 400, body: JSON.stringify({ success: false }) });

    try {
      // 1) Try as thread OP — if postno IS the thread, this returns 200
      try {
        const thread = await fetchWithProxy(`https://a.4cdn.org/${board}/thread/${postno}.json`);
        if (thread && thread.posts) {
          return res.reply({
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
            body: JSON.stringify({ success: true, tid: Number(postno), board })
          });
        }
      } catch (_) { /* 404 — post is not an OP, continue searching */ }

      // 2) Search catalog's last_replies for the post
      const pages = await fetchWithProxy(`https://a.4cdn.org/${board}/catalog.json`);
      for (const page of pages) {
        for (const t of (page.threads || [])) {
          // Check OP
          if (t.no === Number(postno)) {
            return res.reply({
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
              body: JSON.stringify({ success: true, tid: t.no, board })
            });
          }
          // Check last_replies
          if (t.last_replies) {
            for (const r of t.last_replies) {
              if (r.no === Number(postno)) {
                return res.reply({
                  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
                  body: JSON.stringify({ success: true, tid: t.no, board })
                });
              }
            }
          }
        }
      }

      // Not found
      return res.reply({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, msg: 'post_not_found' })
      });
    } catch (err) {
      console.error('[EXTERNAL] Find post error:', err.message);
      return res.reply({
        code: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, msg: 'find_failed' })
      });
    }
  });

  // GET /api/v2/scroller/external/4chan/:board/media/:file
  // Proxies 4chan media — streams directly to client for fast playback start
  // F-001: Allowed file extensions for the media proxy (prevents abuse as generic proxy)
  const ALLOWED_MEDIA_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'webm', 'mp4'];

  router.get(/^\/api\/v2\/scroller\/external\/4chan\/(?<board>[a-z0-9]+)\/media\/(?<file>[^/]+)$/, lib.chanAuth, async (req, res) => {
    if (!proxyRateLimit(req, res)) return;
    const { board, file } = req.params || {};

    // Validate file extension against whitelist
    const ext = (file.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_MEDIA_EXTS.includes(ext)) {
      return res.reply({ code: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, msg: 'Disallowed file type' }) });
    }

    // Validate filename doesn't contain path traversal
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      return res.reply({ code: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, msg: 'Invalid filename' }) });
    }

    const url = `https://i.4cdn.org/${board}/${file}`;
    const mimes = { 
      'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 
      'gif': 'image/gif', 'webp': 'image/webp',
      'webm': 'video/webm', 'mp4': 'video/mp4'
    };
    const contentType = mimes[ext] || 'application/octet-stream';

    const { bin: curlBin, args: curlArgs } = chanCurl(url, ['--max-time', '60']);

    const { spawn } = await import('child_process');
    const curl = spawn(curlBin, curlArgs);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Transfer-Encoding': 'chunked'
    });

    curl.stdout.pipe(res);

    curl.stderr.on('data', () => {}); // suppress stderr
    curl.on('error', () => { try { res.end(); } catch(_) {} });
    curl.on('close', (code) => {
      if (code !== 0) try { res.end(); } catch(_) {}
    });

    // If the client disconnects, kill curl
    req.on('close', () => { try { curl.kill(); } catch(_) {} });
  });

  // POST /api/v2/scroller/rehost
  // Downloads an external item and adds it to the platform
  router.post(/^\/api\/v2\/scroller\/rehost\/?$/, lib.chanAuth, async (req, res) => {
    const { url, rating: initialRating, tags: tagsRaw, comment, is_oc, original_filename, width: postWidth, height: postHeight } = req.post || {};

    if (!url) return res.reply({ code: 400, body: JSON.stringify({ success: false, msg: 'URL is required' }) });

    // F-014 Security: Restrict rehost to 4chan media URLs only
    const is4chanUrl = /^https?:\/\/(i\.4cdn\.org|boards\.4cdn\.org)\//i.test(url)
                    || /\/api\/v2\/scroller\/external\/4chan\/[a-z0-9]+\/media\//i.test(url);
    if (!is4chanUrl) {
      return res.reply({ code: 400, body: JSON.stringify({ success: false, msg: 'Only 4chan media URLs are supported for rehosting' }) });
    }
    
    const board = url.match(/boards\.4cdn\.org\/([a-z0-9]+)\//)?.[1]
                || url.match(/i\.4cdn\.org\/([a-z0-9]+)\//)?.[1]
                || url.match(/\/4chan\/([a-z0-9]+)\/media\//)?.[1]
                || null;
    
    // Rating is optional: do not force sfw/nsfw based on board
    const validRatings = ['sfw', 'nsfw', 'nsfl'];
    const rating = (initialRating && validRatings.includes(String(initialRating).toLowerCase()))
      ? String(initialRating).toLowerCase()
      : null;

    const session = req.session;
    // Anon sessions carry user = 'anonymous'; credit the upload to the real shadow account
    const ownerName = getSessionOwnerName(session);

    try {
      const uuid = await queue.genuuid();
      const tmpPath = path.join(cfg.paths.tmp, `${uuid}.tmp`);
      
      // Download via curl (lightweight)
      const { bin: curlBin, args: curlArgs } = chanCurl(url, [
          '-o', tmpPath,
          '--max-filesize', `${cfg.main.maxfilesize || 100 * 1024 * 1024}`,
          '--connect-timeout', '30',
          '--max-time', '300'
      ]);

      await queue.spawn(curlBin, curlArgs);
        
        // Detect MIME
        const mime = (await queue.spawn('file', ['--mime-type', '-b', tmpPath])).stdout.trim();
        const ext = cfg.mimes[mime];
        if (!ext) {
          throw new Error(`Unsupported file type: ${mime}`);
        }

        const finalTmp = path.join(cfg.paths.tmp, `${uuid}.${ext}`);
        await fs.rename(tmpPath, finalTmp);

        const checksum = (await queue.spawn('sha256sum', [finalTmp])).stdout.trim().split(' ')[0];
        
        // Repost check
        if (!getBypassDuplicateCheck()) {
            const repost = await queue.checkrepostsum(checksum);
            if (repost) {
                await fs.unlink(finalTmp).catch(() => {});
                // Auto-subscribe user to the existing item they attempted to rehost
                if (cfg.enable_comments !== false) {
                  try {
                    await db`INSERT INTO comment_subscriptions (user_id, item_id) VALUES (${session.id}, ${repost}) ON CONFLICT (user_id, item_id) DO UPDATE SET is_subscribed = true`;
                  } catch (e) { console.error('[REHOST] Auto-subscribe (repost) error:', e); }
                }

                return res.reply({
                  code: 200,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ success: true, repost: true, item_id: repost, item_path: await itemPath(repost), msg: 'Already on site' })
                });
            }
        }

        const phash = await queue.generatePHash(finalTmp).catch(() => null);

        // PHash duplicate check
        if (phash && !getBypassDuplicateCheck()) {
            const phashMatch = await queue.checkrepostphash(phash);
            if (phashMatch) {
                await fs.unlink(finalTmp).catch(() => {});
                // Auto-subscribe user to the existing item they attempted to rehost (visual match)
                if (cfg.enable_comments !== false) {
                  try {
                    await db`INSERT INTO comment_subscriptions (user_id, item_id) VALUES (${session.id}, ${phashMatch}) ON CONFLICT (user_id, item_id) DO UPDATE SET is_subscribed = true`;
                  } catch (e) { console.error('[REHOST] Auto-subscribe (phash repost) error:', e); }
                }

                return res.reply({
                  code: 200,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ success: true, repost: true, item_id: phashMatch, item_path: await itemPath(phashMatch), msg: 'Already on site (visual match)' })
                });
            }
        }

        let itemWidth = Number(postWidth) || null;
        let itemHeight = Number(postHeight) || null;
        if (!itemWidth || !itemHeight) {
          try {
            if (mime.startsWith('image/')) {
              const { stdout: magickOut } = await queue.spawn('magick', [
                'identify', '-format', '%wx%h\n', finalTmp + '[0]'
              ], { quiet: true, ignoreExitCode: true });
              const m = magickOut.trim().split('\n')[0].match(/^(\d+)x(\d+)$/);
              if (m) { itemWidth = parseInt(m[1], 10); itemHeight = parseInt(m[2], 10); }
            } else if (mime.startsWith('video/')) {
              const { stdout: probeOut } = await queue.spawn('ffprobe', [
                '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', finalTmp
              ], { quiet: true, ignoreExitCode: true });
              const parts = probeOut.trim().split(',');
              if (parts.length >= 2) {
                const w = parseInt(parts[0], 10), h = parseInt(parts[1], 10);
                if (w > 0 && h > 0) { itemWidth = w; itemHeight = h; }
              }
            }
          } catch (e) {}
        }

        const filename = `${uuid}.${ext}`;
        const isApprovalRequired = getManualApproval();
        const destDir = isApprovalRequired ? path.join(cfg.paths.pending, 'b') : cfg.paths.b;

        await fs.copyFile(finalTmp, path.join(destDir, filename));
        await fs.unlink(finalTmp).catch(() => {});

        const insertChecksum = getBypassDuplicateCheck() ? `${checksum}_bypass_${Date.now()}` : checksum;

        const [{ id: itemid }] = await db`
            insert into items ${db({
                src: url,
                dest: filename,
                mime: mime,
                size: (await fs.stat(path.join(destDir, filename))).size,
                checksum: insertChecksum,
                phash: phash,
                username: ownerName,
                userchannel: 'web',
                usernetwork: 'web',
                stamp: ~~(Date.now() / 1000),
                active: !isApprovalRequired,
                is_oc: !!is_oc,
                original_filename: original_filename || null,
                width: itemWidth,
                height: itemHeight,
                slug: lib.generateSlug(11)
            }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active', 'is_oc', 'original_filename', 'width', 'height', 'slug')}
            RETURNING id
        `;

        // Automatically subscribe user to the new item
        if (cfg.enable_comments !== false) {
          try {
            await db`INSERT INTO comment_subscriptions (user_id, item_id) VALUES (${session.id}, ${itemid}) ON CONFLICT (user_id, item_id) DO UPDATE SET is_subscribed = true`;
          } catch (e) { console.error('[REHOST] Auto-subscribe (new item) error:', e); }
        }

        // Process thumbnail
        try {
            await queue.genThumbnail(filename, mime, itemid, url, isApprovalRequired);
            await queue.genBlurredThumbnail(itemid, isApprovalRequired);
        } catch (err) {
            console.error('[REHOST] Thumbnail error:', err);
        }

        // Tags: Only assign rating tag if explicitly specified; do NOT auto-tag board or sfw/nsfw
        if (rating) {
          const ratingTagId = rating === 'sfw' ? 1 : (rating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3));
          await db`insert into tags_assign ${db({ item_id: itemid, tag_id: ratingTagId, user_id: session.id })} on conflict do nothing`;
        }
        
        const rawList = Array.isArray(tagsRaw) ? tagsRaw : (typeof tagsRaw === 'string' ? tagsRaw.split(',') : []);
        const tags = rawList.map(t => t.trim()).filter(t => t.length > 0 && !['sfw', 'nsfw', 'nsfl'].includes(t.toLowerCase()));
        for (const tagName of tags) {
            let tagRow = await db`select id from tags where normalized = slugify(${tagName}) limit 1`;
            if (tagRow.length === 0) {
                await db`insert into tags ${db({ tag: tagName }, 'tag')} on conflict do nothing`;
                tagRow = await db`select id from tags where normalized = slugify(${tagName}) limit 1`;
            }
            if (tagRow.length) {
              await db`insert into tags_assign ${db({ item_id: itemid, tag_id: tagRow[0].id, user_id: session.id })} on conflict do nothing`;
            }
        }

        // Insert optional first comment if provided
        if (comment && typeof comment === 'string' && comment.trim().length > 0) {
          try {
            const filteredComment = await applyWordFilter(comment.trim());
            await db`
              INSERT INTO comments ${db({
                item_id: itemid,
                user_id: session.id,
                content: filteredComment
              })}
            `;
          } catch (err) {
            console.error('[REHOST] Comment insert error:', err);
          }
        }

        await db`INSERT INTO notifications (user_id, type, reference_id, item_id) VALUES (${session.id}, 'upload_success', 0, ${itemid})`;

        // Broadcast new_item event for live grid updates (only if auto-approved)
        if (!isApprovalRequired) {
          try {
            await db`SELECT pg_notify('new_item', ${JSON.stringify({
              id: itemid,
              dest: filename,
              mime: mime,
              username: ownerName,
              display_name: session.display_name || null,
              tag_id: rating ? (rating === 'sfw' ? 1 : (rating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3))) : 0,
              is_oc: false,
              is_album: false,
              album_count: 0
            })})`;
          } catch (err) {
            console.error('[REHOST] new_item notify failed:', err);
          }
        }

        // Push to Matrix channel (only if auto-approved)
        if (!isApprovalRequired) {
          try {
            const self = router.self;
            const matrixCfg = cfg.clients?.find(c => c.type === 'matrix');
            if (matrixCfg?.notification_channel_id && self?.bot?.clients) {
              const clients = await Promise.all(self.bot.clients);
              const matrixWrapper = clients.find(c => c.type === 'matrix');
              if (matrixWrapper?.client) {
                const message = `${session.user} uploaded a new item ${cfg.main.url.full}/${itemid}`;
                await matrixWrapper.client.send(matrixCfg.notification_channel_id, message);
                console.log(`[REHOST] Matrix notification sent for item ${itemid}`);
              }
            }
          } catch (err) {
            console.error('[REHOST] Matrix notification error:', err);
          }
        }

        return res.reply({
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, item_id: itemid, item_path: await itemPath(itemid) })
        });

      } catch (err) {
        console.error('[REHOST] Error:', err);
        return res.reply({
          code: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, msg: 'Rehost failed' })
        });
      }
  });

  // GET /api/v2/scroller/rehost/details/:id
  // Retrieve current rating and tags for a rehosted item
  router.get(/^\/api\/v2\/scroller\/rehost\/details\/(?<id>\d+)\/?$/, lib.chanAuth, async (req, res) => {
    const itemId = Number(req.params.id);
    try {
      const tags = await lib.getTags(itemId, req.session);
      const ratingTag = tags.find(t => ['sfw', 'nsfw', 'nsfl'].includes(t.normalized));
      const rating = ratingTag ? ratingTag.normalized : 'untagged';
      const userTags = tags.filter(t => !['sfw', 'nsfw', 'nsfl'].includes(t.normalized)).map(t => t.tag);
      return res.reply({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, item_id: itemId, rating, tags: userTags })
      });
    } catch (err) {
      return res.reply({
        code: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, msg: err.message })
      });
    }
  });

  // POST /api/v2/scroller/rehost/details
  // Set rating, add tags, and or post a comment directly on a rehosted item
  router.post(/^\/api\/v2\/scroller\/rehost\/details\/?$/, lib.chanAuth, async (req, res) => {
    const session = req.session;
    if (!session || !session.user) {
      return res.reply({ code: 401, body: JSON.stringify({ success: false, msg: 'Unauthorized' }) });
    }

    const { item_id, rating, tags, comment } = req.post || req.body || {};
    const itemId = parseInt(item_id, 10);
    if (!itemId || isNaN(itemId)) {
      return res.reply({ code: 400, body: JSON.stringify({ success: false, msg: 'Valid item_id is required' }) });
    }

    try {
      const rows = await db`SELECT id, username FROM items WHERE id = ${itemId} AND active = true AND is_deleted = false LIMIT 1`;
      if (!rows.length) {
        return res.reply({ code: 404, body: JSON.stringify({ success: false, msg: 'Item not found' }) });
      }

      const ownerName = getSessionOwnerName(session);
      const isOwner = !!(rows[0].username && ownerName && rows[0].username.toLowerCase() === ownerName.toLowerCase());
      const isAdmin = !!(session.admin || session.is_moderator);
      const isChanUser = canUseChan(session);

      const hasTagsOrComment = (tags && Array.isArray(tags) ? tags.length > 0 : (typeof tags === 'string' && tags.trim().length > 0)) ||
                               (comment && typeof comment === 'string' && comment.trim().length > 0);

      if (hasTagsOrComment && !isOwner && !isAdmin) {
        return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: 'Only owner can edit tags and comment' }) });
      }

      if (!isOwner && !isAdmin && !isChanUser) {
        return res.reply({ code: 403, body: JSON.stringify({ success: false, msg: 'Unauthorized' }) });
      }

      const nsflTagRow = await db`SELECT id FROM tags WHERE normalized = 'nsfl' LIMIT 1`;
      const nsflId = nsflTagRow.length > 0 ? nsflTagRow[0].id : (cfg.nsfl_tag_id || 11517);

      // 1. Update Rating if provided
      if (rating !== undefined && rating !== null && rating !== '') {
        const r = String(rating).toLowerCase().trim();

        await db`
          DELETE FROM tags_assign 
          WHERE item_id = ${itemId} 
            AND (tag_id IN (1, 2, ${nsflId}) OR tag_id IN (SELECT id FROM tags WHERE normalized IN ('sfw', 'nsfw', 'nsfl')))
        `;

        if (r === 'sfw') {
          await db`INSERT INTO tags_assign ${db({ item_id: itemId, tag_id: 1, user_id: session.id })} ON CONFLICT DO NOTHING`;
        } else if (r === 'nsfw') {
          await db`INSERT INTO tags_assign ${db({ item_id: itemId, tag_id: 2, user_id: session.id })} ON CONFLICT DO NOTHING`;
        } else if (r === 'nsfl') {
          await db`INSERT INTO tags_assign ${db({ item_id: itemId, tag_id: nsflId, user_id: session.id })} ON CONFLICT DO NOTHING`;
        }
        // If r === 'untagged', no rating tag is inserted
      }

      // 2. Sync Tags if provided
      if (tags !== undefined && tags !== null) {
        const rawList = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(',') : []);
        const cleanTags = rawList.map(t => t.trim()).filter(t => t.length > 0 && !['sfw', 'nsfw', 'nsfl'].includes(t.toLowerCase()));

        // Delete existing non-rating tags for this item by this user (or all non-rating tags if owner)
        await db`
          DELETE FROM tags_assign
          WHERE item_id = ${itemId}
            AND tag_id NOT IN (1, 2, ${nsflId})
            AND tag_id NOT IN (SELECT id FROM tags WHERE normalized IN ('sfw', 'nsfw', 'nsfl'))
            ${isOwner ? db`` : db`AND user_id = ${session.id}`}
        `;

        for (const tagName of cleanTags) {
          let tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagName}) LIMIT 1`;
          if (tagRow.length === 0) {
            await db`INSERT INTO tags ${db({ tag: tagName }, 'tag')} ON CONFLICT DO NOTHING`;
            tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagName}) LIMIT 1`;
          }
          if (tagRow.length) {
            await db`INSERT INTO tags_assign ${db({ item_id: itemId, tag_id: tagRow[0].id, user_id: session.id })} ON CONFLICT DO NOTHING`;
          }
        }
      }

      // 3. Add Comment if provided
      if (comment && typeof comment === 'string' && comment.trim().length > 0) {
        const filteredComment = await applyWordFilter(comment.trim());
        await db`
          INSERT INTO comments ${db({
            item_id: itemId,
            user_id: session.id,
            content: filteredComment
          })}
        `;
      }

      const freshTags = await lib.getTags(itemId, session);
      await db.notify('tags', JSON.stringify({ item_id: itemId, fresh: true, tags: freshTags })).catch(() => {});

      const ratingTag = freshTags.find(t => ['sfw', 'nsfw', 'nsfl'].includes(t.normalized));
      const cleanTagObjects = freshTags.filter(t => !['sfw', 'nsfw', 'nsfl'].includes(t.normalized)).map(t => ({
        id: t.id,
        tag: t.tag,
        normalized: t.normalized,
        badge: t.badge
      }));

      return res.reply({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          item_id: itemId,
          item_path: await itemPath(itemId),
          rating: ratingTag ? ratingTag.normalized : 'untagged',
          tags: cleanTagObjects
        })
      });
    } catch (err) {
      console.error('[REHOST-DETAILS] Error:', err);
      return res.reply({
        code: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, msg: 'Failed to save details' })
      });
    }
  });

  return router;
};
