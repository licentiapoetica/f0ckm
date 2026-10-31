import { promises as fs } from "fs";
import db from '../../sql.mjs';
import lib from '../../lib.mjs';
import cfg from '../../config.mjs';
import { getEnableItemSlugs, canAnonDo, getAnonAllowedModes, isAnonSession, isAnonymizeSession, getSessionOwnerName } from '../../settings.mjs';
import queue from '../../queue.mjs';
import search from '../../routeinc/search.mjs';
import path from "path";
import f0cklib from '../../routeinc/f0cklib.mjs';
import audit from '../../audit.mjs';
import { parseMultipart, collectBody } from '../../multipart.mjs';
import { purgeExpiredUploads, safeDeleteMediaFile } from '../../lib_delete.mjs';
import { calculateExpiresAt } from './upload.mjs';
import { addPrivateItem, removePrivateItem, addUnavailableItem, removeUnavailableItem } from '../../private_items.mjs';
import { logAnonActivity } from '../../anon_auth.mjs';

const allowedMimes = ["audio", "image", "video", "%"];
const getGlobalfilter = (session) => {
  if (!cfg.nsfp?.length) return null;
  let filteredTags = [...cfg.nsfp];
  if (session && isAnonSession(session)) {
    const allowedModes = getAnonAllowedModes();
    if (allowedModes.includes('nsfw')) {
      filteredTags = filteredTags.filter(id => id !== 2);
    }
    const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
    if (allowedModes.includes('nsfl')) {
      filteredTags = filteredTags.filter(id => id !== nsflId);
    }
  } else if (!session) {
    if (cfg.websrv.public_nsfw) {
      filteredTags = filteredTags.filter(id => id !== 2);
    }
  } else {
    if (cfg.websrv.public_nsfw) {
      filteredTags = filteredTags.filter(id => id !== 2);
    }
  }
  return filteredTags.length ? filteredTags.map(n => `tag_id = ${n}`).join(' or ') : null;
};
const metaCache = new Map();
const MAX_META_CACHE = 2000;

export default router => {
  // Ensure cache table exists
  db`CREATE TABLE IF NOT EXISTS meta_cache (
    url TEXT PRIMARY KEY,
    data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`.catch(err => console.error('[META-CACHE] Table creation failed:', err));

  router.group(/^\/api\/v2/, group => {
    
    const ytRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\?(?:\S*?&?v\=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;

    const extractMeta = (html) => {
        const meta = {};
        const cleanHtml = html.replace(/\r?\n|\r/g, ' ');

        // Helper: extract a meta tag by property or name attribute
        const getMeta = (attrType, attrVal) => {
            const r1 = new RegExp(`<meta\\s+${attrType}=["']${attrVal}["']\\s+content=["']([^"']*)["']`, 'i');
            const r2 = new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+${attrType}=["']${attrVal}["']`, 'i');
            return (cleanHtml.match(r1) || cleanHtml.match(r2))?.[1]?.trim() || null;
        };
        const prop  = (k) => getMeta('property', k);
        const named = (k) => getMeta('name', k);

        // --- Standard HTML ---
        const titleMatch = cleanHtml.match(/<title[^>]*>(.*?)<\/title>/i);
        if (titleMatch) meta.title = titleMatch[1].trim();

        const descStd = named('description');
        if (descStd) meta.description = descStd;

        const keywordsRaw = named('keywords');
        if (keywordsRaw) meta.keywords = keywordsRaw.split(/[,;]+/).map(k => k.trim()).filter(Boolean);

        const authorStd = named('author');
        if (authorStd) meta.author = authorStd;

        const lang = cleanHtml.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1]?.trim();
        if (lang) meta.language = lang;

        // --- Open Graph ---
        meta.og_title    = prop('og:title')       || null;
        meta.site_name   = prop('og:site_name')    || null;
        meta.og_desc     = prop('og:description')  || null;
        meta.og_type     = prop('og:type')         || null;
        meta.og_locale   = prop('og:locale')       || null;

        // Article tags (multiple og:article:tag tags)
        const articleTagMatches = [...cleanHtml.matchAll(/property=["']og:article:tag["']\s+content=["']([^"']*)["']/gi)];
        const articleTagMatches2 = [...cleanHtml.matchAll(/content=["']([^"']*)["']\s+property=["']og:article:tag["']/gi)];
        meta.article_tags = [...articleTagMatches, ...articleTagMatches2].map(m => m[1].trim()).filter(Boolean);

        meta.article_section = prop('og:article:section') || null;
        meta.article_author  = prop('og:article:author')  || prop('article:author') || null;

        // Music
        meta.music_album    = prop('og:music:album')    || null;
        meta.music_musician = prop('og:music:musician') || null;
        meta.music_song     = prop('og:music:song')     || null;

        // Video
        const videoTagMatches = [...cleanHtml.matchAll(/property=["']og:video:tag["']\s+content=["']([^"']*)["']/gi)];
        const videoTagMatches2 = [...cleanHtml.matchAll(/content=["']([^"']*)["']\s+property=["']og:video:tag["']/gi)];
        meta.video_tags = [...videoTagMatches, ...videoTagMatches2].map(m => m[1].trim()).filter(Boolean);

        // Book
        meta.book_author = prop('og:book:author') || prop('book:author') || null;
        const bookTagMatches = [...cleanHtml.matchAll(/property=["']og:book:tag["']\s+content=["']([^"']*)["']/gi)];
        meta.book_tags = bookTagMatches.map(m => m[1].trim()).filter(Boolean);

        // Profile
        const firstName = prop('og:profile:first_name') || prop('profile:first_name');
        const lastName  = prop('og:profile:last_name')  || prop('profile:last_name');
        if (firstName || lastName) meta.profile_name = [firstName, lastName].filter(Boolean).join(' ');
        meta.profile_username = prop('og:profile:username') || prop('profile:username') || null;

        // --- Twitter Card ---
        meta.twitter_title   = named('twitter:title')       || null;
        meta.twitter_desc    = named('twitter:description')  || null;
        meta.twitter_creator = named('twitter:creator')      || null;
        meta.twitter_site    = named('twitter:site')         || null;

        // Twitter data labels (e.g. "Rating: 5 stars", "Runtime: 90 min")
        for (let i = 1; i <= 4; i++) {
            const label = named(`twitter:label${i}`);
            const data  = named(`twitter:data${i}`);
            if (label && data) {
                if (!meta.twitter_labels) meta.twitter_labels = [];
                meta.twitter_labels.push(`${label}: ${data}`);
            }
        }

        // --- Product / Price ---
        meta.price_amount   = prop('product:price:amount')   || prop('og:price:amount')   || null;
        meta.price_currency = prop('product:price:currency') || prop('og:price:currency') || null;

        // --- News / misc ---
        const newsKw = named('news_keywords');
        if (newsKw) meta.news_keywords = newsKw.split(/[,;]+/).map(k => k.trim()).filter(Boolean);

        meta.category = named('category') || prop('article:section') || null;
        meta.genre    = named('genre')    || null;

        // --- JSON-LD (schema.org) ---
        const jsonLdMatches = [...cleanHtml.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gi)];
        for (const m of jsonLdMatches) {
            try {
                const ld = JSON.parse(m[1].replace(/<!--.*?-->/gs, ''));
                const entries = Array.isArray(ld) ? ld : [ld];
                for (const entry of entries) {
                    if (entry.name && !meta.ld_name) meta.ld_name = String(entry.name).trim();
                    if (entry.description && !meta.ld_desc) meta.ld_desc = String(entry.description).trim();
                    if (entry.author) {
                        const a = Array.isArray(entry.author) ? entry.author : [entry.author];
                        const authorNames = a.map(x => x?.name || x).filter(x => typeof x === 'string').map(x => x.trim());
                        if (authorNames.length && !meta.ld_author) meta.ld_author = authorNames.join(', ');
                    }
                    if (entry.keywords && !meta.ld_keywords) {
                        const kw = typeof entry.keywords === 'string'
                            ? entry.keywords.split(/[,;]+/).map(k => k.trim()).filter(Boolean)
                            : Array.isArray(entry.keywords) ? entry.keywords.map(String) : [];
                        if (kw.length) meta.ld_keywords = kw;
                    }
                    if (entry.genre && !meta.ld_genre) meta.ld_genre = String(entry.genre).trim();
                    if (entry.headline && !meta.ld_headline) meta.ld_headline = String(entry.headline).trim();
                    if (entry.articleSection && !meta.category) meta.category = String(entry.articleSection).trim();
                    if (entry.creator && !meta.ld_creator) {
                        const c = Array.isArray(entry.creator) ? entry.creator : [entry.creator];
                        meta.ld_creator = c.map(x => x?.name || x).filter(x => typeof x === 'string').join(', ');
                    }
                    // AboutPage / subject / about
                    if (entry.about && !meta.ld_about) {
                        const sub = entry.about?.name || (typeof entry.about === 'string' ? entry.about : null);
                        if (sub) meta.ld_about = String(sub).trim();
                    }
                }
            } catch (_) {}
        }

        return meta;
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    group.get(/\/meta\/extract\/item\/(?<id>\d+)$/, lib.loggedin, async (req, res) => {
        const id = req.params.id;
        try {
            const rows = await db`SELECT dest, mime, original_filename FROM items WHERE id = ${id}`;
            const item = rows[0];
            if (!item) return res.json({ success: false, msg: 'Item not found' }, 404);

            const isMedia = (item.mime.startsWith('video/') || item.mime.startsWith('audio/') || item.mime.startsWith('image/')) &&
                            !item.mime.includes('flash') && !item.mime.includes('youtube');
            if (!isMedia) return res.json({ success: false, msg: 'Metadata extraction not available for this file type' }, 400);

            const fullPath = path.join(cfg.paths.b, item.dest);
            const results = [];
            const seen = new Set();

            const addResult = (val) => {
                if (!val || typeof val !== 'string') return;
                val = val.trim();
                if (!val) return;
                // Strip all HTML tags (e.g. <script>...</script> embedded in EXIF data)
                val = val.replace(/<[^>]*>/g, '').trim();
                // Remove control characters (null bytes, etc.)
                val = val.replace(/[\x00-\x1F\x7F]/g, '').trim();
                if (!val || seen.has(val.toLowerCase())) return;
                seen.add(val.toLowerCase());
                results.push(val.substring(0, 255));
            };

            // Original filename is always surfaced first — most useful for tagging
            if (item.original_filename) {
                let baseName = item.original_filename;
                const lastDot = baseName.lastIndexOf('.');
                if (lastDot > 0) baseName = baseName.substring(0, lastDot);
                addResult(baseName.trim());
            }

            if (item.mime.startsWith('image/')) {
                // Use exiftool for images — reads EXIF, IPTC, XMP tags properly
                try {
                    const { stdout } = await queue.spawn('exiftool', ['-j', '-s', '-n', fullPath], { quiet: true, ignoreExitCode: true });
                    if (stdout && stdout.trim()) {
                        const tags = JSON.parse(stdout)[0] || {};

                        // IPTC/XMP textual fields — best for tagging
                        const textFields = [
                            'Title', 'ObjectName', 'Headline', 'Caption', 'CaptionAbstract',
                            'Description', 'ImageDescription', 'UserComment', 'Comment',
                            'Artist', 'Creator', 'By-line', 'Credit', 'Source',
                            'Copyright', 'CopyrightNotice', 'Rights',
                            'Keywords', 'Subject', 'Category', 'SupplementalCategories',
                            'Software', 'Make', 'Model', 'LensModel',
                        ];
                        for (const field of textFields) {
                            const val = tags[field];
                            if (Array.isArray(val)) {
                                val.forEach(v => addResult(String(v)));
                            } else if (val) {
                                if (field === 'Keywords' || field === 'Subject') {
                                    String(val).split(/[,;]/).map(s => s.trim()).forEach(addResult);
                                } else {
                                    addResult(String(val));
                                }
                            }
                        }

                        // IPTC/XMP embedded location text — extract as individual tags
                        const locationFields = ['City', 'State', 'Province-State', 'Country', 'CountryCode', 'Sub-location', 'Location'];
                        let hasTextLocation = false;
                        for (const field of locationFields) {
                            const val = tags[field];
                            if (val && String(val).trim()) {
                                addResult(String(val));
                                hasTextLocation = true;
                            }
                        }



                        // GPS: always include raw decimal coords + reverse geocode for human-readable location
                        if (tags['GPSLatitude'] != null && tags['GPSLongitude'] != null) {
                            const lat = parseFloat(tags['GPSLatitude']);
                            const lon = parseFloat(tags['GPSLongitude']);
                            if (!isNaN(lat) && !isNaN(lon)) {
                                // Raw GPS string (always included)
                                addResult(`${lat.toFixed(5)},${lon.toFixed(5)}`);

                                // Reverse geocode to human-readable location (best-effort)
                                if (!hasTextLocation) {
                                    try {
                                        const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1`;
                                        // Use socks5h:// so DNS resolves through the proxy (not locally)
                                        const proxyArgs = (cfg.main.socks && cfg.main.socks !== 'undefined')
                                            ? ['--proxy', cfg.main.socks.replace(/^socks5:\/\//, 'socks5h://')]
                                            : [];
                                        const { stdout: geoOut } = await queue.spawn('curl', [
                                            ...proxyArgs,
                                            '-s', '--max-time', '10',
                                            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                                            nominatimUrl
                                        ], { quiet: true });
                                        if (geoOut && geoOut.trim()) {
                                            const geo = JSON.parse(geoOut);
                                            const addr = geo.address || {};
                                            const city = addr.city || addr.town || addr.village || addr.municipality;
                                            if (city) addResult(city);
                                            if (addr.state) addResult(addr.state);
                                            if (addr.country) addResult(addr.country);
                                            if (addr.country_code) addResult(addr.country_code.toUpperCase());
                                        }
                                    } catch (geoErr) {
                                        if (cfg.websrv.debug) console.warn('[META-EXTRACT] Reverse geocode failed:', geoErr.message);
                                    }
                                }
                            }
                        }
                    }
                } catch (exifErr) {
                    console.error('[API-V2-EXTRACT-EXIF] exiftool error:', exifErr.message);
                }
            } else {
                // Audio / Video — use ffprobe format tags
                const metadata = await queue.getVideoMetadata(fullPath);
                const keysToCheck = [
                    'title', 'TITLE', 'comment', 'COMMENT', 'artist', 'ARTIST',
                    'album_artist', 'ALBUM_ARTIST', 'author', 'AUTHOR',
                    'genre', 'GENRE', 'description', 'DESCRIPTION',
                ];
                keysToCheck.forEach(key => {
                    const val = metadata?.[key];
                    if (val && typeof val === 'string') addResult(val.trim());
                });
            }

            return res.json({ success: true, fields: results });
        } catch (err) {
            console.error('[API-V2-EXTRACT-RETR] Error:', err);
            return res.json({ success: false, msg: 'Extraction failed' }, 500);
        }
    });

    // Allow authenticated clients to push metadata they fetched client-side (e.g. YouTube oEmbed
    // fetched directly from the browser, bypassing Tor/proxy consent walls).
    group.post(/\/meta\/cache$/, lib.loggedin, async (req, res) => {
        if (!cfg.websrv.web_meta_extraction) {
            return res.json({ success: false, msg: 'Metadata extraction is disabled' }, 403);
        }
        try {
            const body = await collectBody(req);
            const payload = JSON.parse(body.toString());
            const { url, meta } = payload || {};
            if (!url || !meta || !meta.title) {
                return res.json({ success: false, msg: 'url and meta.title required' }, 400);
            }
            // Only accept YouTube URLs to prevent arbitrary cache poisoning
            if (!/(youtube\.com|youtu\.be)/i.test(url)) {
                return res.json({ success: false, msg: 'Only YouTube URLs accepted' }, 400);
            }
            // Sanitise — only store known-safe fields
            const safeMeta = {
                title: String(meta.title).substring(0, 500),
                site_name: 'youtube.com',
                author: meta.author ? String(meta.author).substring(0, 200) : 'Unknown'
            };
            metaCache.set(url, safeMeta);
            if (metaCache.size > MAX_META_CACHE) {
                const first = metaCache.keys().next().value;
                metaCache.delete(first);
            }
            try {
                await db`INSERT INTO meta_cache (url, data) VALUES (${url}, ${safeMeta})
                         ON CONFLICT (url) DO UPDATE SET data = EXCLUDED.data, created_at = CURRENT_TIMESTAMP`;
            } catch (err) {
                console.error('[META-CACHE] DB save failed:', err);
            }
            return res.json({ success: true });
        } catch (err) {
            return res.json({ success: false, msg: 'Invalid request body' }, 400);
        }
    });

    const audioMetaCache = new Map();

    group.get(/\/audio-metadata$/, async (req, res) => {
        try {
            const rawSrc = req.url.qs?.src || req.url.qs?.file || '';
            const itemId = req.url.qs?.id || '';
            if (!rawSrc && !itemId) {
                return res.json({ success: false, msg: 'Missing src or id' }, 400);
            }

            let filename = '';
            if (rawSrc) {
                filename = path.basename(rawSrc.split('?')[0]);
            }

            if (filename && (filename.includes('/') || filename.includes('\\') || filename.includes('..'))) {
                return res.json({ success: false, msg: 'Invalid filename' }, 400);
            }

            const cacheKey = filename || `item_${itemId}`;
            if (audioMetaCache.has(cacheKey)) {
                return res.json(audioMetaCache.get(cacheKey));
            }

            let fullPath = filename ? path.join(cfg.paths.b, filename) : null;
            let originalFilename = '';

            if (itemId) {
                const isNumeric = /^\d+$/.test(itemId);
                const rows = isNumeric
                    ? await db`SELECT dest, original_filename, title FROM items WHERE id = ${itemId}`
                    : await db`SELECT dest, original_filename, title FROM items WHERE slug = ${itemId}`;
                if (rows && rows[0]) {
                    if (!fullPath) fullPath = path.join(cfg.paths.b, rows[0].dest);
                    originalFilename = rows[0].original_filename || '';
                } else {
                    const subRows = isNumeric
                        ? await db`SELECT dest FROM album_items WHERE id = ${+itemId}`
                        : await db`SELECT dest FROM album_items WHERE slug = ${itemId}`;
                    if (subRows && subRows[0]) {
                        if (!fullPath) fullPath = path.join(cfg.paths.b, subRows[0].dest);
                    }
                }
            }

            if (!fullPath) {
                return res.json({ success: false, msg: 'File not found' }, 404);
            }

            try {
                await fs.access(fullPath);
            } catch {
                return res.json({ success: false, msg: 'File not found on disk' }, 404);
            }

            const metadata = await queue.getVideoMetadata(fullPath);
            const tags = metadata || {};

            // Normalize all tag keys to lowercase without punctuation (e.g. 'Title' -> 'title', 'ALBUM_ARTIST' -> 'albumartist')
            const lowerTags = {};
            for (const [k, v] of Object.entries(tags)) {
                if (v != null && v !== '') {
                    const normKey = k.toLowerCase().replace(/[-_\s]/g, '');
                    lowerTags[normKey] = typeof v === 'string' ? v.trim() : String(v).trim();
                }
            }

            let title = lowerTags.title ||
                        lowerTags.tracktitle ||
                        lowerTags.song ||
                        lowerTags.songname ||
                        lowerTags.name ||
                        '';

            let artist = lowerTags.artist ||
                         lowerTags.albumartist ||
                         lowerTags.author ||
                         lowerTags.performer ||
                         lowerTags.creator ||
                         lowerTags.composer ||
                         lowerTags.byline ||
                         '';

            let album = lowerTags.album ||
                        lowerTags.albumtitle ||
                        '';

            let genre = lowerTags.genre || '';
            let date = lowerTags.date || lowerTags.year || '';

            if (!title && !artist) {
                const nameToParse = originalFilename || path.parse(fullPath).name;
                const match = nameToParse.match(/^(.+?)\s*[-–—_]\s*(.+)$/);
                if (match) {
                    artist = match[1].replace(/^[0-9]+[\s._-]+/, '').trim();
                    title = match[2].trim();
                } else if (nameToParse && !nameToParse.startsWith('subf0ck') && nameToParse.length < 60) {
                    title = nameToParse.trim();
                }
            }

            const result = {
                success: true,
                artist: String(artist || '').trim(),
                title: String(title || '').trim(),
                album: String(album || '').trim(),
                genre: String(genre || '').trim(),
                date: String(date || '').trim(),
                has_meta: !!(artist || title)
            };

            if (audioMetaCache.size > 1000) {
                const firstKey = audioMetaCache.keys().next().value;
                audioMetaCache.delete(firstKey);
            }
            audioMetaCache.set(cacheKey, result);

            return res.json(result);
        } catch (err) {
            console.error('[API-V2-AUDIO-METADATA] Error:', err);
            return res.json({ success: false, msg: 'Failed to extract audio metadata' }, 500);
        }
    });

    // F-002 Security: Require authentication to prevent SSRF via arbitrary URL fetching.
    // Guests may read from the cache (in-memory or DB); only authenticated users trigger real outbound fetches.
    group.get(/\/meta\/fetch$/, async (req, res) => {
        if (!cfg.websrv.web_meta_extraction) {
            return res.json({ success: false, msg: 'Metadata extraction is disabled' }, 403);
        }

        const url = req.url.qs.url;
        if (!url) return res.json({ success: false, msg: 'URL required' }, 400);

        if (metaCache.has(url)) {
            return res.json({ success: true, meta: metaCache.get(url) });
        }

        // Check DB cache for persistence across restarts
        try {
            const cached = await db`SELECT data FROM meta_cache WHERE url = ${url} LIMIT 1`;
            if (cached.length > 0) {
                const meta = cached[0].data;
                metaCache.set(url, meta); // update in-memory cache
                return res.json({ success: true, meta });
            }
        } catch (err) {
            console.error('[META-CACHE] DB lookup failed:', err);
        }

        // Cache miss — require auth to perform real outbound fetch (SSRF prevention)
        if (!req.session) {
            return res.json({ success: false, msg: 'Not cached' }, 401);
        }

        const setCache = async (u, m) => {
            if (!m || !m.title) return;
            metaCache.set(u, m);
            if (metaCache.size > MAX_META_CACHE) {
                const first = metaCache.keys().next().value;
                metaCache.delete(first);
            }
            // Persist to DB
            try {
                await db`INSERT INTO meta_cache (url, data) VALUES (${u}, ${m}) 
                         ON CONFLICT (url) DO UPDATE SET data = EXCLUDED.data, created_at = CURRENT_TIMESTAMP`;
            } catch (err) {
                console.error('[META-CACHE] DB save failed:', err);
            }
        };

        if (/\.(mp4|webm|mp3|ogg|opus|flac|m4a|mkv|jpg|jpeg|png|gif|webp|swf)$/i.test(url)) {
            return res.json({ success: false, msg: 'Metadata extraction skipped for direct media URLs' }, 400);
        }

        const isLargeSite = (/(instagram\.com|reels|twitter\.com|x\.com)/i.test(url));
        const isYouTube = (/(youtube\.com|youtu\.be)/i.test(url));
        const proxyArgs = (cfg.main.socks && cfg.main.socks !== 'undefined') ? ['--proxy', cfg.main.socks] : [];
        const socksH = cfg.main.socks && cfg.main.socks !== 'undefined'
            ? cfg.main.socks.replace(/^socks5:\/\//, 'socks5h://')
            : null;

        // 1. YouTube: try oEmbed first (fast), then fall through to yt-dlp on failure
        if (isYouTube) {
            try {
                const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
                // Do NOT use --fail: non-2xx responses (e.g. age-restricted/private videos) still
                // return valid JSON we can attempt to parse. Use ignoreExitCode so we always get output.
                const { stdout: oembedOut } = await queue.spawn('curl', [
                    '-s', '--max-time', '15',
                    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    ...(socksH ? ['--proxy', socksH] : []),
                    oembedUrl
                ], { ignoreExitCode: true });
                if (oembedOut && oembedOut.trim()) {
                    const trimmed = oembedOut.trim();
                    // YouTube often returns HTML (consent/cookie walls, CAPTCHAs, geo-blocks)
                    // instead of JSON when accessed through a proxy — skip those gracefully.
                    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
                        console.warn(`[META-FETCH] YouTube oEmbed returned non-JSON (likely HTML wall), falling back to yt-dlp`);
                    } else {
                        const data = JSON.parse(trimmed);
                        if (data.title) {
                            const meta = {
                                title: data.title,
                                site_name: 'youtube.com',
                                author: data.author_name || 'Unknown'
                            };
                            await setCache(url, meta);
                            return res.json({ success: true, meta });
                        }
                    }
                }
            } catch (oembedErr) {
                console.warn(`[META-FETCH] YouTube oEmbed failed, will try yt-dlp:`, oembedErr.message || oembedErr);
            }

            // oEmbed failed — fall back to yt-dlp for YouTube (handles age-restricted, private, etc.)
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const { stdout: ytOut } = await queue.spawn('yt-dlp', [
                        ...proxyArgs,
                        '--quiet',
                        '--no-warnings',
                        '--js-runtimes', 'node',
                        '--print', '%(title)s',
                        '--print', '%(uploader)s',
                        '--skip-download',
                        url
                    ]);
                    const ytLines = ytOut.trim().split('\n');
                    const ytTitle = ytLines[0] ? ytLines[0].trim() : '';
                    if (ytTitle) {
                        const meta = {
                            title: ytTitle,
                            site_name: 'youtube.com',
                            author: ytLines[1] ? ytLines[1].trim() : 'Unknown'
                        };
                        await setCache(url, meta);
                        return res.json({ success: true, meta });
                    }
                } catch (ytErr) {
                    if (attempt < 2) { await sleep(1000); continue; }
                    console.error(`[META-FETCH] YouTube yt-dlp fallback failed:`, ytErr.message || ytErr);
                }
            }

            return res.json({ success: false, msg: 'Failed to extract YouTube metadata' }, 500);
        }

        // 2. Try yt-dlp for Instagram, Twitter, and other complex sites
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const { stdout } = await queue.spawn('yt-dlp', [
                    ...proxyArgs,
                    '--quiet',
                    '--no-warnings',
                    '--js-runtimes', 'node',
                    '--geo-bypass',
                    '--print', '%(title)s',
                    '--print', '%(uploader)s',
                    '--print', '%(webpage_url_domain)s',
                    '--skip-download',
                    url
                ]);
                
                const lines = stdout.trim().split('\n');
                const title = lines[0] ? lines[0].trim() : '';

                if (title.includes('Reddit - Please wait for verification')) {
                    throw new Error('Reddit bot protection detected');
                }

                if (title) {
                    const meta = { 
                        title: title,
                        site_name: lines[2] ? lines[2].trim() : 'Media Site',
                        author: lines[1] ? lines[1].trim() : 'Unknown'
                    };
                    await setCache(url, meta);
                    return res.json({ 
                        success: true, 
                        meta 
                    });
                }
            } catch (err) {
                if (attempt < 3) {
                    await sleep(1000);
                    continue;
                }
                console.error(`[META-FETCH] yt-dlp failed after 3 attempts for ${url}:`, err.message || err);
                if (isLargeSite) {
                    return res.json({ success: false, msg: 'Failed to extract metadata via yt-dlp after 3 attempts' }, 500);
                }
            }
        }

        // 2. Fallback to curl for smaller/generic sites
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const curlArgs = [
                    '-s', // Silent mode
                    '-L', // Follow redirects
                    '--max-time', '5',
                    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    '--max-filesize', '2097152', // 2MB limit
                    '--fail', // Fail on HTTP error
                    url
                ];

                if (cfg.main.socks && cfg.main.socks !== 'undefined') {
                    curlArgs.unshift('--proxy', cfg.main.socks);
                }

                const { stdout } = await queue.spawn('curl', curlArgs);
                
                if (stdout) {
                    const meta = extractMeta(stdout);
                    
                    // Filter out junk titles from bot protection
                    if (meta.title && meta.title.includes('Reddit - Please wait for verification')) {
                        return res.json({ success: false, msg: 'Reddit bot protection encountered' }, 403);
                    }

                    await setCache(url, meta);
                    return res.json({ success: true, meta });
                }
            } catch (err) {
                if (attempt < 3 && err.code !== 63) { // Don't retry if it exceeded size limit
                    await sleep(1000);
                    continue;
                }
                // Don't log the full stdout/stderr if it's potentially huge
                const errorMsg = err.message || 'Generic Error';
                console.error(`[META-FETCH FALLBACK ERROR] ${url} (Attempt ${attempt}): ${errorMsg}`);
                if (err.code === 63) {
                    return res.json({ success: false, msg: 'Page too large for metadata extraction' }, 400);
                }
            }
        }

        return res.json({ success: false, msg: 'Failed to extract metadata from this URL after multiple attempts' }, 500);
    });

    group.get(/$/, (req, res) => {
      res.end("api lol");
    });

    // Lightweight page-lookup for Onara grid sync.
    // Called async after random navigation — user never waits for this.
    group.get(/\/item-page$/, async (req, res) => {
      const rawId = req.url.qs?.id || req.url.qs?.slug || req.url.qs?.item;
      if (!rawId) return res.json({ success: false, page: 1 });

      const tag          = req.url.qs?.tag          || null;
      const hall         = req.url.qs?.hall         || null;
      const userHall     = req.url.qs?.userHall     || null;
      const userHallOwner= req.url.qs?.userHallOwner|| null;
      const user         = req.url.qs?.user         || null;
      const cookieMime   = req.cookies?.mime !== undefined ? (decodeURIComponent(req.cookies.mime).trim() || null) : null;
      const mime         = (typeof req.url.qs?.mime !== 'undefined') ? (req.url.qs.mime || null) : (cookieMime || null);
      const isFav        = req.url.qs?.fav === 'true';
      const isStrict     = req.url.qs?.strict === '1';
      const mode         = req.mode ?? 0;
      const ratingsRaw   = req.cookies.ratings;
      const ratingsArr   = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;

      try {
        const page = await f0cklib.getItemPage({
          targetItemId: rawId,
          user, tag, hall, userHall, userHallOwner, mime,
          fav: isFav,
          mode,
          ratings: ratingsArr && ratingsArr.length > 0 ? ratingsArr : null,
          strict: isStrict,
          session: req.session,
          exclude: req.session?.excluded_tags || [],
          user_id: req.session?.id,
          is_admin: req.session?.admin,
          minXdScore: req.url.qs?.min_xd !== undefined ? +req.url.qs.min_xd : (req.session?.min_xd_score || 0),
          tagger: req.url.qs?.tagger || null
        });
        return res.json({ success: true, page });
      } catch (e) {
        return res.json({ success: false, page: 1 });
      }
    });

    group.get(/\/random(\/user\/.+|\/image|\/video|\/audio)?$/, async (req, res) => {
      const pathParts = req.url.pathname.split('/');
      // /api/v2/random/user/name -> segments are ["", "api", "v2", "random", "user", "name"]
      const pathUser = (pathParts[4] === "user") ? pathParts[5] : null;
      const user = req.url.qs.user || pathUser || null;

      const pathMime = allowedMimes.includes(pathParts[4]) ? pathParts[4] : "";
      const cookieMime = req.cookies?.mime !== undefined ? (decodeURIComponent(req.cookies.mime).trim() || null) : null;
      const mime = (typeof req.url.qs?.mime !== 'undefined')
        ? (req.url.qs.mime || null)
        : (cookieMime || (pathMime || null));

      const tag = req.url.qs.tag || null;
      const hall = req.url.qs.hall || null;
      const userHall = req.url.qs.userHall || null;
      const userHallOwner = req.url.qs.userHallOwner || null;
      const isFav = req.url.qs.fav === 'true';
      const isStrict = req.url.qs.strict === '1';
      const mode = req.mode ?? 0; // Use req.mode (set by middleware) for consistency with all other routes
      const ratingsRaw = req.cookies.ratings;
      const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;

      const data = await f0cklib.getRandom({
        user,
        tag,
        hall,
        userHall,
        userHallOwner,
        mime,
        fav: isFav,
        mode,
        ratings: ratingsArr && ratingsArr.length > 0 ? ratingsArr : null,
        strict: isStrict,
        session: req.session,
        exclude: req.session?.excluded_tags || [],
        user_id: req.session?.id,
        is_admin: req.session?.admin
      });

      if (!data || !data.itemid) {
        return res.json({
          success: false,
          items: []
        });
      }

      // Skip getItemPage for random — page number is meaningless and it's expensive
      const rows = await db`
        SELECT *
        FROM "items"
        WHERE id = ${data.itemid} AND active = true
        LIMIT 1
      `;

      const item = rows[0];

      if (!item) {
        return res.json({
          success: false,
          items: []
        });
      }

      const isYouTube = item.mime === 'video/youtube';
      const ytSrcRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\/?\?(?:\S*?&v=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;
      let ytDest = item.dest;
      if (isYouTube && (!ytDest || !ytDest.startsWith('yt:'))) {
        const m = item.src && item.src.match(ytSrcRegex);
        if (m) ytDest = `yt:${m[1]}`;
      }
      const relativeDest = isYouTube ? ytDest : `${cfg.websrv.paths.images}/${item.dest}`;
      const directUrl = isYouTube ? ytDest : `${cfg.main.url.full}${cfg.websrv.paths.images}/${item.dest}`;

      const { username, src, xd_score, ...safeItem } = item;

      return res.json({
        success: true,
        items: {
          ...safeItem,
          id: item.id,
          slug: (getEnableItemSlugs() && item.slug) ? item.slug : null,
          dest: relativeDest,
          url: directUrl,
          direct_url: directUrl,
          page: 1
        }
      });
    });

    group.get('/random-pool', async (req, res) => {
      const user = req.url.qs?.user || null;
      const cookieMime = req.cookies?.mime !== undefined ? (decodeURIComponent(req.cookies.mime).trim() || null) : null;
      const mime = (typeof req.url.qs?.mime !== 'undefined')
        ? (req.url.qs.mime || null)
        : (cookieMime || null);
      const tag = req.url.qs?.tag || null;
      const hall = req.url.qs?.hall || null;
      const userHall = req.url.qs?.userHall || null;
      const userHallOwner = req.url.qs?.userHallOwner || null;
      const isFav = req.url.qs?.fav === 'true';
      const isStrict = req.url.qs?.strict === '1';
      const mode = req.mode ?? 0;
      const ratingsRaw = req.cookies.ratings;
      const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;

      const tStart = Date.now();
      const pool = await f0cklib.getRandomPool({
        user,
        tag,
        hall,
        userHall,
        userHallOwner,
        mime,
        fav: isFav,
        mode,
        ratings: ratingsArr && ratingsArr.length > 0 ? ratingsArr : null,
        strict: isStrict,
        session: req.session,
        exclude: req.session?.excluded_tags || [],
        user_id: req.session?.id,
        is_admin: req.session?.admin
      });
      console.log(`[RANDOM-POOL] ${pool.total} items in ${Date.now() - tStart}ms (mode=${mode} tag=${tag} hall=${hall} user=${user})`);

      // Include nsfp_version so clients can detect when the nsfp list changes and invalidate their pool
      pool.nsfp_version = (cfg.nsfp || []).slice().sort((a, b) => a - b).join(',');

      return res.json(pool);
    });

    group.get(/\/recommendations(?:\/(?<type>videos|all))?$/, async (req, res) => {
      try {
        const limit = Math.min(+(req.url.qs?.limit || 20), 50);
        let mode = req.mode ?? 0;
        if (req.url.qs && req.url.qs.mode && ['0', '1', '2', '3'].includes(req.url.qs.mode)) {
          mode = parseInt(req.url.qs.mode);
        }
        const ratingsRaw = req.cookies.ratings;
        const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;

        const cookieMime = req.cookies?.mime ? decodeURIComponent(req.cookies.mime).trim() : null;
        const mime = (typeof req.url.qs?.mime !== 'undefined')
          ? (req.url.qs.mime || null)
          : (cookieMime || (req.params?.type === 'videos' ? 'video' : null));

        let excludeIds = [];
        if (req.url.qs?.exclude_ids) {
          excludeIds = String(req.url.qs.exclude_ids).split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 150);
        }

        const sessionTags = req.url.qs?.session_tags || '';
        const sessionCreators = req.url.qs?.session_creators || '';
        const continuation = req.url.qs?.continuation === '1' || req.url.qs?.continuation === 'true';
        let preferPersonalized = null;
        if (req.url.qs?.prefer_personalized === 'true' || req.url.qs?.prefer_personalized === '1') {
          preferPersonalized = true;
        } else if (req.url.qs?.prefer_personalized === 'false' || req.url.qs?.prefer_personalized === '0') {
          preferPersonalized = false;
        }

        const items = await f0cklib.getPersonalizedRecommendations({
          limit,
          mode,
          ratings: ratingsArr,
          session: req.session,
          exclude: req.session?.excluded_tags || [],
          user_id: req.session?.id,
          is_admin: req.session?.admin,
          mime,
          exclude_ids: excludeIds,
          session_tags: sessionTags,
          session_creators: sessionCreators,
          continuation,
          prefer_personalized: preferPersonalized
        });

        const isAnonUser = isAnonymizeSession(req.session);
        res.json({
          success: true,
          items: items.map(item => ({
            id: item.id,
            title: item.title,
            slug: (getEnableItemSlugs() && item.slug) ? item.slug : null,
            dest: item.dest,
            mime: item.mime,
            stamp: item.stamp,
            username: isAnonUser ? 'anonymous' : item.username,
            display_name: isAnonUser ? null : item.display_name,
            username_color: isAnonUser ? null : item.username_color,
            has_coverart: item.has_coverart,
            rating_class: item.rating_class,
            xd_score: item.xd_score,
            xd_tier: item.xd_tier,
            personalized: !!item.personalized,
            tags: item.tags || [],
            score: typeof item.score === 'number' ? item.score : (typeof item.rank_score === 'number' ? item.rank_score : (item.xd_score || 0)),
            rank_score: item.rank_score ?? item.score ?? 0
          }))
        });
      } catch (err) {
        console.error("[RECOMMENDATIONS] Failed to fetch personalized recommendations:", err);
        res.status(500).json({
          success: false,
          error: "Failed to load recommendations"
        });
      }
    });

    // Track user behavioral signals (dwell time, completion, skips, suggestion clicks)
    group.post(/\/track\/interaction$/, async (req, res) => {
      try {
        let payload = req.post || {};
        if (!payload || Object.keys(payload).length === 0) {
          try {
            const body = await collectBody(req);
            if (body && body.length > 0) payload = JSON.parse(body.toString());
          } catch (_) {}
        }

        const itemId = parseInt(payload.item_id || payload.itemId, 10);
        if (!itemId) {
          return res.json({ success: false, error: "Invalid item_id" }, 400);
        }

        const duration = parseFloat(payload.duration) || 0;
        const percent = parseFloat(payload.percent) || 0;
        const type = String(payload.type || 'dwell');

        // Behavioral weighting: time spent is a primary signal
        let delta = 1.0;
        if (type === 'skip' || (duration < 2.5 && percent < 15)) {
          delta = -1.5;
        } else if (type === 'click_suggestion') {
          delta = 2.5;
        } else if (type === 'finish' || percent >= 75 || duration >= 20) {
          delta = 3.0;
        } else if (duration >= 8 || percent >= 35) {
          delta = 1.5;
        }

        if (req.session?.id) {
          f0cklib.updateUserAffinity({
            user_id: req.session.id,
            item_id: itemId,
            scoreDelta: delta
          }).catch(err => console.error("[TRACK] Affinity update failed:", err));
        }

        return res.json({ success: true, delta });
      } catch (err) {
        console.error("[TRACK] Interaction error:", err);
        return res.json({ success: false, error: "Tracking failed" }, 500);
      }
    });

    // Track tag search interest signal
    group.post(/\/track\/search$/, async (req, res) => {
      try {
        let payload = req.post || {};
        if (!payload || Object.keys(payload).length === 0) {
          try {
            const body = await collectBody(req);
            if (body && body.length > 0) payload = JSON.parse(body.toString());
          } catch (_) {}
        }

        const tag = (payload.tag || payload.q || req.url.qs?.tag || req.url.qs?.q);
        if (!tag || typeof tag !== 'string' || !tag.trim()) {
          return res.json({ success: false, error: "Invalid tag parameter" }, 400);
        }

        if (req.session?.id) {
          f0cklib.updateUserTagAffinity({
            user_id: req.session.id,
            tag: tag.trim(),
            scoreDelta: 2.0
          }).catch(err => console.error("[TRACK] Search affinity update failed:", err));
        }

        return res.json({ success: true });
      } catch (err) {
        console.error("[TRACK] Search tracking error:", err);
        return res.json({ success: false, error: "Tracking failed" }, 500);
      }
    });

    group.get(/\/favs-feed$/, async (req, res) => {
      try {
        const user = req.url.qs?.user ? String(req.url.qs.user).trim() : null;
        if (!user) {
          return res.json({ success: false, error: 'user is required', items: [], total: 0 }, 400);
        }

        const limit  = Math.min(+(req.url.qs?.limit  || 20), 50);
        const offset = Math.max(+(req.url.qs?.offset || 0),  0);
        const order  = req.url.qs?.order === 'asc' ? 'asc' : 'desc';
        const focusId = req.url.qs?.focus_id ? String(req.url.qs.focus_id).trim() : null;

        let mode = req.mode ?? 0;
        if (req.url.qs?.mode && ['0','1','2','3'].includes(req.url.qs.mode)) {
          mode = parseInt(req.url.qs.mode);
        }
        const ratingsRaw = req.cookies.ratings;
        const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;

        const result = await f0cklib.getf0cks({
          user,
          fav: true,
          mode,
          ratings: ratingsArr,
          session: req.session,
          exclude: req.session?.excluded_tags || [],
          user_id: req.session?.id,
          is_admin: req.session?.admin,
          limit,
          page: Math.floor(offset / limit) + 1,
          explicitTotal: null,
          lang: req.lang
        });

        if (!result || !result.success) {
          return res.json({ success: false, error: 'not found', items: [], total: 0 });
        }

        // Handle focus_id: if the focused item is on a different page, re-fetch centered on it
        let items = result.items || [];
        const total = result.total || 0;
        let effectiveOffset = offset;

        // If a focus_id is provided and not in current slice, try to find it
        if (focusId && focusId !== 'favs' && items.length > 0 && !items.find(it => String(it.id) === focusId || it.slug === focusId)) {
          const focusResult = await f0cklib.getItemPage({
            targetItemId: focusId,
            user,
            fav: true,
            mode,
            ratings: ratingsArr,
            session: req.session,
            user_id: req.session?.id,
            is_admin: req.session?.admin,
            exclude: req.session?.excluded_tags || [],
            limit
          });
          if (focusResult && focusResult > 0) {
            const focusPage = focusResult;
            effectiveOffset = (focusPage - 1) * limit;
            const focusResult2 = await f0cklib.getf0cks({
              user, fav: true, mode, ratings: ratingsArr,
              session: req.session, exclude: req.session?.excluded_tags || [],
              user_id: req.session?.id, is_admin: req.session?.admin,
              limit, page: focusPage, explicitTotal: total, lang: req.lang
            });
            if (focusResult2?.success) {
              items = focusResult2.items || [];
            }
          }
        }

        const isAnonUser = isAnonymizeSession(req.session);
        const outItems = isAnonUser
          ? items.map(it => ({ ...it, username: 'anonymous', display_name: 'anonymous', username_color: null }))
          : items;

        // Sort by order preference (items from getf0cks are newest-first by default)
        if (order === 'asc') outItems.reverse();

        return res.json({
          success: true,
          user,
          order,
          total,
          offset: effectiveOffset,
          limit,
          items: outItems,
          hasMore: (effectiveOffset + outItems.length) < total
        });
      } catch (err) {
        console.error('[FAVS-FEED] Error:', err);
        return res.json({ success: false, error: 'Failed to load favs feed', items: [], total: 0 }, 500);
      }
    });

    group.get(/\/tag-feed$/, async (req, res) => {
      try {
        const tag = req.url.qs?.tag ? String(req.url.qs.tag).trim() : null;
        if (!tag) {
          return res.json({ success: false, error: "Tag is required", items: [], total: 0 }, 400);
        }

        const limit = Math.min(+(req.url.qs?.limit || 20), 50);
        const offset = Math.max(+(req.url.qs?.offset || 0), 0);
        const order = req.url.qs?.order === 'asc' ? 'asc' : 'desc';
        const focusId = req.url.qs?.focus_id ? String(req.url.qs.focus_id).trim() : null;

        let mode = req.mode ?? 0;
        if (req.url.qs && req.url.qs.mode && ['0', '1', '2', '3'].includes(req.url.qs.mode)) {
          mode = parseInt(req.url.qs.mode);
        }
        const ratingsRaw = req.cookies.ratings;
        const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;
        const cookieMime = req.cookies?.mime ? decodeURIComponent(req.cookies.mime).trim() : null;
        const mime = (typeof req.url.qs?.mime !== 'undefined')
          ? (req.url.qs.mime || null)
          : (cookieMime || null);

        const isStrict = req.url.qs?.strict === '1' || req.url.qs?.strict === 'true' || !!req.session?.strict_mode;

        const result = await f0cklib.getTagFeedItems({
          tag,
          order,
          offset,
          limit,
          focus_id: focusId,
          mode,
          ratings: ratingsArr,
          session: req.session,
          exclude: req.session?.excluded_tags || [],
          user_id: req.session?.id,
          is_admin: req.session?.admin,
          mime,
          strict: isStrict
        });

        const effectiveOffset = result.offset ?? offset;
        const isAnonUser = isAnonymizeSession(req.session);
        const outItems = isAnonUser
          ? result.items.map(it => ({
              ...it,
              username: 'anonymous',
              display_name: 'anonymous',
              username_color: null,
              avatar: '/a/default.png',
              avatar_file: null
            }))
          : result.items;

        return res.json({
          success: true,
          tag,
          order,
          total: result.total,
          offset: effectiveOffset,
          limit: result.limit ?? limit,
          items: outItems,
          hasMore: (effectiveOffset + result.items.length) < result.total
        });
      } catch (err) {
        console.error("[TAG-FEED] Error loading tag feed items:", err);
        return res.json({
          success: false,
          error: "Failed to load tag feed",
          items: [],
          total: 0
        }, 500);
      }
    });
    
    group.get(/\/orakel\/user$/, async (req, res) => {
      try {
        if (isAnonymizeSession(req.session)) {
          return res.json({
            success: true,
            username: 'anonymous',
            display_name: 'Anonymous',
            id: 0
          });
        }
        const now = ~~(Date.now() / 1000);
        const sevenDaysAgo = now - 604800; // 7 days in seconds

        // Flat random pick from all users seen in the last 7 days.
        // No tiered bias — gives a proper pool of recently-active users
        // rather than always favouring whoever is online right now.
        // Banned users are always excluded.
        let activeUsers = await db`
          SELECT "user"."user", "user".id, uo.display_name
          FROM "user"
          LEFT JOIN user_options uo ON uo.user_id = "user".id
          WHERE "user".last_seen > ${sevenDaysAgo}
            AND "user".banned = false
          ORDER BY RANDOM()
          LIMIT 1
        `;

        // Ultimate fallback: any non-banned user (site just launched / everyone inactive)
        if (activeUsers.length === 0) {
          activeUsers = await db`
            SELECT "user"."user", "user".id, uo.display_name
            FROM "user"
            LEFT JOIN user_options uo ON uo.user_id = "user".id
            WHERE "user".banned = false
            ORDER BY RANDOM()
            LIMIT 1
          `;
        }

        const username    = activeUsers[0]?.user         || 'Anonymous';
        const userId      = activeUsers[0]?.id           || 0;
        const displayName = activeUsers[0]?.display_name || null;

        return res.json({
          success: true,
          username,
          display_name: displayName,
          id: userId
        });
      } catch (err) {
        console.error('[API ORAKEL USER ERROR]', err);
        return res.json({ success: false, msg: 'Error fetching random user' }, 500);
      }
    });

    group.get(/\/items\/get/, async (req, res) => {
      let eps = 150;

      const opt = {
        older: req.url.qs.older ?? null,
        newer: req.url.qs.newer ?? null,
        mode: +req.url.qs.mode ?? 0 // 0 sfw, 1 nsfw, 2 untagged, 3 all
      };

      const excludedTags = req.session?.excluded_tags || [];
      const isOwnerOrAdmin = req.session && (req.session.admin || req.session.is_moderator);
      const sessionUser = req.session?.user ? req.session.user.toLowerCase() : null;
      const visibilityFilter = isOwnerOrAdmin
        ? db``
        : (sessionUser
          ? db`and (coalesce("items".visibility, 0) = 0 or lower("items".username) = ${sessionUser})`
          : db`and coalesce("items".visibility, 0) = 0`);

      const newest = (await db`select max(id) as id from "items"`)[0]?.id || 0;
      const oldest = (await db`select min(id) as id from "items"`)[0]?.id || 0;
      const modequery = f0cklib.computeBaseMode(opt.mode, null, req.session);

      const rows = (await db`
        select "items".id, "items".mime, coalesce("tags_assign".tag_id, 0) as tag_id
        from "items"
        left join "tags_assign" on "tags_assign".item_id = "items".id and ("tags_assign".tag_id = 1 or "tags_assign".tag_id = 2 or "tags_assign".tag_id = ${cfg.nsfl_tag_id || 3})
        where
          ${db.unsafe(modequery)} and
          active = true
          ${visibilityFilter}
          ${(!req.session || isAnonSession(req.session)) && getGlobalfilter(req.session) ? db`and not exists (select 1 from tags_assign where item_id = "items".id and (${db.unsafe(getGlobalfilter(req.session))}))` : db``}
          ${excludedTags.length > 0 ? db`and not exists (select 1 from tags_assign where item_id = "items".id and tag_id = any(${excludedTags}::int[]))` : db``}
          ${opt.older
          ? db`and id <= ${opt.older}`
          : opt.newer
            ? db`and id >= ${opt.newer}`
            : db``
        }
        order by id ${opt.newer
          ? db`asc`
          : db`desc`
        }
        limit ${eps}
      `).sort((a, b) => b.id - a.id);

      return res.json({
        atEnd: rows.length > 0 && rows[0].id === newest,
        atStart: rows.length > 0 && rows[rows.length - 1].id === oldest,
        success: true,
        items: rows
      });
    });

    group.get(/\/item\/(?<id>[a-zA-Z0-9_-]{11}|\d+)$/, async (req, res) => {
      const rawIdOrSlug = req.params.id;
      const isNumeric = /^\d+$/.test(rawIdOrSlug);
      const id = isNumeric ? +rawIdOrSlug : (await db`SELECT id FROM items WHERE slug = ${rawIdOrSlug} LIMIT 1`)[0]?.id;
      if (!id) {
        return res.json({ success: false, msg: 'no items found' });
      }

      const item = await db`
        select *
        from "items"
        where id = ${id} and active = true
        limit 1
      `;

      if (item.length === 0) {
        return res.json({
          success: false,
          msg: 'no items found'
        });
      }

      const actitem = item[0];
      const session = req.session;
      const isOwnerOrAdmin = session && (
        session.admin ||
        session.is_moderator ||
        (session.user && session.user.toLowerCase() === (actitem.username || '').toLowerCase())
      );

      // Exclude unlisted (1) and private (2) items from API responses for non-owners/non-admins
      if ((actitem.visibility || 0) > 0 && !isOwnerOrAdmin) {
        return res.json({
          success: false,
          msg: 'no items found'
        });
      }

      const isPublicVisitor = !session || !session.user || isAnonSession(session);
      if (isPublicVisitor && !isOwnerOrAdmin && (actitem.visibility || 0) === 0 && getGlobalfilter(session)) {
        const filteredItem = await db`
          select 1 from tags_assign where item_id = ${id} and (${db.unsafe(getGlobalfilter(session))}) limit 1
        `;
        if (filteredItem.length > 0) {
          return res.json({
            success: false,
            msg: 'no items found'
          });
        }
      }

      const effMode = req.query.mode !== undefined ? +req.query.mode : (req.mode ?? 3);
      const ratingsRaw = req.cookies?.ratings || req.query.ratings;
      const ratingsArr = (effMode === 3 || effMode === 2) ? null : (ratingsRaw ? (Array.isArray(ratingsRaw) ? ratingsRaw : decodeURIComponent(ratingsRaw).split(/[|,]/)).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null);

      let guestTagFilter = db``;
      if (isPublicVisitor) {
        const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
        const isAnon = session && isAnonSession(session);
        const anonModes = isAnon ? getAnonAllowedModes() : [];
        const allowNsfw = isAnon ? anonModes.includes('nsfw') : cfg.websrv.public_nsfw;
        const allowNsfl = isAnon ? anonModes.includes('nsfl') : false;
        const blockedTags = [];
        if (!allowNsfw) blockedTags.push(2);
        if (!allowNsfl) blockedTags.push(nsflId);
        if (blockedTags.length > 0) {
          guestTagFilter = db`and not exists (select 1 from tags_assign where item_id = items.id and tag_id in ${db(blockedTags)})`;
        }
      }

      const globalFilterCondition = isPublicVisitor && getGlobalfilter(session)
        ? db`and not exists (select 1 from tags_assign where item_id = items.id and (${db.unsafe(getGlobalfilter(session))}))`
        : db``;

      let modeCondition = db``;
      if (effMode === 2) {
        modeCondition = db`and not exists (select 1 from tags_assign where item_id = items.id)`;
      } else if (effMode === 0) {
        modeCondition = db`and (id in (select item_id from tags_assign where tag_id = 1) or not exists (select 1 from tags_assign where item_id = items.id))`;
      } else if (effMode === 1) {
        modeCondition = db`and id in (select item_id from tags_assign where tag_id = 2)`;
      } else if (effMode === 4) {
        modeCondition = db`and id in (select item_id from tags_assign where tag_id = ${parseInt(cfg.nsfl_tag_id, 10) || 3})`;
      } else if (ratingsArr && ratingsArr.length > 0) {
        modeCondition = db`and ${db.unsafe(lib.getMultiRatingMode(ratingsArr))}`;
      }

      const visibilityFilter = isOwnerOrAdmin
        ? db``
        : (session && session.user
          ? db`and (coalesce(visibility, 0) = 0 or lower(username) = ${session.user.toLowerCase()})`
          : db`and coalesce(visibility, 0) = 0`);

      const next = await db`
        select id
        from "items"
        where id > ${id} and active = true ${visibilityFilter} ${guestTagFilter} ${globalFilterCondition} ${modeCondition}
        order by id
        limit 1
      `;
      const prev = await db`
        select id
        from "items"
        where id < ${id} and active = true ${visibilityFilter} ${guestTagFilter} ${globalFilterCondition} ${modeCondition}
        order by id desc
        limit 1
      `;

      const rows = {
        ...actitem,
        next: next[0]?.id ?? null,
        prev: prev[0]?.id ?? null
      };

      if (isAnonymizeSession(req.session)) {
        rows.username = 'anonymous';
        rows.display_name = null;
        rows.user = 'anonymous';
        rows.src = null;
      }

      return res.json({
        success: true,
        rows
      });
    });

    group.get(/\/user\/(?<user>[^\/]+)(\/(?<eps>\d+))?$/, async (req, res) => {
      if (isAnonymizeSession(req.session)) {
        return res.json({ success: false, msg: 'access denied' });
      }
      const user = req.params.user;
      const eps = +req.params.eps || 50;

      const rows = db`
        select id, mime, size, src, stamp, userchannel, username, usernetwork
        from "items"
        where username = ${user} and active = true
        order by stamp desc
        limit ${+eps}
      `;

      return res.json({
        success: rows.length > 0,
        items: rows.length > 0 ? rows : []
      });
    });

    group.get(/\/tags\/suggest$/, async (req, res) => {
      const reply = {
        success: false,
        suggestions: {}
      };

      const searchString = req.url.qs.q;

      if (searchString?.length <= 0) {
        reply.error = 'too short lol';
        return res.json(reply);
      }

      try {
        const q = await db`
          select tag, count(tags_assign.tag_id) as tagged
          from "tags"
          left join "tags_assign" on "tags_assign".tag_id = "tags".id
          where normalized like '%' || slugify(${searchString}) || '%'
          group by "tags".id
          having count(tags_assign.tag_id) > 0
          order by tagged desc
          limit 15
        `;
        reply.success = true;
        reply.suggestions = search(q, searchString);
      } catch (err) {
        reply.error = 'Tag suggestion error';
      }

      return res.json(reply);
    });


    group.get(/\/users\/suggest$/, async (req, res) => {
      if (isAnonymizeSession(req.session)) {
        return res.json({ success: true, suggestions: [] });
      }
      const searchString = req.url.qs.q;
      if (!searchString || searchString.length < 1) {
        return res.json({ success: false, suggestions: [] });
      }

      try {
        const users = await db`
          SELECT "user".user, "user_options".display_name, "user_options".avatar, "user_options".avatar_file
          FROM "user"
          LEFT JOIN "user_options" ON "user".id = "user_options".user_id
          WHERE "user".user ILIKE ${searchString + '%'} 
             OR "user_options".display_name ILIKE ${searchString + '%'}
          ORDER BY "user".user ASC
          LIMIT 10
        `;
        return res.json({ success: true, suggestions: users });
      } catch (err) {
        return res.json({ success: false, error: 'User suggestion error', suggestions: [] });
      }
    });

    group.get(/\/items\/suggest$/, async (req, res) => {
      const searchString = req.url.qs.q;
      if (!searchString || searchString.length < 1) {
        return res.json({ success: false, suggestions: [] });
      }

      try {
        const items = await db`
          SELECT id, title
          FROM items
          WHERE title IS NOT NULL
            AND active = true
            AND title ILIKE ${'%' + searchString + '%'}
          ORDER BY id DESC
          LIMIT 8
        `;
        return res.json({ success: true, suggestions: items });
      } catch (err) {
        return res.json({ success: false, error: 'Item title suggestion error', suggestions: [] });
      }
    });

    // tags lol

    group.put(/\/tags\/rename\/(?<tagname>.*)/, lib.modAuth, async (req, res) => {
      if (!req.params.tagname || !req.post.newtag) {
        return res.json({
          success: false,
          msg: 'missing tagname or newtag',
          debug: {
            params: req.params.tagname,
            post: req.post
          }
        }, 400); // bad request
      }

      const tagname = decodeURIComponent(req.params.tagname);
      const newtag = req.post.newtag;

      if (['sfw', 'nsfw'].includes(tagname) || ['sfw', 'nsfw'].includes(newtag)) {
        return res.json({
          msg: 'f0ck you'
        }, 405); // method not allowed
      }

      const tmptag = (await db`
        select *
        from "tags"
        where tag = ${tagname}
        limit 1
      `)[0];

      if (!tmptag) {
        return res.json({
          success: false,
          msg: 'no tag found'
        }, 404); // not found
      }

      const q = (await db`
        update "tags" set ${db({
        tag: newtag
      }, 'tag')
        }
        where tag = ${tagname}
        returning *
      `)?.[0];

      return res.json(q, tagname === newtag ? 200 : 201); // created (modified)
    });


    // PATCH /api/v2/items/:id/title — set or clear the title for an item
    // Allowed by: item owner, moderators, admins
    group.patch(/\/items\/(?<id>\d+)\/title$/, lib.registeredUser, async (req, res) => {
      const id = +req.params.id;
      if (!id) return res.json({ success: false, msg: 'Invalid item id' }, 400);

      // Fetch item to check ownership
      const rows = await db`SELECT id, username FROM items WHERE id = ${id} AND active = true LIMIT 1`;
      if (!rows.length) return res.json({ success: false, msg: 'Item not found' }, 404);

      const item = rows[0];
      const isOwner    = req.session.user === item.username;
      const isMod      = !!(req.session.is_moderator || req.session.admin);
      if (!isOwner && !isMod) return res.json({ success: false, msg: 'Forbidden' }, 403);

      // Accept title from JSON or URL-encoded body
      let body = req.post || req.body || {};
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) {}
      }
      let rawTitle = body?.title ?? null;
      if (rawTitle !== null) rawTitle = String(rawTitle).trim();
      // Empty string → null (clears the title)
      const title = (rawTitle === '' || rawTitle === null) ? null : rawTitle.substring(0, 500);

      await db`UPDATE items SET title = ${title} WHERE id = ${id}`;

      return res.json({ success: true, title });
    });


    group.post(/\/admin\/deletepost$/, lib.modAuth, async (req, res) => {
      if (req.post.postid === undefined || req.post.postid === null) {
        return res.json({
          success: false,
          msg: 'no postid'
        });
      }
      const id = +req.post.postid;

      if (id < 0) {
        return res.json({
          success: false
        });
      }

      const f0ck = await db`
        select dest, mime, username
        from "items"
        where
          id = ${id} and
          active = true
        limit 1
      `;

      if (f0ck.length === 0) {
        return res.json({
          success: false,
          msg: `f0ck ${id}: f0ck not found`
        });
      }

      await db`update "items" set active = 'false', is_deleted = true where id = ${id}`;

      await fs.copyFile(path.join(cfg.paths.b, f0ck[0].dest), path.join(cfg.paths.deleted, 'b', f0ck[0].dest)).catch(_ => { });
      await fs.copyFile(path.join(cfg.paths.t, `${id}.webp`), path.join(cfg.paths.deleted, 't', `${id}.webp`)).catch(_ => { });
      await fs.unlink(path.join(cfg.paths.b, f0ck[0].dest)).catch(_ => { });
      await fs.unlink(path.join(cfg.paths.b, f0ck[0].dest)).catch(_ => { });
      await fs.unlink(path.join(cfg.paths.t, `${id}.webp`)).catch(_ => { });

      const reason = req.post.reason || 'No reason provided';
      await audit.log(req.session.id, 'delete_item', 'item', id, { filename: f0ck[0].dest, reason });

      // Broadcast live deletion to all connected clients
      db.notify('delete_item', JSON.stringify({ id })).catch(() => {});

      // Notify the uploader via SSE if they have an account
      try {
        if (f0ck[0].username) {
          const uploader = await db`
            SELECT id FROM "user"
            WHERE login = ${f0ck[0].username} OR "user" = ${f0ck[0].username}
            LIMIT 1
          `;
          if (uploader.length > 0 && uploader[0].id !== req.session.id) {
            const uploaderId = uploader[0].id;
            const notifResult = await db`
              INSERT INTO notifications (user_id, type, reference_id, item_id, data)
              VALUES (${uploaderId}, 'item_deleted', 0, ${id}, ${db.json({ reason })})
              RETURNING id
            `;
            if (notifResult.length > 0) {
              await db`SELECT pg_notify('notifications', ${JSON.stringify({
                user_id: uploaderId,
                type: 'item_deleted',
                item_id: id,
                id: notifResult[0].id,
                reason
              })})`;
            }
          }
        }
      } catch (notifErr) {
        console.error('[DELETEPOST] Failed to notify uploader:', notifErr);
      }

      if (f0ck[0].mime.startsWith('audio')) {
        await fs.copyFile(path.join(cfg.paths.ca, `${id}.webp`), path.join(cfg.paths.deleted, 'ca', `${id}.webp`)).catch(_ => { });
        await fs.unlink(path.join(cfg.paths.ca, `${id}.webp`)).catch(_ => { });
      }

      res.json({
        success: true
      });
    });

    group.post(/\/admin\/delete-album-item$/, lib.loggedin, async (req, res) => {
      const postid = +(req.post?.postid ?? req.body?.postid);
      if (!postid || postid <= 0) {
        return res.json({ success: false, msg: 'Invalid postid' }, 400);
      }

      const items = await db`
        SELECT id, dest, mime, username, is_album, album_count, is_deleted, active
        FROM items
        WHERE id = ${postid} AND active = true AND is_deleted = false
        LIMIT 1
      `;
      if (!items.length) {
        return res.json({ success: false, msg: 'Item not found' }, 404);
      }
      const item = items[0];
      if (!item.is_album) {
        return res.json({ success: false, msg: 'Item is not an album' }, 400);
      }

      const isMod = req.session.admin || req.session.is_moderator;
      const isOwner = req.session.user && item.username && req.session.user.toLowerCase() === item.username.toLowerCase();
      if (!isMod && !isOwner) {
        return res.json({ success: false, msg: 'Unauthorized' }, 403);
      }

      const subId = req.post?.sub_id ?? req.post?.subf0ck_id ?? req.body?.sub_id;
      const subSlug = req.post?.sub_slug ?? req.body?.sub_slug;
      const subIndex = req.post?.order_index ?? req.body?.order_index;

      const allSubs = await db`
        SELECT id, item_id, dest, mime, size, checksum, order_index, slug
        FROM album_items
        WHERE item_id = ${postid}
        ORDER BY order_index ASC
      `;
      if (!allSubs.length) {
        return res.json({ success: false, msg: 'No album items found' }, 404);
      }

      let targetSub = null;
      if (subId !== undefined && subId !== null && subId !== '') {
        targetSub = allSubs.find(s => s.id === +subId || s.slug === String(subId));
      }
      if (!targetSub && subSlug) {
        targetSub = allSubs.find(s => s.slug === String(subSlug));
      }
      if (!targetSub && subIndex !== undefined && subIndex !== null && subIndex !== '') {
        targetSub = allSubs.find(s => s.order_index === +subIndex);
      }

      if (!targetSub) {
        return res.json({ success: false, msg: 'Album sub-item not found' }, 404);
      }

      const reason = req.post?.reason || req.body?.reason || 'No reason provided';

      // If this is the last remaining item in the album, delete the whole post
      if (allSubs.length <= 1) {
        await safeDeleteMediaFile(item.dest, postid);
        const thumbName = `${postid}.webp`;
        await fs.unlink(path.join(cfg.paths.t, thumbName)).catch(() => {});
        await fs.unlink(path.join(cfg.paths.t, `${postid}_blur.webp`)).catch(() => {});
        if (item.mime?.startsWith('audio')) {
          await fs.unlink(path.join(cfg.paths.ca, thumbName)).catch(() => {});
        }
        await db`DELETE FROM album_items_tags_assign WHERE album_item_id = ${targetSub.id}`.catch(() => {});
        await db`DELETE FROM album_items WHERE id = ${targetSub.id}`.catch(() => {});
        await db`UPDATE items SET active = false, is_deleted = true WHERE id = ${postid}`;
        await audit.log(req.session.id, 'delete_item', 'item', postid, { filename: item.dest, reason });
        db.notify('delete_item', JSON.stringify({ id: postid })).catch(() => {});
        return res.json({ success: true, post_deleted: true, msg: 'Last album item removed, post deleted' });
      }

      // Multi-item album: safely remove this sub-item media
      if (targetSub.dest && !targetSub.dest.startsWith('yt:')) {
        await safeDeleteMediaFile(targetSub.dest, postid);
        const subBase = targetSub.dest.replace(/\.[^.]+$/, '');
        await fs.unlink(path.join(cfg.paths.t, `${subBase}.webp`)).catch(() => {});
        if (targetSub.mime?.startsWith('audio')) {
          await fs.unlink(path.join(cfg.paths.ca, `${subBase}.webp`)).catch(() => {});
        }
      } else if (targetSub.dest?.startsWith('yt:')) {
        await fs.unlink(path.join(cfg.paths.t, `${targetSub.id}.webp`)).catch(() => {});
      }

      await db`DELETE FROM album_items_tags_assign WHERE album_item_id = ${targetSub.id}`.catch(() => {});
      await db`DELETE FROM album_items WHERE id = ${targetSub.id}`;

      const remainingSubs = allSubs.filter(s => s.id !== targetSub.id);
      const isCoverDeleted = targetSub.order_index === 0;

      // Re-index remaining album items so order_index is contiguous
      await db`
        UPDATE album_items
        SET order_index = order_index - 1
        WHERE item_id = ${postid} AND order_index > ${targetSub.order_index}
      `;

      if (isCoverDeleted) {
        const newCover = remainingSubs[0];
        await db`
          UPDATE items
          SET dest = ${newCover.dest},
              mime = ${newCover.mime},
              size = ${newCover.size || 0},
              checksum = ${newCover.checksum || ''},
              album_count = ${remainingSubs.length}
          WHERE id = ${postid}
        `;
        try {
          await queue.genThumbnail(newCover.dest, newCover.mime, postid, '');
          await queue.genBlurredThumbnail(postid);
        } catch (thumbErr) {
          console.error('[DELETE-ALBUM-ITEM] Failed to regen thumbnail for promoted cover:', thumbErr);
        }
      } else {
        await db`
          UPDATE items
          SET album_count = ${remainingSubs.length}
          WHERE id = ${postid}
        `;
      }

      await audit.log(req.session.id, 'delete_album_item', 'album_item', targetSub.id, {
        postid,
        filename: targetSub.dest,
        order_index: targetSub.order_index,
        reason
      });

      return res.json({
        success: true,
        post_deleted: false,
        deleted_sub_id: targetSub.id,
        deleted_order_index: targetSub.order_index,
        remaining_count: remainingSubs.length,
        promoted_cover: isCoverDeleted
      });
    });

    group.post(/\/togglefav$/, lib.loggedin, async (req, res) => {
      if (isAnonSession(req.session) && !canAnonDo('favorite')) {
        return res.json({ success: false, msg: 'Anonymous favorites are disabled' }, 403);
      }
      const rawPostid = req.post?.postid ?? req.body?.postid ?? req.url?.qs?.postid;
      if (rawPostid === undefined || rawPostid === null) {
        return res.json({ success: false, msg: 'Missing postid' }, 400);
      }

      // Support both numeric item ID and string slug
      const isNumeric = /^\d+$/.test(String(rawPostid));
      let itemRow = await db`
        SELECT id FROM items
        WHERE ${isNumeric ? db`id = ${+rawPostid}` : db`slug = ${String(rawPostid)}`} AND active = true AND is_deleted = false
        LIMIT 1
      `;

      if (!itemRow.length) {
        const chanUrl = req.post?.chan_url ?? req.body?.chan_url ?? req.post?.url ?? req.body?.url;
        if (chanUrl) {
          itemRow = await db`
            SELECT id FROM items
            WHERE src = ${chanUrl} AND active = true AND is_deleted = false
            LIMIT 1
          `;
        }
        if (!itemRow.length && isNumeric) {
          itemRow = await db`
            SELECT id FROM items
            WHERE (src LIKE ${'%/' + rawPostid + '.%'} OR src LIKE ${'%/' + rawPostid + 's.%'}) AND active = true AND is_deleted = false
            LIMIT 1
          `;
        }
      }

      if (!itemRow.length) {
        return res.json({ success: false, msg: 'Item not found' }, 404);
      }

      const postid = itemRow[0].id;

      // Check if already faved by this user — compare as numbers to avoid type mismatch
      const existing = await db`
        select 1 from "favorites"
        where item_id = ${+postid} and user_id = ${+req.session.id}
        limit 1
      `;

      let favorited = false;
      const reqAction = req.post?.action ?? req.body?.action;
      const reqFavorited = req.post?.favorited ?? req.body?.favorited;
      let shouldFav;
      if (reqAction === 'add' || reqAction === 'favorite' || reqFavorited === true || reqFavorited === 'true') {
        shouldFav = true;
      } else if (reqAction === 'delete' || reqAction === 'remove' || reqAction === 'unfavorite' || reqFavorited === false || reqFavorited === 'false') {
        shouldFav = false;
      } else {
        shouldFav = existing.length === 0;
      }

      if (!shouldFav) {
        if (existing.length > 0) {
          // del fav
          await db`
            delete from "favorites"
            where user_id = ${+req.session.id}
            and item_id = ${+postid}
          `;
          f0cklib.updateUserAffinity({ user_id: req.session.id, item_id: +postid, scoreDelta: -5.0 }).catch(() => {});
          if (req.session?.is_anon) {
            await logAnonActivity(req, { action: 'unfavorite', targetId: postid });
          }
        }
        favorited = false;
      } else {
        if (existing.length === 0) {
          // add fav — ON CONFLICT DO NOTHING guards against rapid double-taps
          await db`
            insert into "favorites" ${db({
              item_id: +postid,
              user_id: +req.session.id
            }, 'item_id', 'user_id')}
            on conflict do nothing
          `;
          f0cklib.updateUserAffinity({ user_id: req.session.id, item_id: +postid, scoreDelta: 5.0 }).catch(() => {});
          if (req.session?.is_anon) {
            await logAnonActivity(req, { action: 'favorite', targetId: postid });
          }
        }
        favorited = true;
      }

      const favs = await db`
        select "favorites".user_id, "user".user, "user".login, "user_options".avatar, "user_options".avatar_file, "user_options".display_name, "user_options".username_color, "user_options".hide_fav_badge, "anon_identities".fingerprint as anon_fingerprint
        from "favorites"
        left join "user" on "user".id = "favorites".user_id
        left join "user_options" on "user_options".user_id = "favorites".user_id
        left join "anon_identities" on "anon_identities".user_id = "favorites".user_id
        where "favorites".item_id = ${+postid}
      `;

      // Sanitize shadow anonymous accounts in favs list
      const sanitizedFavs = favs.map(f => {
        if (f.anon_fingerprint || f.user === 'anonymous' || (typeof f.user === 'string' && f.user.startsWith('anon_'))) {
          return {
            user_id: null,
            user: 'anonymous',
            login: 'anonymous',
            display_name: 'Anonymous',
            avatar: null,
            avatar_file: null,
            username_color: null,
            hide_fav_badge: true,
            is_anon: true
          };
        }
        return f;
      });

      // Notify for live update
      db.notify('favorites', JSON.stringify({
        item_id: postid,
        user_id: req.session.id,
        favorited: favorited,
        favs: sanitizedFavs
      }));

      // If the caller is in anonymous mode, strip other users' identities
      const isCallerAnonymized = isAnonymizeSession(req.session);
      const clientFavs = isCallerAnonymized
        ? favs.map(f => {
            const isSelf = req.session && req.session.id && f.user_id && Number(f.user_id) === Number(req.session.id);
            if (isSelf) return f;
            return {
              user_id: null,
              user: 'anonymous',
              login: 'anonymous',
              display_name: 'Anonymous',
              avatar: null,
              avatar_file: null,
              username_color: null,
              hide_fav_badge: f.hide_fav_badge,
              is_anon: true
            };
          })
        : sanitizedFavs;

      return res.json({
        success: true,
        itemid: postid,
        favorited: favorited,
        favs: clientFavs
      });
    });

    group.post(/\/favorites\/import$/, lib.loggedin, async (req, res) => {
      if (isAnonSession(req.session) && !canAnonDo('favorite')) {
        return res.json({ success: false, msg: 'Anonymous favorites are disabled' }, 403);
      }
      try {
        const rawIds = req.post?.ids ?? req.body?.ids;
        let ids = [];
        if (Array.isArray(rawIds)) {
          ids = rawIds.map(Number);
        } else if (typeof rawIds === 'string') {
          ids = rawIds.split(',').map(Number);
        }
        ids = ids.filter(n => Number.isInteger(n) && n > 0);

        if (ids.length === 0) {
          return res.json({ success: true, imported: 0 });
        }

        // Limit import batch to 500 items max for safety
        const sliceIds = ids.slice(0, 500);

        // Fetch valid existing items
        const validItems = await db`
          SELECT id FROM items WHERE id = ANY(${sliceIds}::int[]) AND active = true AND is_deleted = false
        `;
        const validIds = validItems.map(i => i.id);

        let count = 0;
        for (const itemId of validIds) {
          const inserted = await db`
            INSERT INTO favorites (user_id, item_id)
            VALUES (${req.session.id}, ${itemId})
            ON CONFLICT DO NOTHING
            RETURNING item_id
          `;
          if (inserted.length > 0) {
            count++;
            f0cklib.updateUserAffinity({ user_id: req.session.id, item_id: itemId, scoreDelta: 5.0 }).catch(() => {});
          }
        }

        if (req.session?.is_anon) {
          await logAnonActivity(req, { action: 'favorites_import', details: { count } });
        }

        return res.json({ success: true, imported: count });
      } catch (err) {
        console.error('[FAVORITES_IMPORT_ERROR]', err);
        return res.status(500).json({ success: false, message: err.message });
      }
    });
    
    group.post(/\/toggle-oc$/, lib.registeredUser, async (req, res) => {
        const postid = +req.post.postid;
        if (!postid) return res.json({ success: false, msg: 'No postid provided' }, 400);

        const item = await db`
            SELECT id, username, is_oc 
            FROM items 
            WHERE id = ${postid} AND active = true AND is_deleted = false
            LIMIT 1
        `;

        if (item.length === 0) {
            return res.json({ success: false, msg: 'Item not found' }, 404);
        }

        const isOwner = item[0].username === req.session.user;
        const isAdmin = req.session.admin || req.session.is_moderator;

        if (!isOwner && !isAdmin) {
            return res.json({ success: false, msg: 'Unauthorized' }, 403);
        }

        const newStatus = !item[0].is_oc;
        
        await db.begin(async sql => {
            await sql`UPDATE items SET is_oc = ${newStatus} WHERE id = ${postid}`;

            const tagsToSync = ['oc', 'original content'];
            
            if (newStatus) {
                // Add tags
                for (const tagname of tagsToSync) {
                    const normalized = lib.slugify(tagname);
                    let tag = (await sql`SELECT id FROM tags WHERE normalized = ${normalized}`)[0];
                    
                    if (!tag) {
                        tag = (await sql`INSERT INTO tags (tag, normalized) VALUES (${tagname}, ${normalized}) RETURNING id`)[0];
                    }

                    // Assign to item if not already assigned
                    await sql`
                        INSERT INTO tags_assign (item_id, tag_id, user_id)
                        VALUES (${postid}, ${tag.id}, ${req.session.id})
                        ON CONFLICT DO NOTHING
                    `;
                    
                    audit.log(req.session.id, 'add_tag', 'item', postid, { tag: tagname, auto: true }).catch(() => {});
                }
            } else {
                // Remove tags
                const tagIds = (await sql`
                    SELECT id FROM tags 
                    WHERE normalized IN (${lib.slugify(tagsToSync[0])}, ${lib.slugify(tagsToSync[1])})
                `).map(t => t.id);

                if (tagIds.length > 0) {
                    await sql`
                        DELETE FROM tags_assign 
                        WHERE item_id = ${postid} 
                        AND tag_id = ANY(${tagIds})
                    `;
                }
                
                for (const tagname of tagsToSync) {
                    audit.log(req.session.id, 'delete_tag', 'item', postid, { tag: tagname, auto: true, reason: 'OC status removed' }).catch(() => {});
                }
            }
        });

        audit.log(req.session.id, 'toggle_oc', 'item', postid, { old: item[0].is_oc, new: newStatus }).catch(() => {});

        // Notify that tags have changed for this item
        const freshTags = await lib.getTags(postid);
        db.notify('tags', JSON.stringify({ item_id: postid, fresh: true, tags: freshTags })).catch(() => {});

        return res.json({
            success: true,
            is_oc: newStatus,
            tags: freshTags
        });
    });

    group.post(/\/item\/visibility$/, lib.registeredUser, async (req, res) => {
        if (cfg.enable_private_uploads === false && !req.session?.admin) {
            return res.json({ success: false, msg: 'Private uploads feature disabled' }, 403);
        }
        const postid = req.post?.postid || req.post?.id || req.body?.postid || req.body?.id;
        const visibility = parseInt(req.post?.visibility ?? req.body?.visibility, 10);
        if (!postid || isNaN(visibility) || ![0, 1, 2, 3].includes(visibility)) {
            return res.json({ success: false, msg: 'Invalid parameters' }, 400);
        }

        const isNumeric = /^\d+$/.test(String(postid));
        const item = await db`
            SELECT id, slug, username, visibility, dest
            FROM items
            WHERE ${isNumeric ? db`id = ${+postid}` : db`slug = ${String(postid)}`} AND active = true AND is_deleted = false
            LIMIT 1
        `;

        if (item.length === 0) {
            return res.json({ success: false, msg: 'Item not found' }, 404);
        }

        const isOwner = item[0].username === req.session.user;
        const isAdmin = req.session.admin || req.session.is_moderator;

        if (!isOwner && !isAdmin) {
            return res.json({ success: false, msg: 'Unauthorized' }, 403);
        }

        if (visibility === 3 && !isAdmin) {
            return res.json({ success: false, msg: 'Only moderators or administrators can make an item unavailable' }, 403);
        }

        await db`UPDATE items SET visibility = ${visibility} WHERE id = ${item[0].id}`;

        if (visibility === 2) {
            addPrivateItem(item[0].id, item[0].dest, item[0].username);
            removeUnavailableItem(item[0].id, item[0].dest);
        } else if (visibility === 3) {
            addUnavailableItem(item[0].id, item[0].dest, item[0].username);
            removePrivateItem(item[0].id, item[0].dest);
        } else {
            removePrivateItem(item[0].id, item[0].dest);
            removeUnavailableItem(item[0].id, item[0].dest);
        }

        f0cklib.clearCountCache();

        return res.json({
            success: true,
            itemid: item[0].id,
            slug: item[0].slug,
            visibility: visibility
        });
    });

    // Bulk visibility for the mod/admin selection bar: same levels and side effects as /item/visibility
    group.post(/\/items\/bulk-visibility$/, lib.loggedin, async (req, res) => {
        const isModOrAdmin = !!(req.session?.admin || req.session?.is_moderator);
        if (!isModOrAdmin) {
            return res.json({ success: false, msg: 'Bulk selection is only available to administrators and moderators' }, 403);
        }
        if (cfg.enable_private_uploads === false && !req.session.admin) {
            return res.json({ success: false, msg: 'Private uploads feature disabled' }, 403);
        }

        const visibility = parseInt(req.body?.visibility ?? req.post?.visibility, 10);
        if (isNaN(visibility) || ![0, 1, 2, 3].includes(visibility)) {
            return res.json({ success: false, msg: 'Invalid visibility' }, 400);
        }
        const rawIds = req.body?.item_ids || req.post?.item_ids;
        if (!Array.isArray(rawIds) || rawIds.length === 0) {
            return res.json({ success: false, msg: 'No items selected' }, 400);
        }
        const itemIds = [...new Set(rawIds.map(id => +id).filter(id => Number.isInteger(id) && id > 0))].slice(0, 500);
        if (itemIds.length === 0) {
            return res.json({ success: false, msg: 'Invalid item IDs' }, 400);
        }

        try {
            const items = await db`
                SELECT id, dest, username, COALESCE(visibility, 0) AS visibility
                FROM items
                WHERE id = ANY(${itemIds}::int[]) AND active = true AND is_deleted = false
            `;
            const changed = items.filter(it => it.visibility !== visibility);
            if (changed.length === 0) {
                return res.json({ success: true, updated: 0, visibility, msg: 'Nothing to change' });
            }

            await db`UPDATE items SET visibility = ${visibility} WHERE id = ANY(${changed.map(it => it.id)}::int[])`;

            for (const it of changed) {
                if (visibility === 2) {
                    addPrivateItem(it.id, it.dest, it.username);
                    removeUnavailableItem(it.id, it.dest);
                } else if (visibility === 3) {
                    addUnavailableItem(it.id, it.dest, it.username);
                    removePrivateItem(it.id, it.dest);
                } else {
                    removePrivateItem(it.id, it.dest);
                    removeUnavailableItem(it.id, it.dest);
                }
            }

            f0cklib.clearCountCache();
            await audit.log(req.session.id, 'bulk_set_visibility', 'items', null, {
                item_ids: changed.map(it => it.id),
                visibility
            }).catch(() => {});

            return res.json({ success: true, updated: changed.length, item_ids: changed.map(it => it.id), visibility });
        } catch (err) {
            console.error('[BULK VISIBILITY]', err);
            return res.json({ success: false, msg: 'Failed to update visibility' }, 500);
        }
    });

    group.post(/\/items\/(?<id>[0-9]+)\/rethumb$/, lib.registeredUser, async (req, res) => {
        const itemid = +req.params.id;
        if (!itemid) return res.json({ success: false, msg: 'No itemid provided' }, 400);

        const rows = await db`
            SELECT id, dest, mime, username, src
            FROM items
            WHERE id = ${itemid} AND active = true AND is_deleted = false
            LIMIT 1
        `;
        if (!rows.length) return res.json({ success: false, msg: 'Item not found' }, 404);

        const item = rows[0];
        const isOwner = item.username === req.session.user;
        const isAdmin = !!(req.session.admin || req.session.is_moderator);
        if (!isOwner && !isAdmin) return res.json({ success: false, msg: 'Unauthorized' }, 403);

        const ok = await queue.genThumbnail(item.dest, item.mime, item.id, item.src || '', false);
        await queue.genBlurredThumbnail(item.id, false);

        let hasCoverart = false;
        if (item.mime && item.mime.startsWith('audio/')) {
            const caFile = path.join(cfg.paths.ca, `${item.id}.webp`);
            hasCoverart = !!queue._lastCoverExtracted;
            if (!hasCoverart) {
                try {
                    const stat = await fs.stat(caFile);
                    hasCoverart = stat.size > 0;
                } catch (_) {}
            }
            await db`UPDATE items SET has_coverart = ${hasCoverart} WHERE id = ${item.id}`;
        }

        if (ok) {
            db.notify('rethumb', JSON.stringify({ item_id: item.id, has_coverart: hasCoverart })).catch(() => {});
            audit.log(req.session.id, 'rethumb_item', 'item', item.id, {}).catch(() => {});
            return res.json({ success: true, itemid: item.id, has_coverart: hasCoverart });
        } else {
            return res.json({ success: false, msg: 'Thumbnail regeneration failed' }, 500);
        }
    });

    group.post(/\/items\/(?<id>[0-9]+)\/expiry$/, lib.registeredUser, async (req, res) => {
        if (cfg.enable_expiring_uploads === false || cfg.websrv?.enable_expiring_uploads === false) {
            return res.json({ success: false, msg: 'Expiring uploads feature is disabled' }, 403);
        }

        const itemid = +req.params.id;
        if (!itemid) return res.json({ success: false, msg: 'No itemid provided' }, 400);

        const rows = await db`
            SELECT id, username, expires_at
            FROM items
            WHERE id = ${itemid} AND active = true AND is_deleted = false
            LIMIT 1
        `;
        if (!rows.length) return res.json({ success: false, msg: 'Item not found' }, 404);

        const item = rows[0];
        const isOwner = item.username === req.session.user;
        const isAdmin = !!(req.session.admin || req.session.is_moderator);
        if (!isOwner && !isAdmin) return res.json({ success: false, msg: 'Unauthorized' }, 403);

        const reqExpiry = req.body?.expiry ?? req.body?.expires_at ?? req.post?.expiry ?? req.post?.expires_at;
        const nowStamp = Math.floor(Date.now() / 1000);
        const targetExpiresAt = calculateExpiresAt(reqExpiry, nowStamp);

        await db`UPDATE items SET expires_at = ${targetExpiresAt} WHERE id = ${item.id}`;
        audit.log(req.session.id, 'set_item_expiry', 'item', item.id, { expires_at: targetExpiresAt }).catch(() => {});

        if (targetExpiresAt && targetExpiresAt <= nowStamp) {
            await purgeExpiredUploads().catch(err => {
                console.error('[API ITEM EXPIRY] Purge failed:', err);
            });
        }

        const expires_in = targetExpiresAt ? lib.expiresIn(targetExpiresAt) : null;

        return res.json({
            success: true,
            itemid: item.id,
            expires_at: targetExpiresAt,
            expires_in: expires_in,
            purged: !!(targetExpiresAt && targetExpiresAt <= nowStamp)
        });
    });

    const ratingAuth = (req, res, next) => {
      if (!req.session) {
        return res.json({ success: false, msg: 'Unauthorized' }, 401);
      }
      if (isAnonSession(req.session)) {
        if (!canAnonDo('rate_item')) {
          return res.json({ success: false, msg: 'Anonymous rating is disabled' }, 403);
        }
        return next();
      }
      return lib.registeredUser(req, res, next);
    };

    group.post(/\/item\/(?<id>[0-9]+)\/rating$/, ratingAuth, async (req, res) => {
        const itemid = +req.params.id;
        if (!itemid) return res.json({ success: false, msg: 'No itemid provided' }, 400);

        const item = await db`
            SELECT id, username, active, is_deleted 
            FROM items 
            WHERE id = ${itemid} AND active = true AND is_deleted = false
            LIMIT 1
        `;

        if (item.length === 0) {
            return res.json({ success: false, msg: 'Item not found' }, 404);
        }

        const ownerName = getSessionOwnerName(req.session);
        const isOwner = !!(item[0].username && ownerName && item[0].username.toLowerCase() === ownerName.toLowerCase());
        const isAdmin = !!(req.session.admin || req.session.is_moderator);

        if (!isOwner && !isAdmin) {
            return res.json({ success: false, msg: 'Unauthorized' }, 403);
        }

        const nsflTagRow = await db`SELECT id FROM tags WHERE normalized = 'nsfl' LIMIT 1`;
        const nsfl_id = nsflTagRow.length > 0 ? nsflTagRow[0].id : (cfg.nsfl_tag_id || 11517);
        let newRatingId;
        let currentRatingId = null;

        const subf0ck = req.body?.subf0ck_id || req.post?.subf0ck_id || req.url?.qs?.subf0ck_id || null;
        let albumItemId = null;
        if (subf0ck) {
            if (Number.isInteger(+subf0ck) && +subf0ck > 0) {
                const row = await db`SELECT id FROM album_items WHERE (id = ${+subf0ck} OR (item_id = ${itemid} AND order_index = ${+subf0ck})) AND item_id = ${itemid} LIMIT 1`;
                albumItemId = row?.[0]?.id || null;
            }
            if (!albumItemId) {
                const row = await db`SELECT id FROM album_items WHERE slug = ${String(subf0ck)} AND item_id = ${itemid} LIMIT 1`;
                albumItemId = row?.[0]?.id || null;
            }
        }

        await db.begin(async sql => {
            // Lock the item row exclusively so any concurrent rating update for this post MUST wait
            await sql`SELECT id FROM items WHERE id = ${itemid} FOR UPDATE`;

            if (albumItemId) {
                const existingRating = await sql`
                    SELECT tag_id FROM album_items_tags_assign 
                    WHERE album_item_id = ${albumItemId} 
                      AND tag_id IN (1, 2, ${nsfl_id})
                    LIMIT 1
                `;
                currentRatingId = existingRating.length > 0 ? existingRating[0].tag_id : null;
            } else {
                const existingRating = await sql`
                    SELECT tag_id FROM tags_assign 
                    WHERE item_id = ${itemid} 
                      AND (tag_id IN (1, 2, ${nsfl_id}) OR tag_id IN (SELECT id FROM tags WHERE normalized IN ('sfw', 'nsfw', 'nsfl')))
                    ORDER BY tag_id DESC
                    LIMIT 1
                `;
                currentRatingId = existingRating.length > 0 ? existingRating[0].tag_id : null;
            }

            const reqRating = req.body?.rating || req.post?.rating || req.url?.qs?.rating;
            if (reqRating === 'sfw') {
                newRatingId = 1;
            } else if (reqRating === 'nsfw') {
                newRatingId = 2;
            } else if (reqRating === 'nsfl') {
                newRatingId = nsfl_id;
            } else {
                // fallback to cycling
                if (currentRatingId === 1) {
                    newRatingId = 2; // SFW -> NSFW
                } else if (currentRatingId === 2) {
                    newRatingId = cfg.enable_nsfl ? nsfl_id : 1; // NSFW -> NSFL (if enabled) or SFW
                } else {
                    newRatingId = 1; // NSFL or none -> SFW
                }
            }

            if (albumItemId) {
                await sql`
                    DELETE FROM album_items_tags_assign
                    WHERE album_item_id = ${albumItemId} AND tag_id IN (1, 2, ${nsfl_id})
                `;
                if (newRatingId > 0) {
                    await sql`
                        INSERT INTO album_items_tags_assign (album_item_id, tag_id, user_id)
                        VALUES (${albumItemId}, ${newRatingId}, ${req.session.id})
                    `;
                }
            } else {
                // Remove ALL existing rating tags for this item atomically
                await sql`
                    DELETE FROM tags_assign 
                    WHERE item_id = ${itemid} 
                      AND (tag_id IN (1, 2, ${nsfl_id}) OR tag_id IN (SELECT id FROM tags WHERE normalized IN ('sfw', 'nsfw', 'nsfl')))
                `;
                
                // Insert new rating tag
                if (newRatingId > 0) {
                    await sql`
                        INSERT INTO tags_assign (item_id, tag_id, user_id)
                        VALUES (${itemid}, ${newRatingId}, ${req.session.id})
                    `;
                }

                // Propagate rating to all album sub-items if this is an album
                const albumCheck = await sql`SELECT id FROM items WHERE id = ${itemid} AND is_album = true LIMIT 1`;
                if (albumCheck.length > 0) {
                    await sql`
                        DELETE FROM album_items_tags_assign
                        WHERE album_item_id IN (SELECT id FROM album_items WHERE item_id = ${itemid})
                          AND tag_id IN (1, 2, ${nsfl_id})
                    `;
                    if (newRatingId > 0) {
                        await sql`
                            INSERT INTO album_items_tags_assign (album_item_id, tag_id, user_id)
                            SELECT id, ${newRatingId}, ${req.session.id}
                            FROM album_items
                            WHERE item_id = ${itemid}
                            ON CONFLICT DO NOTHING
                        `.catch(() => {});
                    }
                }
            }

            // Ensure blurred thumbnail exists
            await queue.genBlurredThumbnail(itemid).catch(err => {
                console.error(`[RATING_TOGGLE] Blurred thumbnail generation failed for ${itemid}:`, err);
            });
        });

        const newRating = newRatingId === 1 ? 'sfw' : (newRatingId === 2 ? 'nsfw' : 'nsfl');
        const ratingLabels = { 1: 'sfw', 2: 'nsfw', [nsfl_id]: 'nsfl' };
        const oldRating = currentRatingId ? ratingLabels[currentRatingId] : 'none';
        audit.log(req.session.id, 'update_rating', 'item', itemid, { old: oldRating, new: newRating, subf0ck_id: subf0ck }).catch(() => {});

        // Notify that tags have changed
        const freshTags = await lib.getTags(itemid, req.session, subf0ck);
        db.notify('tags', JSON.stringify({ item_id: itemid, subf0ck_id: subf0ck, fresh: true, tags: freshTags })).catch(() => {});

        return res.json({
            success: true,
            itemid: itemid,
            subf0ck_id: subf0ck,
            rating: newRating,
            tags: freshTags
        });
    });

    // Scroller meta refresh — GET /api/v2/scroller/meta?ids=1,2,3
    group.get(/^\/scroller\/meta\/?$/, async (req, res) => {
      const ids = (req.url.qs?.ids || '').split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n > 0).slice(0, 50);
      if (!ids.length) return res.json({});
      const sid = req.session ? +req.session.id : null;
      try {
        const rows = await db`
          SELECT items.id,
            (SELECT string_agg(t.tag, ', ' ORDER BY ta2.tag_id) FROM tags_assign ta2 JOIN tags t ON t.id = ta2.tag_id WHERE ta2.item_id = items.id AND ta2.tag_id > 2 LIMIT 5) AS tag_list,
            (SELECT COUNT(*) FROM favorites WHERE favorites.item_id = items.id) AS fav_count,
            (SELECT COUNT(*) FROM comments WHERE comments.item_id = items.id AND comments.is_deleted = false) AS comment_count,
            ${sid ? db`EXISTS (SELECT 1 FROM favorites WHERE favorites.item_id = items.id AND favorites.user_id = ${sid})` : db`false`} AS is_faved
          FROM items WHERE items.id = ANY(${ids}::int[])
        `;
        const result = {};
        for (const row of rows) result[row.id] = { tags: row.tag_list || '', fav_count: +row.fav_count || 0, comment_count: +row.comment_count || 0, is_faved: row.is_faved || false };
        return res.reply({ headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(result) });
      } catch { return res.json({}); }
    });

  });

  return router;
};
