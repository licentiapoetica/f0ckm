import fetch from "flumm-fetch";
import { exec as _exec, spawn as _spawn } from "child_process";
import fs from "fs";
import db from "./sql.mjs";
import cfg from "./config.mjs";
import path from "path";
import os from "os";

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
      // 1. Get duration.
      // 2. Extract 3 frames: 10%, 50%, 90%.
      // 3. Generate dHash for each.
      // 4. Return combined hash "hash1_hash2_hash3".

      // Skip ffprobe for PDFs (which would fail with "Invalid data")
      if (source.toLowerCase().endsWith('.pdf')) {
        return null; 
      }

      const durationStr = (await this.spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', source])).stdout.trim();
      const duration = parseFloat(durationStr);
      if (isNaN(duration) || duration <= 0) return null;

      const timestamps = [duration * 0.1, duration * 0.5, duration * 0.9];
      const hashes = [];

      for (const ts of timestamps) {
        let buffer;
        try {
          const { stdout } = await this.spawn('ffmpeg', ['-ss', ts.toString(), '-v', 'error', '-i', source, '-vf', 'thumbnail,scale=33:32,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', quiet: true });
          buffer = stdout;
        } catch (err) {
          console.warn(`[PHASH] Failed to extract frame at ${ts}s for ${source}: ${err.message}`);
          // Buffer remains undefined, triggering fallback below
        }

        if (!buffer || buffer.length !== 1056) {
          console.warn(`[PHASH] Invalid buffer length (${buffer?.length}) at ${ts}s for ${source}`);
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
    const newHashes = newHash.split('_');
    if (newHashes.length === 0) return false;

    // Fetch all phashes, filtering out "all zero" failed hashes
    const items = await db`
      SELECT id, phash FROM items 
      WHERE phash IS NOT NULL 
      AND phash != '' 
      AND phash NOT LIKE '00000000%'
    `;

    // Configurable threshold: max Hamming distance per 256-bit dHash frame.
    // A value of 15 means < 6% bit difference — tight enough to only match true duplicates.
    const THRESHOLD = 15;

    const getHammingDistance = (h1, h2) => {
      if (!h1 || !h2 || h1.length !== h2.length) return 9999;
      let distance = 0;
      for (let i = 0; i < h1.length; i += 2) {
        const v1 = parseInt(h1.substr(i, 2), 16);
        const v2 = parseInt(h2.substr(i, 2), 16);
        let xor = v1 ^ v2;
        while (xor) {
          distance += xor & 1;
          xor >>= 1;
        }
      }
      return distance;
    };

    // We want at least 2 out of 3 frames to match
    const REQUIRED_MATCHES = 2;

    for (const item of items) {
      // Handle legacy single hashes vs new multi-hashes
      const dbHashes = item.phash.split('_');

      let matches = 0;
      // Compare corresponding frames: 0vs0, 1vs1, 2vs2
      const framesToCompare = Math.min(newHashes.length, dbHashes.length);

      for (let i = 0; i < framesToCompare; i++) {
        const dist = getHammingDistance(newHashes[i], dbHashes[i]);
        if (dist <= THRESHOLD) {
          matches++;
        }
      }

      // If we have 3 frames, require 2 out of 3 matches.
      // If we are comparing against a legacy 1-frame hash, require that single frame to match.
      if (framesToCompare >= 3 && matches >= REQUIRED_MATCHES) {
        return item.id;
      } else if (framesToCompare === 1 && matches === 1) {
        return item.id;
      } else if (framesToCompare === 2 && matches >= 2) {
        return item.id;
      }
    }

    return false;
  };

  async genuuid() {
    return (await db`
      select gen_random_uuid() as uuid
    `)[0].uuid.substring(0, 8);
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

  async genThumbnail(filename, mime, itemid, link, pending = false) {
    const bDir = pending ? path.join(cfg.paths.pending, 'b') : cfg.paths.b;
    const tDir = pending ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
    const cDir = pending ? path.join(cfg.paths.pending, 'ca') : cfg.paths.ca;
    const tmpFile = path.join(os.tmpdir(), itemid + '.png');
    const tmpJpg = path.join(os.tmpdir(), itemid + '.jpg');

    // Resolve real path if it's a symlink (important for reposts)
    let sourcePath = path.join(bDir, filename);
    try {
        const lstat = await fs.promises.lstat(sourcePath);
        if (lstat.isSymbolicLink()) {
            sourcePath = await fs.promises.realpath(sourcePath);
            console.log(`[QUEUE] Resolved symlink for thumbnailing: ${filename} -> ${sourcePath}`);
        }
    } catch (e) {}

    if (mime === 'video/youtube') {
      const videoId = filename.startsWith('yt:') ? filename.split(':')[1] : null;
      if (videoId) {
        const thumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        try {
          const curlArgs = ['-s', '-L', thumbUrl, '-o', tmpFile];
          if (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') {
            curlArgs.push('--proxy', cfg.main.socks.includes('://') ? cfg.main.socks : `socks5h://${cfg.main.socks}`);
          }
          await this.spawn('curl', curlArgs);
        } catch (err) {
          console.error(`[QUEUE] YouTube thumbnail extraction failed for ${itemid}:`, err);
        }
      }
    }
    else if (mime.startsWith('video/') || mime == 'image/gif') {
      const seeks = ['20%', '40%', '60%', '80%'];
      for (const seek of seeks) {
        await this.spawn('ffmpegthumbnailer', ['-i', sourcePath, '-s', '1024', '-t', seek, '-o', tmpFile]);
        try {
          const { stdout } = await this.spawn('magick', [tmpFile, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']);
          if (parseFloat(stdout.trim()) > 0.05) break; 
        } catch (e) { break; }
      }
    }
    else if (mime.startsWith('image/') && mime != 'image/gif')
      await this.spawn('magick', [sourcePath + '[0]', tmpFile]);
    else if (mime.startsWith('audio/')) {
      let coverExtracted = false;
      this._lastCoverExtracted = false; // Reset state for this call
      if (link.match(/soundcloud/)) {
        const proxyArgs = (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') ? ['--proxy', cfg.main.socks.includes('://') ? cfg.main.socks : `socks5h://${cfg.main.socks}`] : [];
        let cover = (await this.spawn('yt-dlp', [...proxyArgs, '-f', 'bv*[height<=720]+ba/b[height<=720] / wv*+ba/w', '--get-thumbnail', link])).stdout.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0).pop();
        if (!cover.match(/default_avatar/)) {
          cover = cover.replace(/-(large|original)\./, '-t500x500.');
          try {
            const curlArgs = ['-s', '-L', cover, '-o', tmpJpg];
            if (proxyArgs.length > 0) curlArgs.push(...proxyArgs);
            await this.spawn('curl', curlArgs);
            const size = (await fs.promises.stat(tmpJpg)).size;
            if (size >= 0) {
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
          await this.spawn('ffmpeg', ['-i', sourcePath, '-an', '-vcodec', 'copy', '-frames:v', '1', '-update', '1', tmpJpg]);
          const size = (await fs.promises.stat(tmpJpg)).size;
          if (size > 0) {
            await this.spawn('magick', [tmpJpg, tmpFile]);
            await this.spawn('magick', [tmpJpg, path.join(cDir, itemid + '.webp')]);
            coverExtracted = true;
          }
        } catch (err) { }
      }
      // If no cover art found, use audio.webp as the thumbnail
      if (!coverExtracted) {
        const audioFallback = path.join(cfg.paths.s, 'img', 'audio.webp');
        await fs.promises.copyFile(audioFallback, tmpFile).catch(async () => {
          // If copy fails, fall back to generated placeholder
          await this.spawn('magick', ['-size', '128x128', 'xc:#1a1a1a', '-gravity', 'center', '-fill', '#666', '-pointsize', '40', '-annotate', '0', '♪', tmpFile]).catch(() => {});
        });
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
          '-size', '256x256', 'xc:#1a1a2e',
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
            '-size', '256x256', 'xc:#d32f2f', // Professional PDF Red
            '-gravity', 'center',
            '-fill', 'white',
            '-pointsize', '60',
            '-annotate', '0', 'PDF',
            tmpFile
          ]).catch(() => {});
        });
      }
    }

    await this.spawn('magick', [tmpFile, '-resize', '128x128^', '-gravity', 'center', '-crop', '128x128+0+0', '+repage', path.join(tDir, itemid + '.webp')]);
    await fs.promises.unlink(tmpFile).catch(_ => { });
    await fs.promises.unlink(tmpJpg).catch(_ => { });
    return true;
  };

  async genBlurredThumbnail(itemid, pending = false) {
    const tDir = pending ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
    const src = path.join(tDir, `${itemid}.webp`);
    const dst = path.join(tDir, `${itemid}_blur.webp`);
    try {
      await this.spawn('magick', [src, '-blur', '0x20', dst]);
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
