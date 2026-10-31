import cfg from "../config.mjs";
import fs from "fs/promises";
import path from "path";
import db from "../sql.mjs";
import queue from "../queue.mjs";
import { isHiddenItem } from "../hidden_items.mjs";

export default (router, tpl) => {
  router.static({
    dir: cfg.paths.b,
    route: /^\/b\//
  });

  router.static({
    dir: cfg.paths.c,
    route: /^\/c\//
  });

  router.static({
    dir: cfg.paths.emojis,
    route: /^\/s\/emojis\//
  });

  router.static({
    dir: cfg.paths.koepfe,
    route: /^\/s\/koepfe\//
  });

  router.static({
    dir: cfg.paths.fonts,
    route: /^\/s\/fonts\//
  });

  router.static({
    dir: path.join(path.resolve(), 'node_modules/@ruffle-rs/ruffle'),
    route: /^\/s\/ruffle\//
  });

  router.static({
    dir: cfg.paths.s,
    route: /^\/s\//
  });

  const getImgMime = (filename) => {
    if (filename.endsWith('.webp')) return 'image/webp';
    if (filename.endsWith('.png')) return 'image/png';
    if (filename.endsWith('.gif')) return 'image/gif';
    if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'image/jpeg';
    return 'application/octet-stream';
  };

  // <id>.webp / <id>_blur.webp belonging to an item that isn't live (pending, deleted) is never public,
  // even if a stale file with that name exists. Uploaders use /pending/t/, staff /mod/pending/t/.
  const isHiddenMedia = async (file) => {
    const m = /^(\d+)(?:_blur)?\.webp$/.exec(file);
    return !!m && await isHiddenItem(m[1]);
  };

  const notFound = (res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 - file not found.');
  };

  router.get(/^\/t\/(?<file>.+)$/, async (req, res) => {
    const file = req.params.file;
    if (await isHiddenMedia(file)) return notFound(res);
    const filePath = path.join(cfg.paths.t, file);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const content = await fs.readFile(filePath);
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': getImgMime(file),
          'Cache-Control': 'public, max-age=3600'
        });
        return res.end(content);
      }
    } catch (_) {}

    // Dynamic generation or fallback for subf0cks / albums
    const base = file.replace(/\.[^.]+$/, '').replace(/_blur$/, '');
    try {
      const subRow = await db`SELECT id, item_id, dest, mime FROM album_items WHERE dest LIKE ${base + '.%'} LIMIT 1`;
      if (subRow.length > 0) {
        const sub = subRow[0];
        const srcFile = path.join(cfg.paths.b, sub.dest);
        const thumbDest = path.join(cfg.paths.t, `${base}.webp`);
        const srcStat = await fs.stat(srcFile).catch(() => null);
        if (srcStat && srcStat.size > 0) {
          if (sub.mime.startsWith('image/')) {
            await queue.spawn('magick', [srcFile + '[0]', '-resize', '256x256^', '-gravity', 'center', '-crop', '256x256+0+0', '+repage', thumbDest]);
          } else if (sub.mime.startsWith('video/')) {
            await queue.spawn('ffmpegthumbnailer', ['-i', srcFile, '-s', '256', '-o', thumbDest]).catch(async () => {
              await queue.spawn('ffmpeg', ['-y', '-ss', '00:00:01', '-i', srcFile, '-vframes', '1', '-vf', 'scale=256:256:force_original_aspect_ratio=increase,crop=256:256', thumbDest]);
            });
          }
          const genStat = await fs.stat(thumbDest).catch(() => null);
          if (genStat && genStat.size > 0) {
            const content = await fs.readFile(thumbDest);
            res.writeHead(200, {
              'Content-Length': genStat.size,
              'Content-Type': 'image/webp',
              'Cache-Control': 'public, max-age=3600'
            });
            return res.end(content);
          }
        }
        // Fallback to parent album thumbnail if subf0ck media file is missing
        const parentThumb = path.join(cfg.paths.t, `${sub.item_id}.webp`);
        const pStat = await fs.stat(parentThumb).catch(() => null);
        if (pStat && pStat.size > 0) {
          const content = await fs.readFile(parentThumb);
          res.writeHead(200, {
            'Content-Length': pStat.size,
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=3600'
          });
          return res.end(content);
        }
      }
    } catch (e) {
      console.warn('[STATIC /t/] Dynamic subf0ck thumbnail generation error:', e.message);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 - file not found.');
  });

  router.get(/^\/ca\/(?<file>.+)$/, async (req, res) => {
    const file = req.params.file;
    if (await isHiddenMedia(file)) return notFound(res);
    const filePath = path.join(cfg.paths.ca, file);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const content = await fs.readFile(filePath);
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': getImgMime(file),
          'Cache-Control': 'public, max-age=3600'
        });
        return res.end(content);
      }
    } catch (_) {}
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 - file not found.');
  });

  router.static({
    dir: cfg.paths.memes,
    route: /^\/memes\//
  });

  router.static({
    dir: cfg.paths.a,
    route: /^\/a\//
  });

  router.get(/^\/robots\.txt$/, async (req, res) => {
    res.reply({
      type: "text/plain",
      body: await fs.readFile(path.join(cfg.paths.s, "../robots.txt"), "utf-8")
    });
  });

  router.get(/^\/manifest\.json$/, async (req, res) => {
    res.reply({
      type: "application/json",
      body: await fs.readFile(path.join(cfg.paths.s, "../manifest.json"), "utf-8")
    });
  });

  router.get(/^\/sw\.js$/, async (req, res) => {
    res.reply({
      type: "application/javascript",
      body: await fs.readFile(path.join(cfg.paths.s, "../sw.js"), "utf-8")
    });
  });
};
