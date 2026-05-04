import db from "../sql.mjs";
import lib from "../lib.mjs";
import cfg from "../config.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import url from "url";
import path from "path";
import fs from "fs/promises";

export default (router, tpl) => {
  // Main Halls Overview
  router.get(/^\/halls$/, async (req, res) => {
    if (cfg.websrv.halls_enabled === false) return res.reply({ code: 404, body: tpl.render('error', { message: 'Not found', tmp: null }, req) });
    const mode = req.mode ?? 0;
    const excludedTags = req.session ? (req.session.excluded_tags || []) : [];
    
    const hallsList = await f0cklib.getHallsOverview(mode, excludedTags);
    
    const data = {
      hallsList: hallsList,
      tmp: null,
      hidePagination: true,
      session: (req.session && req.session.user) ? { ...req.session } : false,
      page_meta: {
        title: 'Halls',
        description: `Browse curated item collections`,
        url: `https://${cfg.main.url.domain}/halls`
      }
    };

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.reply({
        body: tpl.render('halls-partial', data, req)
      });
    }

    res.reply({
      body: tpl.render('halls', data, req)
    });
  });

  // Hall Thumbnail Route
  router.get(/^\/hall_image\/(?<hallSlug>.+)$/, async (req, res) => {
    const hallSlug = path.basename(decodeURIComponent(req.params.hallSlug));
    const mode = +(req.url.qs?.m ?? 0);
    const CACHE_DIR = path.join(cfg.paths.s, '../hall_cache');

    try {
      const CUSTOM_DIR = path.join(cfg.paths.s, '../hall_custom');
      const customPath = path.join(CUSTOM_DIR, `${hallSlug}.webp`);

      // Serve custom image if it exists (skip mosaic entirely)
      try {
        const stat = await fs.stat(customPath);
        const etag = '"' + stat.mtimeMs.toString(16) + '-' + stat.size.toString(16) + '"';
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-cache', 'ETag': etag });
        return res.end(await fs.readFile(customPath));
      } catch (e) { /* no custom image, fall through to mosaic */ }

      const hash = (await import('crypto')).createHash('md5').update(`${hallSlug}_${mode}`).digest('hex');
      const cachePath = path.join(CACHE_DIR, `${hash}.webp`);

      // Try cache first
      try {
        await fs.access(cachePath);
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600' });
        return res.end(await fs.readFile(cachePath));
      } catch (e) {}

      // Generate Mosaic
      let modeFilter = db``;
      if (mode === 0) modeFilter = db`JOIN tags_assign ta_sfw ON ta_sfw.item_id = i.id AND ta_sfw.tag_id = 1`;
      else if (mode === 1) modeFilter = db`JOIN tags_assign ta_nsfw ON ta_nsfw.item_id = i.id AND ta_nsfw.tag_id = 2`;

      const items = await db`
        SELECT i.id
        FROM items i
        JOIN halls_assign ha ON ha.item_id = i.id
        JOIN halls h ON h.id = ha.hall_id
        ${modeFilter}
        WHERE h.slug = ${hallSlug} AND i.active = true
        ORDER BY RANDOM()
        LIMIT 3
      `;

      if (items.length > 0) {
        const inputs = items.map(item => path.join(cfg.paths.t, `${item.id}.webp`));
        await fs.mkdir(CACHE_DIR, { recursive: true });
        
        const { execFile } = await import('child_process');
        const util = await import('util');
        const execFilePromise = util.promisify(execFile);

        // If only 1 or 2 items, just use what we have
        await execFilePromise('magick', [...inputs, '+append', '-background', 'none', '-resize', '300x150^', '-gravity', 'center', '-extent', '300x150', cachePath]);

        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600' });
        return res.end(await fs.readFile(cachePath));
      }
    } catch (e) {
      console.error('[HALL_IMAGE] Error:', e);
    }

    // Default placeholder
    res.writeHead(302, { 'Location': '/s/img/favicon.gif' });
    res.end();
  });

  return router;
};
