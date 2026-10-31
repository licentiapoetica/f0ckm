import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import cfg from "../../config.mjs";

const execFileAsync = promisify(execFile);

// Memory cache for in-flight requests to avoid concurrent yt-dlp calls for the same video
const pendingRequests = new Map();

export async function getOrExtractYoutubeAmbient(videoId) {
  // Validate videoId: YouTube IDs are 11 chars containing [a-zA-Z0-9_-]
  if (!videoId || !/^[a-zA-Z0-9_-]{6,15}$/.test(videoId)) {
    throw new Error("Invalid YouTube video ID");
  }

  let tDir = cfg.paths?.t || 'public/t';
  try { tDir = await fs.realpath(tDir); } catch (_) {}
  const cacheFile = path.join(tDir, `ambient_${videoId}.json`);

  // 1. Check disk cache
  try {
    const cached = await fs.readFile(cacheFile, 'utf8');
    return JSON.parse(cached);
  } catch (_) {
    // Not cached yet
  }

  // 2. De-duplicate concurrent requests
  if (pendingRequests.has(videoId)) {
    return pendingRequests.get(videoId);
  }

  const promise = (async () => {
    try {
      const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const proxyArgs = (cfg.main?.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '')
        ? ['--proxy', cfg.main.socks.includes('://') ? cfg.main.socks : `socks5h://${cfg.main.socks}`]
        : [];

      // Run yt-dlp to inspect formats
      const { stdout } = await execFileAsync('yt-dlp', [
        '-j',
        '--skip-download',
        '--no-playlist',
        ...proxyArgs,
        ytUrl
      ], { timeout: 15000 });

      const info = JSON.parse(stdout);
      const duration = Number(info.duration) || 0;

      // Find storyboard format (prefer sb3, fallback to sb2/sb1/sb0)
      const sbFormats = (info.formats || []).filter(f => f.format_id && f.format_id.startsWith('sb'));
      const sb = sbFormats.find(f => f.format_id === 'sb3') ||
                 sbFormats.find(f => f.format_id === 'sb2') ||
                 sbFormats[sbFormats.length - 1];

      let colors = [];

      if (sb && (sb.url || (sb.fragments && sb.fragments[0]?.url))) {
        const imgUrl = (sb.fragments && sb.fragments[0]?.url)
          ? sb.fragments[0].url
          : sb.url.replace('$M', '0');

        const tmpImg = path.join(os.tmpdir(), `sb_${videoId}_${Date.now()}.jpg`);
        const tmpRgb = path.join(os.tmpdir(), `sb_${videoId}_${Date.now()}.rgb`);

        try {
          const curlProxyArgs = (cfg.main?.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '')
            ? ['--proxy', cfg.main.socks.includes('://') ? cfg.main.socks : `socks5h://${cfg.main.socks}`]
            : [];
          await execFileAsync('curl', ['-s', '-L', imgUrl, '-o', tmpImg, ...curlProxyArgs], { timeout: 10000 });
          await execFileAsync('magick', [tmpImg, '-scale', '10x10!', `rgb:${tmpRgb}`], { timeout: 5000 });

          const buf = await fs.readFile(tmpRgb);
          for (let i = 0; i < buf.length; i += 3) {
            colors.push([buf[i], buf[i + 1], buf[i + 2]]);
          }
        } finally {
          await fs.unlink(tmpImg).catch(() => {});
          await fs.unlink(tmpRgb).catch(() => {});
        }
      }

      // If storyboard wasn't available or yielded no colors, fallback to thumbnail sampling
      if (!colors.length) {
        // Fallback: download thumbnail and sample a 3x3 palette
        const thumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        const tmpImg = path.join(os.tmpdir(), `sb_thumb_${videoId}_${Date.now()}.jpg`);
        const tmpRgb = path.join(os.tmpdir(), `sb_thumb_${videoId}_${Date.now()}.rgb`);
        try {
          await execFileAsync('curl', ['-s', '-L', thumbUrl, '-o', tmpImg], { timeout: 10000 });
          await execFileAsync('magick', [tmpImg, '-scale', '3x3!', `rgb:${tmpRgb}`], { timeout: 5000 });
          const buf = await fs.readFile(tmpRgb);
          for (let i = 0; i < buf.length; i += 3) {
            colors.push([buf[i], buf[i + 1], buf[i + 2]]);
          }
        } catch (_) {
          // Minimal fallback
          colors = [[30, 30, 35]];
        } finally {
          await fs.unlink(tmpImg).catch(() => {});
          await fs.unlink(tmpRgb).catch(() => {});
        }
      }

      const result = {
        videoId,
        duration,
        colors
      };

      // Cache to disk
      try {
        await fs.writeFile(cacheFile, JSON.stringify(result), 'utf8');
      } catch (err) {
        console.warn(`[AMBIENT] Failed to write cache for ${videoId}:`, err.message);
      }

      return result;
    } finally {
      pendingRequests.delete(videoId);
    }
  })();

  pendingRequests.set(videoId, promise);
  return promise;
}

export default (router) => {
  router.get(/^\/api\/v2\/ambient\/yt\/([a-zA-Z0-9_-]+)/, async (req, res) => {
    const videoId = req.url.pathname.split('/')[5];
    if (!videoId) {
      return res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'Missing video ID' }));
    }

    try {
      const data = await getOrExtractYoutubeAmbient(videoId);
      return res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
      }).end(JSON.stringify(data));
    } catch (err) {
      console.error(`[AMBIENT ERROR] Failed for ${videoId}:`, err.message);
      return res.writeHead(500, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: err.message }));
    }
  });

  return router;
};
