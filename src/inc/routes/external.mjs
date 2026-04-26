import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";
import queue from "../queue.mjs";
import { promises as fs } from "fs";
import path from "path";
import { getManualApproval, getBypassDuplicateCheck } from "../settings.mjs";

/**
 * external.mjs — External source handlers (4chan threads, etc.)
 */
export default (router) => {

  /**
   * Helper to fetch data (JSON or Buffer) using curl if a proxy is configured.
   * This ensures we respect the SOCKS5 proxy for all external 4chan requests.
   */
  async function fetchWithProxy(url, asBuffer = false) {
    const curlArgs = [
      '-s', '-f', '-L',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--max-time', '30',
      url
    ];
    if (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') {
        const proxyHost = cfg.main.socks.includes('://') ? cfg.main.socks.split('://')[1] : cfg.main.socks;
        curlArgs.push('--socks5-hostname', proxyHost);
    }
    
    const { stdout } = await queue.spawn('curl', curlArgs, { encoding: asBuffer ? 'buffer' : 'utf8' });
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
  router.get(/^\/api\/v2\/scroller\/external\/4chan\/(?<board>[a-z0-9]+)\/(?<tid>\d+)\/?$/, async (req, res) => {
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
      const mediaPosts = posts.filter(p => p.tim && p.ext);
      const cdn4Urls = mediaPosts.map(p => `https://i.4cdn.org/${board}/${p.tim}${p.ext}`);
      if (cdn4Urls.length > 0) {
        try {
          const rows = await db`SELECT id, src FROM items WHERE src IN (${cdn4Urls})`;
          rows.forEach(r => { rehosts[r.src] = r.id; });
        } catch (e) {
          console.error('[EXTERNAL] DB src check error:', e.message);
        }
      }

      return res.reply({
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({ success: true, posts, board, tid, rehosts })
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
  router.post(/^\/api\/v2\/scroller\/external\/rehost-meta\/?$/, async (req, res) => {
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
           ORDER BY ta.tag_id LIMIT 1) AS rating_tag_id
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
          rating_label
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
  router.get(/^\/api\/v2\/scroller\/external\/4chan\/(?<board>[a-z0-9]+)\/catalog\/?$/, async (req, res) => {
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
  router.get(/^\/api\/v2\/scroller\/external\/4chan\/(?<board>[a-z0-9]+)\/find\/(?<postno>\d+)\/?$/, async (req, res) => {
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
  router.get(/^\/api\/v2\/scroller\/external\/4chan\/(?<board>[a-z0-9]+)\/media\/(?<file>[^/]+)$/, async (req, res) => {
    const { board, file } = req.params || {};
    const url = `https://i.4cdn.org/${board}/${file}`;

    const ext = file.split('.').pop();
    const mimes = { 
      'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 
      'gif': 'image/gif', 'webp': 'image/webp',
      'webm': 'video/webm', 'mp4': 'video/mp4'
    };
    const contentType = mimes[ext] || 'application/octet-stream';

    const curlArgs = [
      '-s', '-f', '-L',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--max-time', '60',
      url
    ];
    if (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') {
      const proxyHost = cfg.main.socks.includes('://') ? cfg.main.socks.split('://')[1] : cfg.main.socks;
      curlArgs.push('--socks5-hostname', proxyHost);
    }

    const { spawn } = await import('child_process');
    const curl = spawn('curl', curlArgs);

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
  router.post(/^\/api\/v2\/scroller\/rehost\/?$/, lib.loggedin, async (req, res) => {
    const { url, rating: initialRating, tags: tagsRaw, comment, is_oc } = req.post || {};

    if (!url) return res.reply({ code: 400, body: JSON.stringify({ success: false, msg: 'URL is required' }) });
    
    const board = url.match(/boards\.4cdn\.org\/([a-z0-9]+)\//)?.[1]
                || url.match(/i\.4cdn\.org\/([a-z0-9]+)\//)?.[1]
                || url.match(/\/4chan\/([a-z0-9]+)\/media\//)?.[1]
                || null;
    
    let rating = initialRating;
    if (board === 'gif') rating = 'nsfw';
    else if (board === 'wsg') rating = 'sfw';

    if (!rating || !['sfw', 'nsfw', 'nsfl'].includes(rating)) {
        return res.reply({ code: 400, body: JSON.stringify({ success: false, msg: 'Rating is required' }) });
    }

    const session = req.session;

    try {
      const uuid = await queue.genuuid();
      const tmpPath = path.join(cfg.paths.tmp, `${uuid}.tmp`);
      
      // Download via curl (lightweight)
      const curlArgs = [
          '-s', '-f', '-L', url, '-o', tmpPath,
          '--max-filesize', `${cfg.main.maxfilesize || 100 * 1024 * 1024}`,
          '--connect-timeout', '30',
          '--max-time', '300',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ];
      if (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') {
          const proxyHost = cfg.main.socks.includes('://') ? cfg.main.socks.split('://')[1] : cfg.main.socks;
          curlArgs.push('--socks5-hostname', proxyHost);
      }

      await queue.spawn('curl', curlArgs);
        
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
                return res.reply({
                  code: 200,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ success: true, repost: true, item_id: repost, msg: 'Already on site' })
                });
            }
        }

        const phash = await queue.generatePHash(finalTmp).catch(() => null);

        // PHash duplicate check
        if (phash && !getBypassDuplicateCheck()) {
            const phashMatch = await queue.checkrepostphash(phash);
            if (phashMatch) {
                await fs.unlink(finalTmp).catch(() => {});
                return res.reply({
                  code: 200,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ success: true, repost: true, item_id: phashMatch, msg: 'Already on site (visual match)' })
                });
            }
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
                username: session.user,
                userchannel: 'web',
                usernetwork: 'web',
                stamp: ~~(Date.now() / 1000),
                active: !isApprovalRequired,
                is_oc: !!is_oc
            }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active', 'is_oc')}
            RETURNING id
        `;

        // Process thumbnail
        try {
            await queue.genThumbnail(filename, mime, itemid, url, isApprovalRequired);
            if (rating === 'nsfw' || rating === 'nsfl') await queue.genBlurredThumbnail(itemid, isApprovalRequired);
        } catch (err) {
            console.error('[REHOST] Thumbnail error:', err);
        }

        // Tags
        const ratingTagId = rating === 'sfw' ? 1 : (rating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3));
        await db`insert into tags_assign ${db({ item_id: itemid, tag_id: ratingTagId, user_id: session.id })} on conflict do nothing`;
        
        const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
        // Board tag in chan-style format e.g. /gif/, /wsg/
        if (board) tags.push(`/${board}/`);
        // Auto-tag rating based on board
        if (board === 'wsg') tags.push('sfw');
        else if (board === 'gif') tags.push('nsfw');
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





        await db`INSERT INTO notifications (user_id, type, reference_id, item_id) VALUES (${session.id}, 'upload_success', 0, ${itemid})`;

        // Broadcast new_item event for live grid updates (only if auto-approved)
        if (!isApprovalRequired) {
          try {
            await db`SELECT pg_notify('new_item', ${JSON.stringify({
              id: itemid,
              dest: filename,
              mime: mime,
              username: session.user,
              display_name: session.display_name || null,
              tag_id: rating === 'sfw' ? 1 : (rating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3)),
              is_oc: false
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
          body: JSON.stringify({ success: true, item_id: itemid })
        });

      } catch (err) {
        console.error('[REHOST] Error:', err);
        return res.reply({
          code: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, msg: err.message })
        });
      }
  });

  return router;
};
