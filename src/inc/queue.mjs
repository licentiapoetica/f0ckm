import fetch from "flumm-fetch";
import { exec as _exec, spawn as _spawn } from "child_process";
import fs from "fs";
import db from "./sql.mjs";
import cfg from "./config.mjs";
import path from "path";
import os from "os";

function isFlatFrame(buffer) {
  if (!buffer || buffer.length !== 1056) return true;
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const val = buffer[i];
    if (val < min) min = val;
    if (val > max) max = val;
    sum += val;
  }
  const mean = sum / buffer.length;
  if (mean < 15 || mean > 240) return true;

  let sqDiffSum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sqDiffSum += Math.pow(buffer[i] - mean, 2);
  }
  const variance = sqDiffSum / buffer.length;
  return variance < 10 || (max - min) < 15;
}

export default new class queue {

  constructor() {

  };

  addqueue(e, link) {
    //this.#queue.push(e, link);
  };

  /**
   * Safe execution using spawn (no shell by default)
   * @param {string} cmd 
   * @param {string[]} args 
   * @param {object} options 
   */
  spawn(cmd, args = [], options = {}) {
    return new Promise((resolve, reject) => {
      const child = _spawn(cmd, args, { ...options });
      let stdoutChunks = [];
      let stderrChunks = [];

      if (child.stdout) {
        child.stdout.on("data", data => { stdoutChunks.push(data); });
      }
      if (child.stderr) {
        child.stderr.on("data", data => { stderrChunks.push(data); });
      }

      child.on("close", code => {
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks);

        if (code !== 0 && !options.ignoreExitCode) {
          const err = new Error(`Command '${cmd} ${args.join(' ')}' failed with code ${code}`);
          err.stderr = stderr.toString();
          err.stdout = stdout.toString();
          return reject(err);
        }
        if (stderr.length > 0 && !options.quiet)
          console.error(stderr.toString());
        
        // Return buffer if encoding is 'buffer', else string
        resolve({ 
          stdout: options.encoding === 'buffer' ? stdout : stdout.toString(), 
          stderr: stderr.toString() 
        });
      });

      child.on("error", err => {
        err.stderr = Buffer.concat(stderrChunks).toString();
        err.stdout = Buffer.concat(stdoutChunks).toString();
        reject(err);
      });
    });
  }

  /** @deprecated Use queue.spawn() instead — exec() invokes a shell and is vulnerable to injection if passed user input. */
  exec(cmd, options = {}) {
    if (!this._execDeprecated) {
      console.warn('[DEPRECATED] queue.exec() is deprecated — use queue.spawn() to avoid shell injection risks');
      this._execDeprecated = true;
    }
    return new Promise((resolve, reject) => {
      _exec(cmd, { maxBuffer: 5e3 * 1024, ...options }, (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        if (stderr && !options.quiet)
          console.error(stderr);
        resolve({ stdout: stdout });
      });
    });
  };

  async generatePHash(source) {
    try {
      // Temporal dHash implementation:
      // 1. Check if source is image/video and get duration.
      // 2. For videos: Extract 3 frames (10%, 50%, 90% of duration).
      //    For static images: Extract 1 frame.
      // 3. Generate dHash for each valid non-flat frame.
      // 4. Return combined hash "hash1_hash2_hash3" or single "hash".

      // Skip ffprobe for PDFs (which would fail with "Invalid data")
      if (source.toLowerCase().endsWith('.pdf')) {
        return null; 
      }

      let isVideo = true;
      let timestamps = [];
      
      try {
        const durationStr = (await this.spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', source])).stdout.trim();
        const duration = parseFloat(durationStr);
        if (isNaN(duration) || duration <= 0) {
          isVideo = false;
        } else {
          timestamps = [duration * 0.1, duration * 0.5, duration * 0.9];
        }
      } catch (err) {
        isVideo = false;
      }

      if (!isVideo) {
        timestamps = [0]; // Process static image as single frame
      }

      const hashes = [];

      for (const ts of timestamps) {
        let buffer;
        try {
          const vf = isVideo ? 'thumbnail,scale=33:32,format=gray' : 'scale=33:32,format=gray';
          const args = [];
          if (isVideo) {
            args.push('-ss', ts.toString());
          }
          args.push('-v', 'error', '-i', source, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1');
          
          const { stdout } = await this.spawn('ffmpeg', args, { encoding: 'buffer', quiet: true });
          buffer = stdout;
        } catch (err) {
          console.warn(`[PHASH] Failed to extract frame at ${ts}s for ${source}: ${err.message}`);
        }

        if (!buffer || buffer.length !== 1056) {
          console.warn(`[PHASH] Invalid buffer length (${buffer?.length}) at ${ts}s for ${source}`);
          continue;
        }

        // Filter out flat/black frames (e.g. solid color backgrounds, fade-to-black)
        if (isFlatFrame(buffer)) {
          console.log(`[PHASH] Ignored flat/black frame at ${ts}s for ${source}`);
          continue;
        }

        let hash = '';
        let currentByte = 0;
        let bitCount = 0;

        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 32; x++) {
            const left = buffer[y * 33 + x];
            const right = buffer[y * 33 + x + 1];

            const bit = left > right ? 1 : 0;
            currentByte = (currentByte << 1) | bit;
            bitCount++;

            if (bitCount === 8) {
              hash += currentByte.toString(16).padStart(2, '0');
              currentByte = 0;
              bitCount = 0;
            }
          }
        }
        hashes.push(hash);
      }

      if (hashes.length === 0) return null;
      return hashes.join('_');

    } catch (e) {
      console.error("PHash generation failed:", e);
      return null;
    }
  };

  async checkrepostphash(newHash) {
    if (!newHash) return false;
    const newHashes = newHash.split('_').filter(s => s && !s.startsWith('00000000'));
    if (newHashes.length === 0) return false;

    const h1 = newHashes[0] || '';
    const h2 = newHashes[1] || '';
    const h3 = newHashes[2] || '';

    const results = await db`
      SELECT id FROM items
      WHERE is_deleted = false
        AND phash IS NOT NULL AND phash != '' AND phash != 'ERROR' AND phash != 'MISSING' AND phash NOT LIKE '00000000%'
        AND (
          (
            CASE WHEN split_part(phash, '_', 1) != '' AND ${h1} != '' THEN
              bit_count(('x' || split_part(phash, '_', 1))::bit(1024) # ('x' || ${h1})::bit(1024)) <= 15
            ELSE false END::int
            +
            CASE WHEN split_part(phash, '_', 2) != '' AND ${h2} != '' THEN
              bit_count(('x' || split_part(phash, '_', 2))::bit(1024) # ('x' || ${h2})::bit(1024)) <= 15
            ELSE false END::int
            +
            CASE WHEN split_part(phash, '_', 3) != '' AND ${h3} != '' THEN
              bit_count(('x' || split_part(phash, '_', 3))::bit(1024) # ('x' || ${h3})::bit(1024)) <= 15
            ELSE false END::int
          ) >= (
            CASE 
              WHEN split_part(phash, '_', 3) != '' AND ${h3} != '' THEN 2
              WHEN split_part(phash, '_', 2) != '' AND ${h2} != '' THEN 2
              ELSE 1
            END
          )
        )
      LIMIT 1
    `;

    return results.length > 0 ? results[0].id : false;
  };

  async findallrepostphash(newHash, excludeId = null) {
    if (!newHash) return [];
    const newHashes = newHash.split('_').filter(s => s && !s.startsWith('00000000'));
    if (newHashes.length === 0) return [];

    const h1 = newHashes[0] || '';
    const h2 = newHashes[1] || '';
    const h3 = newHashes[2] || '';

    const results = await db`
      SELECT id, username, stamp FROM items
      WHERE is_deleted = false
        AND phash IS NOT NULL AND phash != '' AND phash != 'ERROR' AND phash != 'MISSING' AND phash NOT LIKE '00000000%'
        ${excludeId ? db`AND id != ${excludeId}` : db``}
        AND (
            CASE WHEN split_part(phash, '_', 1) != '' AND ${h1} != '' THEN
              bit_count(('x' || split_part(phash, '_', 1))::bit(1024) # ('x' || ${h1})::bit(1024)) <= 15
            ELSE false END::int
            +
            CASE WHEN split_part(phash, '_', 2) != '' AND ${h2} != '' THEN
              bit_count(('x' || split_part(phash, '_', 2))::bit(1024) # ('x' || ${h2})::bit(1024)) <= 15
            ELSE false END::int
            +
            CASE WHEN split_part(phash, '_', 3) != '' AND ${h3} != '' THEN
              bit_count(('x' || split_part(phash, '_', 3))::bit(1024) # ('x' || ${h3})::bit(1024)) <= 15
            ELSE false END::int
          >= 1
        )
      ORDER BY id ASC
    `;

    return results.map(r => ({ id: r.id, username: r.username, stamp: r.stamp }));
  };

  async checkcommentrepostphash(newHash) {
    if (!newHash) return false;
    const newHashes = newHash.split('_').filter(s => s && !s.startsWith('00000000'));
    if (newHashes.length === 0) return false;

    const h1 = newHashes[0] || '';
    const h2 = newHashes[1] || '';
    const h3 = newHashes[2] || '';

    const results = await db`
      SELECT id, dest FROM comment_files
      WHERE phash IS NOT NULL AND phash != '' AND phash NOT LIKE '00000000%'
        AND (
          (
            CASE WHEN split_part(phash, '_', 1) != '' AND ${h1} != '' THEN
              bit_count(('x' || split_part(phash, '_', 1))::bit(1024) # ('x' || ${h1})::bit(1024)) <= 15
            ELSE false END::int
            +
            CASE WHEN split_part(phash, '_', 2) != '' AND ${h2} != '' THEN
              bit_count(('x' || split_part(phash, '_', 2))::bit(1024) # ('x' || ${h2})::bit(1024)) <= 15
            ELSE false END::int
            +
            CASE WHEN split_part(phash, '_', 3) != '' AND ${h3} != '' THEN
              bit_count(('x' || split_part(phash, '_', 3))::bit(1024) # ('x' || ${h3})::bit(1024)) <= 15
            ELSE false END::int
          ) >= (
            CASE 
              WHEN split_part(phash, '_', 3) != '' AND ${h3} != '' THEN 2
              WHEN split_part(phash, '_', 2) != '' AND ${h2} != '' THEN 2
              ELSE 1
            END
          )
        )
      LIMIT 1
    `;

    return results.length > 0 ? results[0] : false;
  };

  async genuuid() {
    const raw = (await db`
      select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') as uuid
    `)[0].uuid;
    return raw.substring(0, 48);
  };

  async checkrepostlink(link) {
    const q_repost = await db`
      select id
      from "items"
      where src = ${link}
    `;
    return q_repost.length > 0 ? q_repost[0].id : false;
  };

  async checkrepostsum(checksum) {
    const q_repost = await db`
      select id
      from "items"
      where checksum = ${checksum}
    `;
    return q_repost.length > 0 ? q_repost[0].id : false;
  };

  async getItemID(filename) {
    return (await db`
      select *
      from "items"
      where dest = ${filename}
      limit 1
    `)[0].id;
  };

  /**
   * Returns the optimal thumbnail size in pixels for a given contribution score tier.
   * Tier 1 = default 1x1 (512px), Tier 2 = 2x2 (512px — same source, larger display)
   */
  getThumbSize(tier) {
    return 512; // Always generate at 512px for crisp display at any size
  }

  async genThumbnail(filename, mime, itemid, link, pending = false, size = 512) {
    let bDir = pending ? path.join(cfg.paths.pending, 'b') : cfg.paths.b;
    let tDir = pending ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
    let cDir = pending ? path.join(cfg.paths.pending, 'ca') : cfg.paths.ca;
    try { bDir = await fs.promises.realpath(bDir); } catch (_) {}
    try { tDir = await fs.promises.realpath(tDir); } catch (_) {}
    try { cDir = await fs.promises.realpath(cDir); } catch (_) {}
    const tmpFile = path.join(os.tmpdir(), itemid + '.png');
    const tmpJpg = path.join(os.tmpdir(), itemid + '.jpg');
    const thumbSize = (size && size > 128) ? size : 128;
    const thumbSpec = `${thumbSize}x${thumbSize}`;

    // Resolve real path if it's a symlink (important for reposts)
    let sourcePath = path.join(bDir, filename);
    try {
        const lstat = await fs.promises.lstat(sourcePath);
        if (lstat.isSymbolicLink()) {
            sourcePath = await fs.promises.realpath(sourcePath);
            console.log(`[QUEUE] Resolved symlink for thumbnailing: ${filename} -> ${sourcePath}`);
        }
    } catch (e) {}

    let outPath = path.join(tDir, itemid + '.webp');
    try {
        const outStat = await fs.promises.lstat(outPath);
        if (outStat.isSymbolicLink()) {
            await fs.promises.unlink(outPath).catch(() => {});
        }
    } catch (_) {}

    try {

    if (mime === 'video/youtube') {
      const videoId = filename.startsWith('yt:') ? filename.split(':')[1] : null;
      if (videoId) {
        // Try quality tiers from highest to lowest. maxresdefault may not exist for all videos
        // (YouTube returns a 120×90 placeholder), so we check file size before accepting.
        const thumbQualities = ['maxresdefault', 'sddefault', 'hqdefault'];
        const proxyArgs = (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '')
          ? ['--proxy', cfg.main.socks.includes('://') ? cfg.main.socks : `socks5h://${cfg.main.socks}`]
          : [];
        let fetched = false;
        for (const quality of thumbQualities) {
          const thumbUrl = `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
          try {
            await this.spawn('curl', ['-s', '-L', thumbUrl, '-o', tmpFile, ...proxyArgs]);
            const stat = await fs.promises.stat(tmpFile).catch(() => null);
            // maxresdefault placeholder is ~1.3KB; real thumbnails are much larger
            if (stat && stat.size > 5000) {
              fetched = true;
              break;
            }
          } catch (err) {
            // try next quality
          }
        }
        if (!fetched) {
          console.error(`[QUEUE] YouTube thumbnail extraction failed for ${itemid}: all quality levels failed or returned placeholder`);
        } else {
          // Pre-warm dynamic ambient timeline in background
          import('./routes/apiv2/ambient.mjs')
            .then(m => m.getOrExtractYoutubeAmbient(videoId))
            .catch(() => {});
        }
      }
    }
    else if (mime.startsWith('video/') || mime == 'image/gif') {
      const ffThumbSize = Math.max(thumbSize, 512);
      const seeks = ['20%', '40%', '60%', '80%'];
      for (const seek of seeks) {
        try {
          await this.spawn('ffmpegthumbnailer', ['-i', sourcePath, '-s', String(ffThumbSize), '-t', seek, '-o', tmpFile]);
        } catch (err) {
          console.warn(`[QUEUE] ffmpegthumbnailer failed at ${seek} for ${itemid}, trying ffmpeg fallback: ${err.message}`);
          let seekSeconds = 0;
          try {
            const durationStr = (await this.spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', sourcePath])).stdout.trim();
            const duration = parseFloat(durationStr);
            if (!isNaN(duration) && duration > 0) {
              const pct = parseFloat(seek) / 100;
              seekSeconds = duration * pct;
            }
          } catch (probeErr) {
            seekSeconds = seek === '20%' ? 2 : seek === '40%' ? 5 : seek === '60%' ? 8 : 10;
          }
          // Fallback to ffmpeg, overriding the color transfer characteristic to standard bt709 (1) in case of unsupported trc properties (e.g. log316)
          await this.spawn('ffmpeg', [
            '-y',
            '-ss', String(seekSeconds),
            '-color_trc', '1',
            '-i', sourcePath,
            '-frames:v', '1',
            '-update', '1',
            '-vf', `scale=${ffThumbSize}:${ffThumbSize}:force_original_aspect_ratio=increase,crop=${ffThumbSize}:${ffThumbSize}`,
            tmpFile
          ]);
        }
        try {
          const { stdout } = await this.spawn('magick', [tmpFile, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']);
          if (parseFloat(stdout.trim()) > 0.05) break; 
        } catch (e) { break; }
      }
    }
    else if (mime.startsWith('image/') && mime != 'image/gif') {
      if (mime === 'image/avif') {
        try {
          await this.spawn('ffmpeg', ['-i', sourcePath, '-frames:v', '1', '-update', '1', tmpFile]);
        } catch (err) {
          // If ffmpeg fails, fallback to magick
          await this.spawn('magick', [sourcePath + '[0]', '-auto-orient', tmpFile]);
        }
      } else {
        await this.spawn('magick', [sourcePath + '[0]', '-auto-orient', tmpFile]);
      }
    }
    else if (mime.startsWith('audio/')) {
      let coverExtracted = false;
      this._lastCoverExtracted = false; // Reset state for this call
      if (link && typeof link === 'string' && link.match(/soundcloud/)) {
        const proxyArgs = (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') ? ['--proxy', cfg.main.socks.includes('://') ? cfg.main.socks : `socks5h://${cfg.main.socks}`] : [];
        let cover = null;
        try {
          const ytRes = await this.spawn('yt-dlp', [...proxyArgs, '--get-thumbnail', link], { quiet: true });
          cover = ytRes.stdout.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0).pop();
        } catch (err) {
          console.warn(`[QUEUE] yt-dlp thumbnail fetch failed for SoundCloud track (${link}):`, err.message || err);
        }
        if (cover && !cover.match(/default_avatar/)) {
          cover = cover.replace(/-(large|original)\./, '-t500x500.');
          try {
            const curlArgs = ['-s', '-L', cover, '-o', tmpJpg];
            if (proxyArgs.length > 0) curlArgs.push(...proxyArgs);
            await this.spawn('curl', curlArgs);
            const size = (await fs.promises.stat(tmpJpg)).size;
            if (size > 0) {
              await this.spawn('magick', [tmpJpg, tmpFile]);
              await this.spawn('magick', [tmpJpg, path.join(cDir, itemid + '.webp')]);
              coverExtracted = true;
            }
          } catch (err) { }
        }
        if (!coverExtracted) {
          try {
            await this.spawn('ffmpeg', ['-i', sourcePath, '-an', '-vcodec', 'copy', '-frames:v', '1', '-update', '1', tmpJpg]);
            const size = (await fs.promises.stat(tmpJpg)).size;
            if (size > 0) {
              await this.spawn('magick', [tmpJpg, tmpFile]);
              await this.spawn('magick', [tmpJpg, path.join(cDir, itemid + '.webp')]);
              coverExtracted = true;
            }
          } catch (err) { }
        }
      } else {
        // Try extracting embedded cover art (video stream in audio file)
        try {
          const caWebp = path.join(cDir, itemid + '.webp');
          await this.spawn('ffmpeg', ['-y', '-i', sourcePath, '-an', '-vcodec', 'webp', '-frames:v', '1', caWebp]);
          const stat = await fs.promises.stat(caWebp).catch(() => null);
          if (stat && stat.size > 0) {
            await this.spawn('magick', [caWebp + '[0]', tmpFile]);
            coverExtracted = true;
          }
        } catch (err) { }
        if (!coverExtracted) {
          try {
            await this.spawn('ffmpeg', ['-y', '-i', sourcePath, '-an', '-vcodec', 'copy', '-frames:v', '1', '-update', '1', tmpJpg]);
            const size = (await fs.promises.stat(tmpJpg).catch(() => ({ size: 0 }))).size;
            if (size > 0) {
              await this.spawn('magick', [tmpJpg, tmpFile]);
              await this.spawn('magick', [tmpJpg, path.join(cDir, itemid + '.webp')]);
              coverExtracted = true;
            }
          } catch (err) { }
        }
      }
      // If no new cover art extracted, check if cover art was already saved previously in cDir
      if (!coverExtracted) {
        const existingCover = path.join(cDir, itemid + '.webp');
        try {
          const stat = await fs.promises.stat(existingCover);
          if (stat.size > 0) {
            await this.spawn('magick', [existingCover, tmpFile]);
            coverExtracted = true;
          }
        } catch (_) { }
      }
      // If no cover art found, generate audio placeholder matching .sidebar-media-placeholder.audio
      if (!coverExtracted) {
        await this.genAudioPlaceholder(tmpFile, thumbSpec, thumbSize);
      }
      // Store extraction result for caller
      this._lastCoverExtracted = coverExtracted;
    }
    else if (mime === 'application/x-shockwave-flash' || mime === 'application/vnd.adobe.flash.movie') {
      let customThumb = cfg.websrv.swf_thumb;
      if (customThumb && customThumb.startsWith('/')) {
        customThumb = path.join(path.resolve(), 'public', customThumb);
      }
      let usedCustom = false;
      if (customThumb) {
        try {
          const stat = await fs.promises.stat(customThumb).catch(() => null);
          if (stat && stat.size > 0) {
            await this.spawn('magick', [customThumb, tmpFile]);
            usedCustom = true;
          }
        } catch (_) {}
      }
      if (!usedCustom) {
        await this.spawn('magick', [
          '-size', thumbSpec, 'xc:#1a1a2e',
          '-gravity', 'center',
          '-fill', '#e040fb',
          '-pointsize', '48',
          '-annotate', '0', 'SWF',
          tmpFile
        ]).catch(() => {});
      }
    }
    else if (mime === 'application/pdf') {
      try {
        await this.spawn('gs', [
          '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m',
          '-r150',
          '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
          '-dLastPage=1',
          '-sOutputFile=' + tmpFile,
          sourcePath
        ]);
      } catch (err) {
        console.warn(`[QUEUE] PDF extraction failed for ${itemid}, using fallback icon.`);
        const pdfFallback = path.join(cfg.paths.s, 'img', 'pdf.webp');
        await fs.promises.copyFile(pdfFallback, tmpFile).catch(async () => {
          // If the asset is missing, generate a red PDF-style placeholder matching the user's reference
          await this.spawn('magick', [
            '-size', thumbSpec, 'xc:#d32f2f', // Professional PDF Red
            '-gravity', 'center',
            '-fill', 'white',
            '-pointsize', '60',
            '-annotate', '0', 'PDF',
            tmpFile
          ]).catch(() => {});
        });
      }
    }
    else if (mime.startsWith('application/') && cfg.mimes[mime] && !['swf', 'pdf'].includes(cfg.mimes[mime])) {
      // Any application/* MIME registered in config that isn't swf or pdf is treated as an archive.
      // Both the detection and the label come straight from cfg.mimes — no hardcoded list needed.
      let customThumb = cfg.websrv && cfg.websrv.archive_thumb;
      if (customThumb && customThumb.startsWith('/')) {
        customThumb = path.join(path.resolve(), 'public', customThumb);
      }
      let usedCustom = false;
      if (customThumb) {
        try {
          const stat = await fs.promises.stat(customThumb).catch(() => null);
          if (stat && stat.size > 0) {
            await this.spawn('magick', [customThumb, tmpFile]);
            usedCustom = true;
          }
        } catch (_) {}
      }
      if (!usedCustom) {
        const archiveLabel = (cfg.mimes[mime] || 'arc').toUpperCase();
        await this.spawn('magick', [
          '-size', thumbSpec, 'xc:#1a2e1a',
          '-gravity', 'center',
          '-fill', '#66bb6a',
          '-pointsize', '48',
          '-annotate', '0', archiveLabel,
          tmpFile
        ]).catch(() => {});
      }
    }


    const isTransparentMime = mime === 'image/png' || mime === 'image/webp' || mime === 'image/avif' || mime === 'image/gif';
    if (isTransparentMime) {
      // Build a grey/white checkerboard via explicit xc: squares (no pattern replacement tricks):
      // row1 = [white | grey], row2 = row1 flipped → stack into a 2x2 tile → tile to thumbSpec
      const sq = 16;
      const tmpRow1    = path.join(os.tmpdir(), `${itemid}_r1.png`);
      const tmpRow2    = path.join(os.tmpdir(), `${itemid}_r2.png`);
      const tmpTile    = path.join(os.tmpdir(), `${itemid}_tile.png`);
      const tmpBg      = path.join(os.tmpdir(), `${itemid}_bg.png`);
      const tmpResized = path.join(os.tmpdir(), `${itemid}_rs.png`);
      try {
        await this.spawn('magick', ['-size', `${sq}x${sq}`, 'xc:white', '-size', `${sq}x${sq}`, 'xc:#cccccc', '+append', tmpRow1]);
        await this.spawn('magick', [tmpRow1, '-flop', tmpRow2]);
        await this.spawn('magick', [tmpRow1, tmpRow2, '-append', tmpTile]);
        await this.spawn('magick', ['-size', thumbSpec, `tile:${tmpTile}`, '-define', 'png:color-type=2', tmpBg]);
        // Resize/crop source image preserving alpha channel; force sRGB so palette images retain color
        await this.spawn('magick', [tmpFile, '-auto-orient', '-colorspace', 'sRGB', '-resize', `${thumbSpec}^`, '-gravity', 'center', '-crop', `${thumbSpec}+0+0`, '+repage', tmpResized]);
        // Composite: Over operator — image (with alpha) on top of opaque checkerboard bg
        await this.spawn('magick', [tmpBg, tmpResized, '-composite', outPath]);
      } finally {
        for (const f of [tmpRow1, tmpRow2, tmpTile, tmpBg, tmpResized]) {
          await fs.promises.unlink(f).catch(() => {});
        }
      }
    } else {
      await this.spawn('magick', [tmpFile, '-auto-orient', '-resize', `${thumbSpec}^`, '-gravity', 'center', '-crop', `${thumbSpec}+0+0`, '+repage', outPath]);
    }
    await fs.promises.unlink(tmpFile).catch(_ => { });
    await fs.promises.unlink(tmpJpg).catch(_ => { });
    return true;

    } catch (err) {
      console.error(`[QUEUE] genThumbnail failed for item ${itemid} (${mime}):`, err.message || err);
      // Cleanup temp files
      await fs.promises.unlink(tmpFile).catch(() => {});
      await fs.promises.unlink(tmpJpg).catch(() => {});
      if (mime && mime.startsWith('audio/')) {
        try {
          await this.genAudioPlaceholder(outPath, thumbSpec, thumbSize);
          console.warn(`[QUEUE] Used audio placeholder thumbnail for item ${itemid}`);
          return false;
        } catch (_) {}
      }
      // Fallback: copy 404.gif as the thumbnail
      const fallback404 = path.join(cfg.paths.s, 'img', '404.gif');
      try {
        await this.spawn('magick', [fallback404, '-resize', `${thumbSpec}^`, '-gravity', 'center', '-crop', `${thumbSpec}+0+0`, '+repage', outPath]);
        console.warn(`[QUEUE] Used 404.gif fallback thumbnail for item ${itemid}`);
      } catch (fallbackErr) {
        console.error(`[QUEUE] Even fallback thumbnail failed for item ${itemid}:`, fallbackErr.message || fallbackErr);
      }
      return false;
    }
  };

  async genAudioPlaceholder(targetFile, thumbSpec = '512x512', thumbSize = 512) {
    const faFont = path.join(cfg.paths.s, 'fa', 'webfonts', 'fa-solid-900.ttf');
    const ptSize = String(Math.round(thumbSize * 0.35));
    try {
      await this.spawn('magick', [
        '-size', thumbSpec, 'radial-gradient:#2c2c2c-#181818',
        '(', '+clone', '-font', faFont, '-pointsize', ptSize, '-gravity', 'center', '-fill', 'rgba(255,255,255,0.3)', '-annotate', '0', '\uf001', '-blur', '0x12', ')',
        '-composite',
        '-font', faFont, '-pointsize', ptSize, '-gravity', 'center', '-fill', 'rgba(240,240,240,0.88)', '-annotate', '0', '\uf001',
        targetFile
      ]);
      return true;
    } catch (_) {
      const audioFallback = path.join(cfg.paths.s, 'img', 'audio.webp');
      try {
        await fs.promises.copyFile(audioFallback, targetFile);
        return true;
      } catch (copyErr) {
        await this.spawn('magick', [
          '-size', thumbSpec, 'radial-gradient:#2c2c2c-#181818',
          '-gravity', 'center', '-fill', 'rgba(240,240,240,0.88)', '-pointsize', '60', '-annotate', '0', '♪',
          targetFile
        ]).catch(() => {});
        return false;
      }
    }
  };


  async genBlurredThumbnail(itemid, pending = false) {
    let tDir = pending ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
    try { tDir = await fs.promises.realpath(tDir); } catch (_) {}
    const src = path.join(tDir, `${itemid}.webp`);
    const dst = path.join(tDir, `${itemid}_blur.webp`);
    try {
      const dstStat = await fs.promises.lstat(dst);
      if (dstStat.isSymbolicLink()) {
        await fs.promises.unlink(dst).catch(() => {});
      }
    } catch (_) {}
    try {
      await this.spawn('magick', [src, '-blur', '0x48', dst]);
      return true;
    } catch (err) {
      console.error(`[QUEUE] Failed to generate blurred thumbnail for ${itemid}:`, err);
      return false;
    }
  };

  /**
   * Extract metadata tags from a media file using ffprobe
   * @param {string} source Path to the source file
   * @returns {object|null} Format tags object or null on failure
   */
  async getVideoMetadata(source) {
    try {
      const { stdout } = await this.spawn('ffprobe', [
        '-v', 'quiet',
        '-show_entries', 'format_tags',
        '-of', 'json',
        source
      ], { quiet: true, ignoreExitCode: true });
      
      if (!stdout || !stdout.trim()) return null;
      
      const data = JSON.parse(stdout);
      return data?.format?.tags || null;
    } catch (err) {
      // Only log if it's not a simple spawn/parse failure which is expected for some truncated chunks
      if (err.name !== 'SyntaxError') {
        console.error(`[QUEUE] Metadata extraction failed for ${source}:`, err.message);
      }
      return null;
    }
  }

  // tags
  async tagSFW(itemid) {
    return await db`
      insert into "tags_assign" ${db({
      item_id: itemid,
      tag_id: 1,
      user_id: 1
    })
      }
    `;
  };

  async tagNSFW(itemid) {
    return await db`
      insert into "tags_assign" ${db({
      item_id: itemid,
      tag_id: 2,
      user_id: 1
    })
      }
    `;
  };

  async notifyAdmins(itemid) {
    try {
      const admins = await db`select id from "user" where admin = true or is_moderator = true`;
      const notifications = admins.map(admin => ({
        user_id: admin.id,
        type: 'admin_pending',
        reference_id: 0,
        item_id: itemid
      }));

      if (notifications.length > 0) {
        await db`INSERT INTO notifications ${db(notifications)} ON CONFLICT DO NOTHING`;
      }
    } catch (err) {
      console.error('[QUEUE] Failed to notify admins/mods:', err);
    }
  }

};
