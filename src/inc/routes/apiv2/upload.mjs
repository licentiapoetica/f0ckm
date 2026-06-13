import { promises as fs } from "fs";
import db from '../../sql.mjs';
import lib from '../../lib.mjs';
import cfg from '../../config.mjs';
import { applyWordFilter } from '../../wordfilter.mjs';
import queue from '../../queue.mjs';
import path from "path";

// Native multipart form data parser
const parseMultipart = (buffer, boundary) => {
    const parts = {};
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const segments = [];

    let start = 0;
    let idx;

    while ((idx = buffer.indexOf(boundaryBuffer, start)) !== -1) {
        if (start !== 0) {
            segments.push(buffer.slice(start, idx - 2)); // -2 for \r\n before boundary
        }
        start = idx + boundaryBuffer.length + 2; // +2 for \r\n after boundary
    }

    for (const segment of segments) {
        const headerEnd = segment.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headers = segment.slice(0, headerEnd).toString();
        const body = segment.slice(headerEnd + 4);

        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

        if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
                parts[name] = {
                    filename: filenameMatch[1],
                    contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
                    data: body
                };
            } else {
                parts[name] = body.toString().trim();
            }
        }
    }

    return parts;
};

import { getManualApproval, getMinTags, getBypassDuplicateCheck } from "../../settings.mjs";

// Collect request body as buffer with debug logging
const collectBody = (req) => {
    return new Promise((resolve, reject) => {
        if (cfg.main.development) console.log('[UPLOAD DEBUG] collectBody started');
        const chunks = [];
        req.on('data', chunk => {
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (cfg.main.development) console.log(`[UPLOAD DEBUG] Stream ended. Total size: ${chunks.reduce((acc, c) => acc + c.length, 0)}`);
            resolve(Buffer.concat(chunks));
        });
        req.on('error', err => {
            console.error('[UPLOAD DEBUG] Stream error:', err);
            reject(err);
        });

        // Ensure stream is flowing
        if (req.isPaused()) {
            if (cfg.main.development) console.log('[UPLOAD DEBUG] Stream was paused, resuming...');
            req.resume();
        }
    });
};

export default router => {
    router.group(/^\/api\/v2/, group => {

        const saveComment = async (itemid, userid, content) => {
            if (!content || !content.trim()) return;
            try {
                const filteredContent = await applyWordFilter(content);
                await db`
                    INSERT INTO comments ${db({
                        item_id: itemid,
                        user_id: userid,
                        parent_id: null,
                        content: filteredContent.trim()
                    }, 'item_id', 'user_id', 'parent_id', 'content')}
                `;
            } catch (err) {
                console.error('[UPLOAD] Failed to save upload comment:', err);
            }
        };

        // Find-or-create a tag and assign it to an item (no-op on duplicate)
        const assignTag = async (itemid, tagName, userId) => {
            try {
                let tagRow = await db`select id from tags where normalized = slugify(${tagName}) limit 1`;
                if (tagRow.length === 0) {
                    await db`insert into tags ${db({ tag: tagName }, 'tag')}`;
                    tagRow = await db`select id from tags where normalized = slugify(${tagName}) limit 1`;
                }
                const tagId = tagRow[0].id;
                await db`insert into tags_assign ${db({ item_id: itemid, tag_id: tagId, user_id: userId })} on conflict do nothing`;
            } catch (err) {
                console.error(`[UPLOAD] Failed to assign tag "${tagName}":`, err);
            }
        };

        // Derive automatic tags from a URL:
        //   - registered domain  (e.g. "barkaka.net" from "www.foo.barkaka.net")
        //   - "youtube" for YouTube URLs
        const autoTagsFromUrl = (urlString) => {
            const tags = [];
            try {
                const { hostname } = new URL(urlString);
                // Strip port if present
                const host = hostname.replace(/:\d+$/, '').toLowerCase();
                const parts = host.split('.');

                // Known short second-level domains (add more as needed)
                const shortSlds = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne']);

                let domain;
                if (parts.length >= 3 && shortSlds.has(parts[parts.length - 2])) {
                    // e.g. foo.co.uk  → co.uk is the tld → registered = foo.co.uk
                    domain = parts.slice(-3).join('.');
                } else {
                    // Normal: strip all subdomains, keep last two labels
                    domain = parts.slice(-2).join('.');
                }

                if (domain) tags.push(domain);

                // YouTube-specific tag
                if (/(?:youtube\.com|youtu\.be)$/i.test(domain) || /(?:youtube\.com|youtu\.be)$/i.test(host)) {
                    tags.push('youtube');
                }
            } catch (e) {
                // Malformed URL — skip auto-tags
            }
            return [...new Set(tags)];
        };

        group.get(/\/meta\/extract-url$/, lib.loggedin, async (req, res) => {
            const url = req.url.qs?.url;
            if (!url) return res.json({ success: false, msg: 'URL required' }, 400);

            try {
                const results = [];
                const seen = new Set();
                const addResult = (val) => {
                    if (!val) return;
                    const clean = String(val).replace(/<[^>]*>/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim();
                    if (clean && clean.length > 1 && clean.length <= 255 && !seen.has(clean.toLowerCase())) {
                        seen.add(clean.toLowerCase());
                        results.push(clean);
                    }
                };

                // Add domain and auto-tags
                const auto = autoTagsFromUrl(url);
                auto.forEach(t => addResult(t));

                // Try to get title via yt-dlp for supported sites
                try {
                    const proxyArgs = (cfg.main.socks && cfg.main.socks !== 'undefined') ? ['--proxy', cfg.main.socks] : [];
                    const { stdout } = await queue.spawn('yt-dlp', [
                        ...proxyArgs,
                        '--get-title',
                        '--get-description',
                        '--no-playlist',
                        '--skip-download',
                        url
                    ], { quiet: true, timeout: 5000 });
                    
                    if (stdout) {
                        const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                        if (lines[0]) addResult(lines[0]); // Title
                        if (lines[1]) {
                            // Description often has garbage, take only first line or short snippet
                            const desc = lines[1].split(/[.\n]/)[0].trim();
                            if (desc.length > 3) addResult(desc);
                        }
                    }
                } catch (e) {
                    // Fallback or ignore
                }

                return res.json({ success: true, fields: results });
            } catch (err) {
                return res.json({ success: false, msg: err.message }, 500);
            }
        });

        group.post(/\/upload-url$/, lib.loggedin, async (req, res) => {
            try {
                if (!cfg.websrv.web_url_upload) {
                    return res.json({ success: false, msg: 'URL uploads are disabled' }, 403);
                }

                const { url: inputUrl, rating, tags: tagsRaw, comment, is_oc, is_shitpost, title: rawTitle } = req.post || {};
                const title = (rawTitle && typeof rawTitle === 'string' && rawTitle.trim()) ? rawTitle.trim().substring(0, 500) : null;

                const maxLen = cfg.main.comment_max_length;
                if (comment && maxLen !== null && maxLen !== undefined && comment.length > maxLen) {
                    return res.json({ success: false, msg: `Comment too long (max ${maxLen} characters)` }, 400);
                }

                if (!inputUrl || !inputUrl.trim()) {
                    return res.json({ success: false, msg: 'URL is required' }, 400);
                }

                // In shitpost mode rating is optional; null = no rating tag assigned
                const effectiveRating = (rating && ['sfw', 'nsfw', 'nsfl'].includes(rating)) ? rating : (is_shitpost ? null : null);

                if (!is_shitpost && !effectiveRating) {
                    return res.json({ success: false, msg: 'Rating (sfw/nsfw/nsfl) is required' }, 400);
                }
                if (effectiveRating === 'nsfl' && !cfg.enable_nsfl) {
                    return res.json({ success: false, msg: 'NSFL mode is currently disabled' }, 400);
                }
                const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0 && !['sfw', 'nsfw', 'nsfl'].includes(t.toLowerCase())) : [];
                const minTags = getMinTags();
                // In shitpost mode tags are optional; skip entirely when minTags is 0
                if (!is_shitpost && minTags > 0 && tags.length < minTags) {
                    return res.json({ success: false, msg: `At least ${minTags} tag${minTags !== 1 ? 's' : ''} required` }, 400);
                }

                // Upload limit check
                if (!req.session.admin && !req.session.is_moderator) {
                    const twelveHoursAgo = ~~(Date.now() / 1000) - (12 * 3600);
                    const uploadCount = await db`
                        SELECT count(*) as count FROM items
                        WHERE username = ${req.session.user} AND stamp > ${twelveHoursAgo} AND is_deleted = false
                    `;
                    if (parseInt(uploadCount[0].count) >= 69) {
                        return res.json({ success: false, msg: 'Upload limit reached (69 per 12 hours)' }, 429);
                    }
                }

                const url = inputUrl.trim();
                const ytRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\?(?:\S*?&?v\=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;
                const ytMatch = url.match(ytRegex);

                // Check repost by source URL (skip for YouTube — reposts are allowed and harmless)
                if (!ytMatch && !getBypassDuplicateCheck()) {
                    const repostLink = await queue.checkrepostlink(url);
                    if (repostLink) {
                        return res.json({ success: false, msg: 'This URL has already been uploaded', repost: repostLink }, 409);
                    }
                }

                const isApprovalRequired = getManualApproval();

                if (ytMatch && cfg.websrv.enable_youtube_upload !== false) {
                    // ===== YOUTUBE EMBED =====
                    const videoId = ytMatch[1];
                    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

                    // YouTube reposts are allowed — same video can be posted multiple times

                    // Store as a YouTube embed: dest = yt:VIDEO_ID, mime = video/youtube
                    const filename = `yt:${videoId}`;

                    const [{ id: itemid }] = await db`
                        insert into items ${db({
                            src: ytUrl,
                            dest: filename,
                            mime: 'video/youtube',
                            size: 0,
                            checksum: `yt_${videoId}_${Date.now()}`,
                            phash: null,
                            username: req.session.user,
                            userchannel: 'web',
                            usernetwork: 'web',
                            stamp: ~~(Date.now() / 1000),
                            active: !isApprovalRequired,
                            is_oc: !!is_oc,
                            title: title
                        }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active', 'is_oc', 'title')}
                        RETURNING id
                    `;

                    // Auto-subscribe uploader
                    try {
                        await db`INSERT INTO comment_subscriptions (user_id, item_id) VALUES (${req.session.id}, ${itemid}) ON CONFLICT DO NOTHING`;
                    } catch (err) { console.error('[UPLOAD-URL] Auto-subscribe error:', err); }

                    // Download YouTube thumbnail as our thumbnail
                    try {
                        await queue.genThumbnail(filename, 'video/youtube', itemid, ytUrl, isApprovalRequired);
                    } catch (err) {
                        console.error('[UPLOAD-URL] YouTube thumbnail error:', err);
                        const tDir = isApprovalRequired ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
                        await queue.spawn('magick', ['-size', '128x128', 'xc:#1a1a1a', '-gravity', 'center', '-fill', '#666', '-pointsize', '20', '-annotate', '0', 'YouTube', path.join(tDir, `${itemid}.webp`)]).catch(() => {});
                    }

                    // Assign rating tag (only if a rating was selected)
                    if (effectiveRating) {
                        const ratingTagId = effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3));
                        await db`insert into tags_assign ${db({ item_id: itemid, tag_id: ratingTagId, user_id: req.session.id })} on conflict do nothing`;
                        await queue.genBlurredThumbnail(itemid, isApprovalRequired).catch(() => {});
                    }

                    // Assign user tags + auto-tags
                    const autoTags = autoTagsFromUrl(ytUrl); // always includes 'youtube' + 'youtube.com'
                    const allTags = [...new Set([...tags, ...autoTags])];
                    for (const tagName of allTags) {
                        await assignTag(itemid, tagName, req.session.id);
                    }

                    if (isApprovalRequired) await queue.notifyAdmins(itemid).catch(() => {});

                    // Save upload comment
                    await saveComment(itemid, req.session.id, comment);

                    // Assign OC tags if the uploader ticked the OC checkbox
                    if (is_oc) {
                        const ocTags = ['oc', 'original content'];
                        for (const tagname of ocTags) {
                            await assignTag(itemid, tagname, req.session.id);
                        }
                    }

                    return res.json({
                        success: true,
                        msg: isApprovalRequired ? 'YouTube video embedded! Pending admin approval.' : 'YouTube video embedded!',
                        itemid: itemid,
                        manual_approval: isApprovalRequired
                    });
                } else {
                    // ===== REGULAR URL DOWNLOAD (Asynchronous) =====
                    const session = { 
                        id: req.session.id, 
                        user: req.session.user,
                        admin: req.session.admin,
                        is_moderator: req.session.is_moderator,
                        display_name: req.session.display_name
                    };

                    // Return immediately to avoid proxy timeouts
                    res.json({
                        success: true,
                        pending: true,
                        msg: 'URL processing started in background. You will receive a notification when it is finished.'
                    });

                    // Background processing block
                    (async () => {
                        const sanitizeError = (err) => {
                            if (!err) return `Failed to process ${url}`;
                            
                            // Priority 1: meaningful error from stderr (yt-dlp/curl/etc)
                            if (err.stderr) {
                                const stderr = String(err.stderr).trim();
                                
                                // yt-dlp specific patterns
                                const errorMatch = stderr.match(/ERROR:\s*(.+)$/m);
                                if (errorMatch) return errorMatch[1].trim();

                                // curl specific patterns
                                if (stderr.startsWith('curl: ')) return stderr;

                                // Fallback to last meaningful line of stderr
                                const lines = stderr.split('\n').map(l => l.trim()).filter(l => l && !l.includes('WARNING:'));
                                if (lines.length > 0) return lines[lines.length - 1];
                            }
                            
                            const msg = String(err.message || '');
                            
                            // Priority 2: Extract HTTP codes
                            const httpCode = msg.match(/HTTP Error (\d+)/i)?.[1]
                                          || msg.match(/status code (\d{3})/i)?.[1]
                                          || (msg.match(/\b(4\d{2}|5\d{2})\b/)?.[1] !== '537' ? msg.match(/\b(4\d{2}|5\d{2})\b/)?.[1] : null);
                            if (httpCode) return `Download/Process failed (HTTP ${httpCode})`;

                            // Priority 3: Sanitize raw queue.spawn errors
                            if (msg.startsWith('Command \'')) {
                                const match = msg.match(/failed with code (\d+)/);
                                const code = match ? match[1] : '1';
                                return `Process failed (code ${code})`;
                            }

                            return msg || `Failed to process ${url}`;
                        };

                        try {
                            const proxyArgs = (cfg.main.socks && cfg.main.socks !== 'undefined') ? ['--proxy', cfg.main.socks] : [];
                            const ytdlpArgs = ['--js-runtimes', 'node', '--geo-bypass', '--extractor-args', 'youtube:player-client=ios,web'];
                            let maxfilesize = cfg.main.maxfilesize;
                            if (session.admin) maxfilesize = Math.floor(maxfilesize * cfg.main.adminmultiplier);

                            const uuid = await queue.genuuid();
                            const isInstagram = /instagram\.com/i.test(url);

                            const dlError = (err) => sanitizeError(err);

                            let source;
                            console.log(`[UPLOAD-URL-ASYNC] Starting Stage 1 (constrained) download for ${url} (user: ${session.user})`);
                            
                            try {
                                source = (await queue.spawn('yt-dlp', [
                                    ...proxyArgs, ...ytdlpArgs,
                                    '-f', 'bv*[height<=1080]+ba/b[height<=1080] / wv*+ba/w',
                                    url,
                                    '--max-filesize', `${maxfilesize / 1024}k`,
                                    '--postprocessor-args', 'ffmpeg:-bitexact',
                                    '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`),
                                    '--print', 'after_move:filepath',
                                    '--merge-output-format', 'mp4'
                                ])).stdout.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0).pop();
                            } catch (err) {
                                console.warn(`[UPLOAD-URL-ASYNC] Stage 1 failed: ${err.message}`);
                                if (isInstagram) throw new Error(sanitizeError(err));
                                
                                try {
                                    source = (await queue.spawn('yt-dlp', [
                                        ...proxyArgs, ...ytdlpArgs,
                                        url,
                                        '--max-filesize', `${maxfilesize / 1024}k`,
                                        '-o', path.join(cfg.paths.tmp, `${uuid}.%(ext)s`),
                                        '--print', 'after_move:filepath'
                                    ])).stdout.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0).pop();
                                } catch (err2) {
                                    console.warn(`[UPLOAD-URL-ASYNC] Stage 2 failed: ${err2.message}`);
                                    console.log(`[UPLOAD-URL-ASYNC] Starting Stage 3 (curl) fallback for ${url}`);
                                    const fallbackTmp = path.join(cfg.paths.tmp, `${uuid}.tmp`);
                                    let referer = url;
                                    try {
                                        const parsedUrl = new URL(url);
                                        let host = parsedUrl.hostname;
                                        if (host.includes('imgur.com')) host = 'imgur.com';
                                        referer = `${parsedUrl.protocol}//${host}/`;
                                    } catch (e) {}

                                    const curlArgs = [
                                        '-s', '-S', '-f', '-L', url, '-o', fallbackTmp,
                                        '--max-filesize', `${maxfilesize}`,
                                        '--connect-timeout', '30',
                                        '--max-time', '300',
                                        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                        '--referer', referer,
                                        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                                        '-H', 'Accept-Language: en-US,en;q=0.9'
                                    ];
                                    if (cfg.main.socks && cfg.main.socks !== 'undefined' && cfg.main.socks !== '') {
                                        const proxyHost = cfg.main.socks.includes('://') ? cfg.main.socks.split('://')[1] : cfg.main.socks;
                                        curlArgs.push('--socks5-hostname', proxyHost);
                                    }
                                    try {
                                        await queue.spawn('curl', curlArgs);
                                    } catch (err) {
                                        throw new Error(sanitizeError(err));
                                    }

                                    const fallbackMime = (await queue.spawn('file', ['--mime-type', '-b', fallbackTmp])).stdout.trim();
                                    const extension = cfg.mimes[fallbackMime];
                                    if (extension) {
                                        const finalPath = path.join(cfg.paths.tmp, `${uuid}.${extension}`);
                                        await fs.rename(fallbackTmp, finalPath);
                                        source = finalPath;
                                    } else {
                                        await fs.unlink(fallbackTmp).catch(() => {});
                                        throw new Error(dlError(null));
                                    }
                                }
                            }

                            if (!source || source.match(/larger than/)) throw new Error('File too large or download failed');

                            const { stat } = await import('fs/promises');
                            const size = (await stat(source)).size;
                            if (size > maxfilesize) {
                                await fs.unlink(source).catch(() => {});
                                throw new Error(`File too large. Max: ${lib.formatSize(maxfilesize)}, Got: ${lib.formatSize(size)}`);
                            }

                            let mime = (await queue.spawn('file', ['--mime-type', '-b', source])).stdout.trim();
                            const expectedExt = cfg.mimes[mime];
                            if (expectedExt) {
                                const currentExt = path.extname(source).slice(1).toLowerCase();
                                if (currentExt === 'unknown_video' || (currentExt !== expectedExt && !((currentExt === 'jpg' && expectedExt === 'jpeg') || (currentExt === 'jpeg' && expectedExt === 'jpg')))) {
                                    const newSource = path.join(path.dirname(source), path.basename(source, path.extname(source)) + '.' + expectedExt);
                                    await fs.rename(source, newSource);
                                    source = newSource;
                                }
                            }

                            if (mime === 'video/x-matroska') {
                                await queue.spawn('ffmpeg', ['-i', source, '-codec', 'copy', source.replace(/\.mkv$/, '.mp4')]);
                                await fs.unlink(source).catch(() => {});
                                source = source.replace(/\.mkv$/, '.mp4');
                                mime = 'video/mp4';
                            }
                            if (source.match(/\.opus$/)) {
                                await queue.spawn('ffmpeg', ['-i', source, '-codec', 'copy', source.replace(/\.opus$/, '.ogg')]);
                                await fs.unlink(source).catch(() => {});
                                source = source.replace(/\.opus$/, '.ogg');
                                mime = 'audio/ogg';
                            }

                            if (!Object.keys(cfg.mimes).includes(mime)) {
                                await fs.unlink(source).catch(() => {});
                                throw new Error(`Unsupported file type: ${mime}`);
                            }

                            const checksum = (await queue.spawn('sha256sum', [source])).stdout.trim().split(' ')[0];
                            if (!getBypassDuplicateCheck()) {
                                const repostSum = await queue.checkrepostsum(checksum);
                                if (repostSum) {
                                    await fs.unlink(source).catch(() => {});
                                    await db`INSERT INTO notifications (user_id, type, reference_id, item_id, data) VALUES (${session.id}, 'upload_error', 0, ${repostSum}, ${db.json({ url, msg: 'Duplicate detected (Checksum)' })})`;
                                    return;
                                }
                            }

                            let phash = null;
                            try {
                                phash = await queue.generatePHash(source);
                                if (phash && !getBypassDuplicateCheck()) {
                                    const phashMatch = await queue.checkrepostphash(phash);
                                    if (phashMatch) {
                                        await fs.unlink(source).catch(() => {});
                                        await db`INSERT INTO notifications (user_id, type, reference_id, item_id, data) VALUES (${session.id}, 'upload_error', 0, ${phashMatch}, ${db.json({ url, msg: 'Visual duplicate detected (PHash)' })})`;
                                        return;
                                    }
                                }
                            } catch (e) { console.error('[UPLOAD-URL-ASYNC] PHash error:', e); }

                            const filename = path.basename(source);
                            const isApprovalRequired = getManualApproval();
                            const destDir = isApprovalRequired ? path.join(cfg.paths.pending, 'b') : cfg.paths.b;
                            
                            let linkedToExistingUrl = false;
                            if (getBypassDuplicateCheck()) {
                                const existing = await db`SELECT dest FROM items WHERE checksum = ${checksum} OR checksum LIKE ${checksum + '_bypass_%'} ORDER BY id DESC LIMIT 1`;
                                if (existing.length > 0) {
                                    try {
                                        const realTarget = await fs.realpath(path.join(cfg.paths.b, existing[0].dest));
                                        await fs.symlink(realTarget, path.resolve(path.join(destDir, filename)));
                                        linkedToExistingUrl = true;
                                    } catch (e) { }
                                }
                            }
                            if (!linkedToExistingUrl) await fs.copyFile(source, path.join(destDir, filename));
                            await fs.unlink(source).catch(() => { });

                            const insertChecksum = getBypassDuplicateCheck() ? `${checksum}_bypass_${Date.now()}` : checksum;

                            const [{ id: itemid }] = await db`
                                insert into items ${db({
                                    src: url,
                                    dest: filename,
                                    mime: mime,
                                    size: size,
                                    checksum: insertChecksum,
                                    phash: phash,
                                    username: session.user,
                                    userchannel: 'web',
                                    usernetwork: 'web',
                                    stamp: ~~(Date.now() / 1000),
                                    active: !isApprovalRequired,
                                    is_oc: !!is_oc,
                                    title: title
                                }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active', 'is_oc', 'title')}
                                RETURNING id
                            `;

                            try {
                                await db`INSERT INTO comment_subscriptions (user_id, item_id) VALUES (${session.id}, ${itemid}) ON CONFLICT DO NOTHING`;
                            } catch (err) { }

                            try {
                                await queue.genThumbnail(filename, mime, itemid, url, isApprovalRequired);
                                await queue.genBlurredThumbnail(itemid, isApprovalRequired);
                            } catch (err) {
                                const tDir = isApprovalRequired ? path.join(cfg.paths.pending, 't') : cfg.paths.t;
                                await queue.spawn('magick', ['-size', '128x128', 'xc:#1a1a1a', path.join(tDir, `${itemid}.webp`)]).catch(() => {});
                            }

                            // Assign rating tag (only if a rating was selected)
                            if (effectiveRating) {
                                const ratingTagId = effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3));
                                await db`insert into tags_assign ${db({ item_id: itemid, tag_id: ratingTagId, user_id: session.id })}`;
                            }
                            const autoTags = autoTagsFromUrl(url);
                            const allTags = [...new Set([...tags, ...autoTags])];
                            for (const tagName of allTags) {
                                await assignTag(itemid, tagName, session.id);
                            }

                            if (isApprovalRequired) await queue.notifyAdmins(itemid).catch(() => {});
                            await saveComment(itemid, session.id, comment);
                            if (is_oc) {
                                for (const tagname of ['oc', 'original content']) {
                                    await assignTag(itemid, tagname, session.id);
                                }
                            }
                            
                            // Broadcast new_item event for live grid updates (only if auto-approved)
                            if (!isApprovalRequired) {
                                try {
                                    await db`SELECT pg_notify('new_item', ${JSON.stringify({
                                        id: itemid,
                                        dest: filename,
                                        mime: mime,
                                        username: session.user,
                                        display_name: session.display_name || null,
                                        tag_id: effectiveRating ? (effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3))) : 0,
                                        is_oc: !!is_oc
                                    })})`;
                                } catch (err) {
                                    console.error('[UPLOAD-URL] new_item notify failed:', err);
                                }
                            }

                            // Push to Matrix Channel (only if auto-approved)
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
                                            console.log(`[UPLOAD-URL] Matrix notification sent for item ${itemid}`);
                                        }
                                    }
                                } catch (err) {
                                    console.error('[UPLOAD-URL] Matrix notification error:', err);
                                }
                            }

                            // Completion notification
                            await db`INSERT INTO notifications (user_id, type, reference_id, item_id) VALUES (${session.id}, 'upload_success', 0, ${itemid})`;

                        } catch (err) {
                            console.error('[UPLOAD-URL-ASYNC] Final Error:', err);
                            // Error notification
                            await db`INSERT INTO notifications (user_id, type, reference_id, item_id, data) VALUES (${session.id}, 'upload_error', 0, ${null}, ${db.json({ url, msg: sanitizeError(err) })})`;
                        }
                    })();
                }
            } catch (err) {
                console.error('[UPLOAD-URL ERROR]', err);
                return res.json({ success: false, msg: 'Upload failed: ' + (err.message || 'Unknown error') }, 500);
            }
        });

    });

    return router;
};
