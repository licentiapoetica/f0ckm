import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";
import { getLevel } from "../admin.mjs";
import { getManualApproval, getMinTags } from "../settings.mjs";
import queue from "../queue.mjs";
import autotagger from "../autotagger.mjs";
import fetch from "flumm-fetch";
import fs from "fs";
import path from "path";


const regex = {
  all: /https?:\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:/~+#-]*[\w@?^=%&/~+#-])?/gi,
  yt: /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\?(?:\S*?&?v\=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/gi,
  imgur: /(?:https?:)?\/\/(\w+\.)?imgur\.com\/\S+/i,
  fourchan: /https?:\/\/i\.4cdn\.org\/(\w+)\/(\d+)\.(\w{3,4})/i,
  instagram: /(?:https?:\/\/www\.)?instagram\.com\S*?\/(?:p|reel)\/(\w{11})\/?/im,
  ph: /(?:https?:\/\/)?(?:\w+\.)?pornhub\.(?:com|org)\/view_video\.php\?viewkey=([\w-]+)/i
};
const pcUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const mediagroupids = new Set();
const extractJSON = (stdout) => {
  try {
    const lines = stdout.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
    }
  } catch (err) { }
  try { return JSON.parse(stdout); }
  catch(e) { 
    console.error(`[EXTRACT_JSON ERROR] Failed to parse JSON from yt-dlp. First 500 chars: ${stdout.substring(0, 500)}`);
    console.error(`[EXTRACT_JSON DEBUG] Full output length: ${stdout.length}`);
    throw e;
  }
};

export default async bot => {

  return [{
    name: "parser",
    call: new RegExp(`${regex.all.source}|^!w(0bm)?\\b`, 'i'),
    active: true,
    clients: ["irc", "tg", "slack", "discord", "matrix"],
    f: async e => {
      console.log(`[PARSER START] Triggered by ${e.user.nick} in ${e.channel} (${e.type}). Msg: '${e.message}'`);
      
      const links = e.message.match(regex.all)?.filter(link => !link.includes(cfg.main.url.domain)) || [];
      let repost;
      if (e.media)
        links.push(e.media);




      // Matrix: Restrict to specific room if configured
      if (e.type === 'matrix') {
          const matrixCfg = cfg.clients.find(c => c.type === 'matrix');
          console.log(`[PARSER DEBUG] Matrix Room Check: Config=${matrixCfg?.upload_channel_id}, Event=${e.channelid}`);
          if (matrixCfg?.upload_channel_id && e.channelid !== matrixCfg.upload_channel_id) {
              console.log(`[PARSER DEBUG] Room mismatch - Aborting.`);
              return false;
          }
      }
      
      // If no links found yet, check matrix reply
      if (links.length === 0) {
        if (e.type === 'matrix' && e.replyTo) {
             console.log(`[PARSER DEBUG] Inspecting replyTo:`, JSON.stringify(e.replyTo, null, 2));
             
             // Relaxed permission check: 
             // Allow !w if: 
             // 1. User is replying to their own message OR
             // 2. We are in the designated upload channel (where anyone with a link can help tag) OR
             // 3. User is an admin/mod (level > 10)
             const matrixCfg = cfg.clients.find(c => c.type === 'matrix');
             const isUploadChannel = matrixCfg?.upload_channel_id && e.channelid === matrixCfg.upload_channel_id;
             const userLevel = (await getLevel(e.user)).level;

             if (e.user.account !== e.replyTo.sender && !isUploadChannel && userLevel <= 10) {
                 console.log(`[PARSER] Permission denied: ${e.user.account} tried to !w message from ${e.replyTo.sender} in non-upload channel ${e.channelid}`);
                 await e.reply("You can only !w your own messages in this room.");
                 return false;
             }

             // Native Matrix Download Path
             if (e.replyTo.mxcUrl) {
                 console.log(`[PARSER] Triggering native Matrix download for ${e.replyTo.mxcUrl}`);
                 links.push(e.replyTo.mxcUrl);
             } 
             // Fallback to URL if no MXC (shouldn't happen for media) or text links
             else if (e.replyTo.url) {
                 links.push(e.replyTo.url);
             } else if (e.replyTo.message) {
                 const replyLinks = e.replyTo.message.match(regex.all)?.filter(link => !link.includes(cfg.main.url.domain));
                 if (replyLinks) links.push(...replyLinks);
             }
        }
      }

      console.log(`[PARSER DEBUG] Final links count: ${links.length}`, links);
      if (links.length === 0) {
        console.log(`[PARSER DEBUG] No links found, aborting.`);
        return false;
      }
      
      console.log(`[PARSER DEBUG] Proceeding with links:`, links);

      if (e.message.match(/\!i(gnore)?\b/)) {
        console.log(`[PARSER DEBUG] Ignored due to !ignore flag.`);
        return false;
      }

      // Check for !w command
      const isWCommand = e.message.match(/\!w(0bm)?\b/i);

      // Matrix-specific: enforce strict !w format
      let matrixRating = null; // 'sfw' or 'nsfw'
      let matrixTags = [];     // user-provided tags
      let isNSFW = false;
      if (isWCommand && e.type === 'matrix') {
        const msgLower = e.message.toLowerCase();
        const hasSfw = /(?:^|\s)-sfw\b/i.test(msgLower);
        const hasNsfw = /(?:^|\s)-nsfw\b/i.test(msgLower);
        console.log(`[PARSER DEBUG] Matrix Flags: hasSfw=${hasSfw}, hasNsfw=${hasNsfw}, msg='${msgLower}'`);
        const hasRating = hasSfw || hasNsfw;
        const tagMatch = e.message.match(/-t\s+([^\s].+)/i);
        const hasTags = !!tagMatch;

        // Bare !w with no arguments → show help
        if (!hasRating && !hasTags) {
          await e.reply(`!w -sfw/nsfw -t tag1,tag2,tag3 (at least ${getMinTags()} tags required)`);
          return false;
        }

        // Both ratings specified
        if (hasSfw && hasNsfw) {
          await e.reply('pick one: -sfw or -nsfw, not both');
          return false;
        }

        // Missing rating
        if (!hasRating) {
          await e.reply('missing rating: !w -sfw/nsfw -t tag1,tag2,tag3');
          return false;
        }

        // Parse rating
        matrixRating = hasNsfw ? 'nsfw' : 'sfw';
        if (hasNsfw) isNSFW = true;

        const minTags = getMinTags();
        
        // Tag parsing: try -t first, then fallback to everything after flags
        let tagsInput = "";
        if (tagMatch) {
          tagsInput = tagMatch[1];
        } else {
          // Remove links, !w and -sfw/nsfw to get tags
          tagsInput = e.message.replace(regex.all, "")
                               .replace(/\!w(0bm)?\b/i, "")
                               .replace(/\s*-(nsfw|sfw)\b/gi, "")
                               .replace(/\s*-t\b/gi, "")
                               .trim();
        }

        // Split by commas only to support multi-word tags
        matrixTags = tagsInput.split(',').map(t => t.trim()).filter(t => t.length > 0);
        
        if (matrixTags.length < minTags) {
          await e.reply(`at least ${minTags} tags required (got ${matrixTags.length}): !w -sfw/nsfw tag1, tag2, tag3`);
          return false;
        }
      }

      // Fix for Discord/non-TG clients where e.raw might be different or undefined
      const isForwarded = e.raw?.forward_from !== undefined;
      const mediaGroupId = e.raw?.media_group_id;

      if ((e.type === 'matrix' || !e.channel.includes("w0bm")) && (!isWCommand && !isForwarded)) {
         console.log(`[PARSER DEBUG] Channel/Client check failed. Channel: ${e.channel}, Type: ${e.type}, IsW: ${!!isWCommand}`);
         return false; 
      }

      // --- LINKED ACCOUNT CHECK ---
      let websiteUser = null;
      
      if (e.type === 'matrix' || e.type === 'discord') {
          // Identify lookup key
          // Matrix: Use unique ID (MXID)
          // Discord: Use Nick or Username (Legacy) - TODO: Migration to ID recommended later
          let lookupAlias = e.user.nick || e.user.username; 
          let lookupType = 'discord'; // default check
          
          if (e.type === 'matrix') {
              lookupAlias = e.user.account; // MXID
              lookupType = 'matrix';
          }

          // Check DB
          try {
             // We check type match OR null type (legacy discord)
             const linked = (await db`
                SELECT "user".id, "user"."user" 
                FROM user_alias 
                JOIN "user" ON "user".id = user_alias.userid 
                WHERE lower(user_alias.alias) = lower(${lookupAlias})
                AND (user_alias.type = ${lookupType} OR user_alias.type IS NULL)
             `);
             
             if (linked && linked.length > 0) {
                 websiteUser = linked[0];
                 console.log(`[PARSER] Linked account found: ${websiteUser.user} (ID: ${websiteUser.id})`);
             }
          } catch(err) {
              console.error('[PARSER] DB Link check error:', err);
          }

          // Enforce Link for !w command
          if (isWCommand && !websiteUser) {
              await e.reply(`You must link your account to use this command. Go to ${cfg.main.url.full}/settings to link your ${e.type} account.`);
              return false;
          }
      }
      // -----------------------------

      // Restrict Discord uploads to specific channel if configured
      if (e.type === 'discord') {
        const discordClient = cfg.clients.find(c => c.type === 'discord');
        const allowedChannel = discordClient?.upload_channel_id;
        if (allowedChannel && e.channelid !== allowedChannel) {
          return false;
        }
      }

      if (e.type === 'tg' && // proto: tg
        !isWCommand && // !w / !w0bm
        !e.raw?.forward_date && // is forwarded?
        !mediagroupids.has(mediaGroupId) // prepared mediagroup?
      ) {
        return false;
      }
      else if (mediaGroupId && isWCommand) {
        mediagroupids.add(mediaGroupId);
      }

      console.log(`parsing ${links.length} link${links.length > 1 ? "s" : ""}...`);
      
      // Use for..of to handle async await properly and serialize debugging
      for (const link of links) {
        console.log(`[PARSER LOOP] Processing link: ${link}`);
        // check repost (link)
        try {
            repost = await queue.checkrepostlink(link);
        } catch (e) {
            console.error(`[PARSER LOOP] Checkrepost failed:`, e);
        }
        
        if (repost) {
            await e.reply(`repost motherf0cker (link): ${cfg.main.url.full}/${repost}`);
            continue;
        }

        console.log(`[PARSER LOOP] Repost check passed. Gen UUID...`);
        // generate uuid
        const uuid = await queue.genuuid();

        const maxfilesize = (getLevel(e.user).level > 50 ? cfg.main.maxfilesize * cfg.main.adminmultiplier : cfg.main.maxfilesize);
        const proxyArgs = (cfg.main.socks && cfg.main.socks !== 'undefined') ? ['--proxy', cfg.main.socks] : [];
        const ytdlpArgs = ['--js-runtimes', 'node', '--geo-bypass', '--extractor-args', 'youtube:player-client=ios,web'];

        console.log(`[PARSER LOOP] Reading metadata...`);
        // read metadata
        let ext;
        let lastErr = null;
        if (link.startsWith('mxc://')) {
             // Native Matrix download, skip metadata fetch
             // Priority 1: use mimetype from current event or replyTo
             const mxcMime = e.replyTo?.mimetype || e.mimetype || null;
             if (mxcMime && cfg.mimes[mxcMime]) {
                 ext = cfg.mimes[mxcMime];
             } else {
                 // Priority 2: extract extension from original filename
                 const fname = e.replyTo?.filename || e.filename || '';
                 const fnExt = fname.includes('.') ? fname.split('.').pop().toLowerCase() : '';
                 ext = (fnExt && Object.values(cfg.mimes).includes(fnExt)) ? fnExt : 'bin';
             }
             console.log(`[PARSER] mxc:// mime=${mxcMime}, filename=${e.replyTo?.filename || e.filename}, resolved ext=${ext}`);
        }
        else if (link.match(regex.ph)) {
          // is pornhub
          isNSFW = true;
          try {
            // Added referer to help with fragment 404s and metadata extraction
            const out = await queue.spawn('yt-dlp', [...ytdlpArgs, '--referer', 'https://www.pornhub.com', '--no-progress', '--no-warnings', '--user-agent', pcUA, '--skip-download', '--dump-json', link]);
            const meta = extractJSON(out.stdout);
            ext = meta.ext;
            console.log(`[PARSER DEBUG] Pornhub metadata success. Ext: ${ext}`);
          } catch (err) {
            console.error(`[METADATA ERROR] Pornhub yt-dlp failed for ${link}:`, err.message);
            if (err.stderr) console.error(`[METADATA ERROR] stderr:`, err.stderr);
            lastErr = err;
            try {
                const headFetch = await fetch(link, { 
                  method: "HEAD",
                  headers: { 'User-Agent': pcUA }
                });
                const tmphead = headFetch.headers["content-type"];
                const status = headFetch.status || headFetch.statusCode || (headFetch.res ? headFetch.res.statusCode : 'unknown');
                console.log(`[PARSER DEBUG] Fallback fetch for ${link} (Status: ${status}): ${tmphead}`);
                ext = cfg.mimes[tmphead];
            } catch(fErr) {
                console.error(`[METADATA ERROR] Fallback fetch failed for ${link}:`, fErr.message);
            }
          }
        }
        else if (link.match(regex.instagram)) {
          // is instagram
          try {
            const out = await queue.spawn('yt-dlp', [...proxyArgs, ...ytdlpArgs, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w', '--skip-download', '--dump-json', link]);
            const meta = extractJSON(out.stdout);
            ext = meta.ext;
          } catch (err) {
            console.error(`[METADATA ERROR] Instagram yt-dlp failed for ${link}:`, err.message);
            lastErr = err;
            const tmphead = (await fetch(link, { method: "HEAD" })).headers["content-type"];
            ext = cfg.mimes[tmphead];
          }
        }
        else if (link.match(regex.imgur)) {
          // is imgur
          try {
            const out = await queue.spawn('yt-dlp', [...proxyArgs, ...ytdlpArgs, '--skip-download', '--dump-json', link]);
            const meta = extractJSON(out.stdout);
            ext = meta.ext;
          } catch (err) {
            console.error(`[METADATA ERROR] Imgur yt-dlp failed for ${link}:`, err.message);
            lastErr = err;
            
            // Fallback: Check MIME via curl (more robust than fetch for blocked direct links)
            try {
                let referer = link;
                try {
                    const parsedUrl = new URL(link);
                    let host = parsedUrl.hostname;
                    if (host.includes('imgur.com')) host = 'imgur.com';
                    referer = `${parsedUrl.protocol}//${host}/`;
                } catch(e) {}

                const curlArgs = ['-I', '-s', '-f', '-L', '--user-agent', pcUA, '--referer', referer, link];
                if (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') {
                    const proxyHost = cfg.main.socks.includes('://') ? cfg.main.socks.split('://')[1] : cfg.main.socks;
                    curlArgs.push('--socks5-hostname', proxyHost);
                }
                const headOut = await queue.spawn('curl', curlArgs);
                const contentTypeMatch = headOut.stdout.match(/content-type:\s*([^\r\n]+)/i);
                if (contentTypeMatch) {
                    const tmphead = contentTypeMatch[1].trim();
                    ext = cfg.mimes[tmphead];
                    if (ext) {
                        console.log(`[PARSER DEBUG] Imgur Metadata Fallback (curl) success: ${tmphead} -> ${ext}`);
                    } else {
                        console.warn(`[PARSER DEBUG] Imgur Metadata Fallback (curl) unsupported MIME: "${tmphead}"`);
                    }
                }
            } catch(fErr) {
                console.error(`[METADATA ERROR] Imgur Fallback curl failed for ${link}:`, fErr.message);
            }
          }
        }
        else if (link.match(regex.yt)) {
          try {
            const out = await queue.spawn('yt-dlp', [...proxyArgs, ...ytdlpArgs, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w', '-I', '1', '--skip-download', '--dump-json', link]);
            const meta = extractJSON(out.stdout);
            ext = meta.ext;
          } catch (err) {
            console.error(`[METADATA ERROR] YouTube yt-dlp failed for ${link}:`, err.message);
            lastErr = err;
            const tmphead = (await fetch(link, { method: "HEAD" })).headers["content-type"];
            ext = cfg.mimes[tmphead];
          }
        }
        else if (link.match(regex.fourchan)) {
          try {
            const out = await queue.spawn('yt-dlp', [...proxyArgs, ...ytdlpArgs, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w', '--skip-download', '--dump-json', link]);
            const meta = extractJSON(out.stdout);
            ext = meta.ext;
          } catch (err) {
            console.error(`[METADATA ERROR] 4chan yt-dlp failed for ${link}:`, err.message);
            lastErr = err;
            const tmphead = (await fetch(link, { method: "HEAD" })).headers["content-type"];
            ext = cfg.mimes[tmphead];
          }
        }
        else {
          try {
            const out = await queue.spawn('yt-dlp', [...ytdlpArgs, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w', '--skip-download', '--dump-json', link]);
            const meta = extractJSON(out.stdout);
            ext = meta.ext;
          } catch (err) {
            console.error(`[METADATA ERROR] General yt-dlp failed for ${link}:`, err.message);
            if (err.stderr) console.error(`[METADATA ERROR] stderr:`, err.stderr);
            const errorMsg = `something went wrong lol`.slice(0, 1024);
            if (e.type == 'tg')
              return await e.editMessageText(msg.result.chat.id, msg.result.message_id, errorMsg);
            return await e.reply(errorMsg);
          }
        }

        if (!Object.values(cfg.mimes).includes(ext?.toLowerCase()) && !link.startsWith('mxc://')) {
          const errMsg = `lol, go f0ck yourself (mime schmime: ${ext || 'undefined'} for ${link})`.slice(0, 1024);
          await e.reply(errMsg);
          console.error(`[PARSER] Mime check failed for ${link}. Detected ext: ${ext}`);
          return;
        }

        const msg = await e.reply(`[charging my lazor] downloading`, {
          disable_notification: true
        });

        // <download data>
        const start = new Date();
        console.log(`[PARSER] Downloading ${link}...`);
        let source;

        if (link.startsWith('mxc://')) {
          try {
              console.log(`[PARSER] Handling Native Matrix Download: ${link}`);
              const buffer = await e.self.download(link);
              console.log(`[PARSER] Downloaded ${buffer.length} bytes`);

              // ext was resolved above from replyTo.mimetype; use it for the temp file so
              // downstream MIME detection (via 'file') also works on non-.bin files naturally.
              const tmpExt = (ext && ext !== 'bin') ? ext : 'bin';
              const destPath = path.join(cfg.paths.tmp, `${uuid}.${tmpExt}`);
              await fs.promises.writeFile(destPath, buffer);
              source = destPath;
          } catch(err) {
               console.error('Matrix native dl error:', err);
               return await e.reply(`Matrix download failed: ${err.message}`);
          }
        }
        else if (link.match(regex.ph)) {
          try {
            // Added referer to fix fragment 404 errors, removed -vU to avoid exit code 100
            source = (await queue.spawn('yt-dlp', [...proxyArgs, '--no-playlist', '--referer', 'https://www.pornhub.com', '--user-agent', pcUA, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w', link, '--max-filesize', `${maxfilesize / 1024}k`, '--postprocessor-args', 'ffmpeg:-bitexact', '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`), '--print', 'after_move:filepath', '--merge-output-format', 'mp4'])).stdout.trim();
          } catch (err) {
            console.error('Pornhub dl error:', err);
            const errorMsg = `something went wrong lol`.slice(0, 1024);
            if (e.type == 'tg')
              return await e.editMessageText(msg.result.chat.id, msg.result.message_id, errorMsg);
            return await e.reply(errorMsg);
          }
        }
        else if (link.match(regex.instagram)) {
          try {
            source = (await queue.spawn('yt-dlp', [...proxyArgs, ...ytdlpArgs, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w', link, '--max-filesize', `${maxfilesize / 1024}k`, '--postprocessor-args', 'ffmpeg:-bitexact', '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`), '--print', 'after_move:filepath', '--merge-output-format', 'mp4'])).stdout.trim();
          } catch (err) {
            console.error('Instagram dl error:', err);
            const errorMsg = `something went wrong lol`.slice(0, 1024);
            if (e.type == 'tg')
              return await e.editMessageText(msg.result.chat.id, msg.result.message_id, errorMsg);
            return await e.reply(errorMsg);
          }
        }
        else if (link.match(regex.imgur)) {
          try {
            source = (await queue.spawn('yt-dlp', [...proxyArgs, ...ytdlpArgs, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / b[height<=1080]', link, '--max-filesize', `${maxfilesize / 1024}k`, '--postprocessor-args', 'ffmpeg:-bitexact', '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`), '--print', 'after_move:filepath', '--merge-output-format', 'mp4'])).stdout.trim();
          } catch (err) {
            console.warn(`[PARSER] Imgur Stage 1 (yt-dlp) failed: ${err.message}. Retrying with curl...`);
            
            // Stage 2: Robust curl fallback (same as API upload logic)
            try {
                const fallbackTmp = path.join(cfg.paths.tmp, `${uuid}.tmp`);
                let referer = link;
                try {
                    const parsedUrl = new URL(link);
                    let host = parsedUrl.hostname;
                    if (host.includes('imgur.com')) host = 'imgur.com';
                    referer = `${parsedUrl.protocol}//${host}/`;
                } catch(e) {}

                const curlArgs = [
                    '-s', '-f', '-L', link, '-o', fallbackTmp,
                    '--max-filesize', `${maxfilesize}`,
                    '--connect-timeout', '30',
                    '--max-time', '300',
                    '--user-agent', pcUA,
                    '--referer', referer,
                    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    '-H', 'Accept-Language: en-US,en;q=0.9'
                ];
                
                if (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') {
                    const proxyHost = cfg.main.socks.includes('://') ? cfg.main.socks.split('://')[1] : cfg.main.socks;
                    curlArgs.push('--socks5-hostname', proxyHost);
                }

                await queue.spawn('curl', curlArgs);

                // Detect MIME and rename
                const fallbackMime = (await queue.spawn('file', ['--mime-type', '-b', fallbackTmp])).stdout.trim();
                const extension = cfg.mimes[fallbackMime];
                
                if (extension) {
                    const finalPath = path.join(cfg.paths.tmp, `${uuid}.${extension}`);
                    await fs.promises.rename(fallbackTmp, finalPath);
                    source = finalPath;
                    console.log(`[PARSER] Imgur Stage 2 (curl) success: ${source} (${fallbackMime})`);
                } else {
                    if (fallbackMime === 'text/html') {
                        const content = (await fs.promises.readFile(fallbackTmp)).toString().substring(0, 500);
                        console.warn(`[PARSER] Imgur fallback received HTML instead of media. Start of content: "${content}"`);
                    }
                    console.error(`[PARSER] Imgur fallback downloaded unsupported MIME type: "${fallbackMime}" from ${link}`);
                    await fs.promises.unlink(fallbackTmp).catch(() => {});
                    throw new Error(`Unsupported fallback MIME: ${fallbackMime}`);
                }
            } catch (fallbackErr) {
                console.error(`[PARSER] All Imgur download stages failed for ${link}:`, fallbackErr.message);
                const errorMsg = `something went wrong lol`.slice(0, 1024);
                if (e.type == 'tg')
                  return await e.editMessageText(msg.result.chat.id, msg.result.message_id, errorMsg);
                return await e.reply(errorMsg);
            }
          }
        }
        else if (link.match(regex.yt)) {
          try {
            source = (await queue.spawn('yt-dlp', [...proxyArgs, ...ytdlpArgs, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w', link, '-I', '1', '--max-filesize', `${maxfilesize / 1024}k`, '--postprocessor-args', 'ffmpeg:-bitexact', '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`), '--print', 'after_move:filepath', '--merge-output-format', 'mp4'])).stdout.trim();
          } catch (err) {
            console.error('YouTube dl error:', err);
            const errorMsg = `something went wrong lol`.slice(0, 1024);
            if (e.type == 'tg')
              return await e.editMessageText(msg.result.chat.id, msg.result.message_id, errorMsg);
            return await e.reply(errorMsg);
          }
        }
        else if (link.match(regex.fourchan)) {
          try {
            source = (await queue.spawn('yt-dlp', [...proxyArgs, ...ytdlpArgs, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w', link, '--max-filesize', `${maxfilesize / 1024}k`, '--postprocessor-args', 'ffmpeg:-bitexact', '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`), '--print', 'after_move:filepath', '--merge-output-format', 'mp4'])).stdout.trim();
          } catch (err) {
            console.error('4chan dl error:', err);
            const errorMsg = `something went wrong lol`.slice(0, 1024);
            if (e.type == 'tg')
              return await e.editMessageText(msg.result.chat.id, msg.result.message_id, errorMsg);
            return await e.reply(errorMsg);
          }
        }
        else {
          try {
            source = (await queue.spawn('yt-dlp', [...ytdlpArgs, '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w', link, '--max-filesize', `${maxfilesize / 1024}k`, '--postprocessor-args', 'ffmpeg:-bitexact', '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`), '--print', 'after_move:filepath', '--merge-output-format', 'mp4'])).stdout.trim();
          } catch (err) {
            console.error('General dl error:', err);
            const errorMsg = `something went wrong lol`.slice(0, 1024);
            if (e.type == 'tg')
              return await e.editMessageText(msg.result.chat.id, msg.result.message_id, errorMsg);
            return await e.reply(errorMsg);
          }
        }

        if (!source) {
          if (e.type == 'tg')
            return await e.editMessageText(msg.result.chat.id, msg.result.message_id, "something went wrong lol");
          return await e.reply("something went wrong lol");
        }

        if (source.match(/larger than/)) {
          if (e.type == 'tg')
            return await e.editMessageText(msg.result.chat.id, msg.result.message_id, "too large lol");
          return await e.reply("too large lol");
        }
        const end = ~~((new Date() - start) / 1e3);

        // filesize check
        const size = fs.statSync(source).size;
        if (size > maxfilesize) {
          await fs.promises.unlink(source).catch(_ => { });
          if (e.type == 'tg')
            return await e.editMessageText(msg.result.chat.id, msg.result.message_id, `too large lol. (${lib.formatSize(size)} / ${lib.formatSize(maxfilesize)})`);
          return await e.reply(`too large lol. (${lib.formatSize(size)} / ${lib.formatSize(maxfilesize)})`);
        }

        // mime check
        let mime = (await queue.spawn('file', ['--mime-type', '-b', source])).stdout.trim();
        console.log(`[PARSER] Downloaded. MIME: ${mime}`);
        try {
          if (mime == 'video/x-matroska') { // mkv failsafe
            await queue.spawn('ffmpeg', ['-i', path.join(cfg.paths.tmp, `${uuid}.mkv`), '-codec', 'copy', path.join(cfg.paths.tmp, `${uuid}.mp4`)]);
            await fs.promises.unlink(source).catch(_ => { });
            source = source.replace(/\.mkv$/, '.mp4');
            mime = 'video/mp4';
          }
          if (source.match(/\.opus$/)) { // opus failsafe
            await queue.spawn('ffmpeg', ['-i', path.join(cfg.paths.tmp, `${uuid}.opus`), '-codec', 'copy', path.join(cfg.paths.tmp, `${uuid}.ogg`)]);
            await fs.promises.unlink(source);
            source = source.replace(/\.opus$/, '.ogg');
            mime = 'audio/ogg';
          }
        } catch (err) {
          await fs.promises.unlink(source).catch(_ => { });
          if (e.type == 'tg')
            return await e.editMessageText(msg.result.chat.id, msg.result.message_id, "something went wrong lol");
          return await e.reply("something went wrong lol");
        }

        if (!Object.keys(cfg.mimes).includes(mime)) {
          await fs.promises.unlink(source).catch(_ => { });
          if (e.type == 'tg')
            return await e.editMessageText(msg.result.chat.id, msg.result.message_id, `lol, go f0ck yourself (${mime})`);
          return await e.reply(`lol, go f0ck yourself (${mime})`);
        }

        // generate checksum
        const checksum = (await queue.spawn('sha256sum', [source])).stdout.trim().split(" ")[0];

        // check repost (checksum)
        repost = await queue.checkrepostsum(checksum);
        if (repost) {
          console.log(`[PARSER] Checksum match found: ${repost}`);
        }

        // PHash check (if strict checksum passed)
        let phash = null;
        if (!repost) {
          console.log(`[PARSER] Checksum valid. Generating PHash...`);
          phash = await queue.generatePHash(source);
          if (phash) {
            console.log(`[PARSER] PHash generated (Temporal). Length: ${phash.length}`);
            console.log(`[PARSER] Checking PHash against database...`);
            const phashMatch = await queue.checkrepostphash(phash);
            if (phashMatch) {
              repost = phashMatch;
              console.log(`[PARSER] PHash match found: ${repost} (Visual duplicate)`);
            } else {
              console.log(`[PARSER] No PHash duplicates found.`);
            }
          } else {
            console.log(`[PARSER] Failed to generate PHash.`);
          }
        }

        if (repost) {
          await fs.promises.unlink(source).catch(_ => { });
          if (e.type == 'tg')
            return await e.editMessageText(msg.result.chat.id, msg.result.message_id, `repost motherf0cker (checksum): ${cfg.main.url.full}/${repost}`);

          if (e.type === 'discord') {
            // For Discord, we EDIT the original "charging" message
            // This ensures buttons are never shown because we return early
            return await msg.edit(`repost motherf0cker (checksum): ${cfg.main.url.full}/${repost}`);
          }

          return await e.reply(`repost motherf0cker (checksum): ${cfg.main.url.full}/${repost}`);
        }

        const filename = path.basename(source);

        let speed = lib.calcSpeed(size, end);
        speed = !Number.isFinite(speed) ? "yes" : `${speed.toFixed(2)} Mbit/s`;

        const manualApproval = getManualApproval();
        let outputmsgirc = `${manualApproval ? '[approval pending] ' : ''}size: ${lib.formatSize(size)} | speed: ${speed}`;

        if (e.type == 'tg') {
          // Telegram Logic
          const tgDestDir = manualApproval ? path.join(cfg.paths.pending, 'b') : cfg.paths.b;
          await fs.promises.copyFile(source, path.join(tgDestDir, filename));
          await fs.promises.unlink(source).catch(_ => { });

          await db`
            insert into items ${db({
            src: e.media ? "" : link,
            dest: filename,
            mime: mime,
            size: size,
            checksum: checksum,
            phash: phash,
            username: websiteUser ? websiteUser.user : (e.user.username || e.user.nick),
            userchannel: e.channel,
            usernetwork: e.network,
            stamp: ~~(new Date() / 1000),
            active: !getManualApproval()
          }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active')}
          `;
          const itemid = await queue.getItemID(filename);

          // Auto-subscribe uploader
          try {
            if (websiteUser?.id) {
              await db`
                INSERT INTO comment_subscriptions (user_id, item_id)
                VALUES (${websiteUser.id}, ${itemid})
                ON CONFLICT DO NOTHING
              `;
              console.log(`[PARSER] Auto-subscribed user ${websiteUser.id} to item ${itemid}`);
            }
          } catch (err) {
            console.error('[PARSER] Failed to auto-subscribe uploader:', err);
          }

          // Generate Thumbnail
          try {
            await queue.genThumbnail(filename, mime, itemid, link, manualApproval);
            if (isNSFW) await queue.genBlurredThumbnail(itemid, manualApproval);
          } catch (err) {
            const tDir = manualApproval ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
            await queue.spawn('magick', ['./mugge.png', path.join(tDir, `${itemid}.webp`)]);
          }

          // Notify Admins
          if (manualApproval) await queue.notifyAdmins(itemid);

          // Notify Matrix Channel
          try {
            const matrixCfg = cfg.clients.find(c => c.type === 'matrix');
            if (matrixCfg?.notification_channel_id && bot.bot?.clients) {
              const matrixWrapper = bot.bot.clients.find(c => c.type === 'matrix');
              if (matrixWrapper?.client) {
                const matrixMsg = `${websiteUser ? websiteUser.user : (e.user.username || e.user.nick)} uploaded a new video ${cfg.main.url.full}/${itemid}`;
                await matrixWrapper.client.send(matrixCfg.notification_channel_id, matrixMsg);
                console.log(`[PARSER] Matrix notification sent for item ${itemid}`);
              }
            }
          } catch (err) {
            console.error('[PARSER] Matrix notification error:', err);
          }

          await e.deleteMessage(msg.result.chat.id, msg.result.message_id);
          await e.reply(`${outputmsgirc} | link: ${cfg.main.url.full}/${itemid}`);
        }
        else {
            // General Logic (IRC, Matrix, Slack, Legacy/No-JS Discord)
            const genDestDir = manualApproval ? path.join(cfg.paths.pending, 'b') : cfg.paths.b;
            await fs.promises.copyFile(source, path.join(genDestDir, filename));
            await fs.promises.unlink(source).catch(_ => { });

            await db`
              insert into items ${db({
              src: e.media ? "" : link,
              dest: filename,
              mime: mime,
              size: size,
              checksum: checksum,
              phash: phash,
              username: websiteUser ? websiteUser.user : (e.user.nick || e.user.username),
              userchannel: e.channel,
              usernetwork: e.network,
              stamp: ~~(new Date() / 1000),
              active: !getManualApproval()
            }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active')}
            `;
            const itemid = await queue.getItemID(filename);

            // Auto-subscribe uploader
            try {
              if (websiteUser?.id) {
                await db`
                  INSERT INTO comment_subscriptions (user_id, item_id)
                  VALUES (${websiteUser.id}, ${itemid})
                  ON CONFLICT DO NOTHING
                `;
                console.log(`[PARSER] Auto-subscribed user ${websiteUser.id} to item ${itemid}`);
              }
            } catch (err) {
              console.error('[PARSER] Failed to auto-subscribe uploader:', err);
            }

            // Matrix: assign rating + user tags
            if (e.type === 'matrix' && matrixRating && matrixTags.length >= getMinTags()) {
              try {
                const userId = websiteUser ? websiteUser.id : 1;

                // Assign rating tag (sfw=1, nsfw=2)
                const ratingTagId = matrixRating === 'sfw' ? 1 : 2;
                await db`
                  insert into "tags_assign" ${db({
                    tag_id: ratingTagId,
                    item_id: itemid,
                    user_id: userId
                  })}
                `;

                // Assign user-provided tags
                for (const tagName of matrixTags) {
                  let tagid;
                  const tag_exists = await db`
                    select id from "tags" where tag = ${tagName}
                  `;
                  if (tag_exists.length === 0) {
                    tagid = (await db`
                      insert into "tags" ${db({ tag: tagName })}
                      returning id
                    `)[0].id;
                  } else {
                    tagid = tag_exists[0].id;
                  }
                  await db`
                    insert into "tags_assign" ${db({
                      tag_id: tagid,
                      item_id: itemid,
                      user_id: userId
                    })}
                  `;
                }
                console.log(`[PARSER] Matrix tags assigned: ${matrixRating}, [${matrixTags.join(', ')}] to item ${itemid}`);
              } catch (err) {
                console.error('[PARSER] Failed to assign Matrix tags:', err);
              }
            }

            // Generate Thumbnail
            try {
              await queue.genThumbnail(filename, mime, itemid, link, manualApproval);
              if (isNSFW) await queue.genBlurredThumbnail(itemid, manualApproval);
            } catch (err) {
              const tDir = manualApproval ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
              await queue.spawn('magick', ['./mugge.png', path.join(tDir, `${itemid}.webp`)]);
            }

            // Notify Admins
            if (manualApproval) await queue.notifyAdmins(itemid);

            // Notify Matrix Channel
            try {
              const matrixCfg = cfg.clients.find(c => c.type === 'matrix');
              if (matrixCfg?.notification_channel_id && bot.bot?.clients) {
                const matrixWrapper = bot.bot.clients.find(c => c.type === 'matrix');
                if (matrixWrapper?.client) {
                  const matrixMsg = `${websiteUser ? websiteUser.user : (e.user.nick || e.user.username)} uploaded a new video ${cfg.main.url.full}/${itemid}`;
                  await matrixWrapper.client.send(matrixCfg.notification_channel_id, matrixMsg);
                  console.log(`[PARSER] Matrix notification sent for item ${itemid}`);
                }
              }
            } catch (err) {
              console.error('[PARSER] Matrix notification error:', err);
            }

            await e.reply(outputmsgirc);
        }
      }
    }
  }];
};
