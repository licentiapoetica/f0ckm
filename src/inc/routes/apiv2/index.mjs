import { promises as fs } from "fs";
import db from '../../sql.mjs';
import lib from '../../lib.mjs';
import cfg from '../../config.mjs';
import queue from '../../queue.mjs';
import search from '../../routeinc/search.mjs';
import path from "path";
import f0cklib from '../../routeinc/f0cklib.mjs';
import audit from '../../audit.mjs';
import { parseMultipart, collectBody } from '../../multipart.mjs';

const allowedMimes = ["audio", "image", "video", "%"];
const globalfilter = cfg.nsfp?.length ? cfg.nsfp.map(n => `tag_id = ${n}`).join(' or ') : null;
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

    // F-002 Security: Require authentication to prevent SSRF via arbitrary URL fetching.
    // Guests use cached entries from DB (populated by authenticated user requests).
    group.get(/\/meta\/fetch$/, lib.loggedin, async (req, res) => {
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

        // 1. YouTube: go straight to oEmbed — faster and more reliable than yt-dlp for these
        if (isYouTube) {
            try {
                const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
                const { stdout: oembedOut } = await queue.spawn('curl', [
                    '-s', '--max-time', '10', '--fail',
                    '--user-agent', 'Mozilla/5.0 (compatible; oEmbed)',
                    ...(socksH ? ['--proxy', socksH] : []),
                    oembedUrl
                ]);
                if (oembedOut && oembedOut.trim()) {
                    const data = JSON.parse(oembedOut);
                    if (data.title) {
                        const meta = {
                            title: data.title,
                            site_name: 'youtube.com',
                            author: data.author_name || 'Unknown'
                        };
                        await setCache(url, meta);
                        return res.json({
                            success: true,
                            meta
                        });
                    }
                }
            } catch (oembedErr) {
                console.error(`[META-FETCH] YouTube oEmbed failed:`, oembedErr.message || oembedErr);
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

    group.get(/\/random(\/user\/.+|\/image|\/video|\/audio)?$/, async (req, res) => {
      const pathParts = req.url.pathname.split('/');
      // /api/v2/random/user/name -> segments are ["", "api", "v2", "random", "user", "name"]
      const pathUser = (pathParts[4] === "user") ? pathParts[5] : null;
      const user = req.url.qs.user || pathUser || null;

      const pathMime = allowedMimes.includes(pathParts[4]) ? pathParts[4] : "";
      const mime = req.url.qs.mime || pathMime || (req.cookies.mime || null);

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
        session: !!req.session,
        exclude: req.session?.excluded_tags || []
      });

      if (!data.itemid) {
        return res.json({
          success: false,
          items: []
        });
      }

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
      const relativeDest = isYouTube ? item.dest : `${cfg.websrv.paths.images}/${item.dest}`;
      const directUrl = isYouTube ? item.dest : `${cfg.main.url.full}${cfg.websrv.paths.images}/${item.dest}`;

      const { username, src, xd_score, ...safeItem } = item;

      return res.json({
        success: true,
        items: {
          ...safeItem,
          id: item.id,
          dest: relativeDest,
          url: directUrl,
          direct_url: directUrl
        }
      });
    });
    
    group.get(/\/orakel\/user$/, async (req, res) => {
      try {
        const now = ~~(Date.now() / 1000);
        const thirtyDaysAgo = now - 2592000; // 30 days in seconds

        // Tiered selection from user.last_seen (updated fire-and-forget on every authenticated request):
        // Tier 0 — active in last 15 minutes
        // Tier 1 — active in last 24 hours
        // Tier 2 — active in last 30 days (includes lurkers — anyone who visited the site)
        // Banned users are always excluded.
        let activeUsers = await db`
          SELECT "user"."user", "user".id, uo.display_name
          FROM "user"
          LEFT JOIN user_options uo ON uo.user_id = "user".id
          WHERE "user".last_seen > ${thirtyDaysAgo}
            AND "user".banned = false
          ORDER BY (CASE
              WHEN "user".last_seen > ${now - 900}   THEN 0
              WHEN "user".last_seen > ${now - 86400} THEN 1
              ELSE 2
          END), RANDOM()
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

      const newest = (await db`select max(id) as id from "items"`)[0].id;
      const oldest = (await db`select min(id) as id from "items"`)[0].id;
      const modequery = lib.getMode(opt.mode);

      const rows = (await db`
        select "items".id, "items".mime, coalesce("tags_assign".tag_id, 0) as tag_id
        from "items"
        left join "tags_assign" on "tags_assign".item_id = "items".id and ("tags_assign".tag_id = 1 or "tags_assign".tag_id = 2 or "tags_assign".tag_id = ${cfg.nsfl_tag_id || 3})
        where
          ${db.unsafe(modequery)} and
          active = true
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
        atEnd: rows[0].id === newest,
        atStart: rows[rows.length - 1].id === oldest,
        success: true,
        items: rows
      }, 200);
    });

    group.get(/\/item\/(?<id>[0-9]+)$/, async (req, res) => {
      const id = +req.params.id;

      const item = await db`
        select *
        from "items"
        where id = ${+id} and active = true
        limit 1
      `;
      const next = await db`
        select id
        from "items"
        where id > ${+id} and active = true
        order by id
        limit 1
      `;
      const prev = await db`
        select id
        from "items"
        where id < ${+id} and active = true
        order by id desc
        limit 1
      `;

      if (item.length === 0) {
        return res.json({
          success: false,
          msg: 'no items found'
        });
      }

      const rows = {
        ...item[0],
        ...{
          next: next[0]?.id ?? null,
          prev: prev[0]?.id ?? null
        }
      };

      return res.json({
        success: true,
        rows
      });
    });

    group.get(/\/user\/(?<user>[^\/]+)(\/(?<eps>\d+))?$/, async (req, res) => {
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
    group.patch(/\/items\/(?<id>\d+)\/title$/, lib.loggedin, async (req, res) => {
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
      let rawTitle = req.post?.title ?? req.body?.title ?? null;
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

    group.post(/\/togglefav$/, lib.loggedin, async (req, res) => {
      const postid = +req.post.postid;

      // Check if already faved by this user — compare as numbers to avoid type mismatch
      const existing = await db`
        select 1 from "favorites"
        where item_id = ${+postid} and user_id = ${+req.session.id}
        limit 1
      `;

      if (existing.length > 0) {
        // del fav
        await db`
          delete from "favorites"
          where user_id = ${+req.session.id}
          and item_id = ${+postid}
        `;
      } else {
        // add fav — ON CONFLICT DO NOTHING guards against rapid double-taps
        await db`
          insert into "favorites" ${db({
            item_id: +postid,
            user_id: +req.session.id
          }, 'item_id', 'user_id')}
          on conflict do nothing
        `;
      }

      const favs = await db`
        select "user".user, "user_options".avatar, "user_options".avatar_file, "user_options".display_name, "user_options".username_color
        from "favorites"
        left join "user" on "user".id = "favorites".user_id
        left join "user_options" on "user_options".user_id = "favorites".user_id
        where "favorites".item_id = ${+postid}
      `;

      // Notify for live update
      db.notify('favorites', JSON.stringify({
        item_id: postid,
        favs: favs
      }));

      return res.json({
        success: true,
        itemid: postid,
        favs
      });
    });
    
    group.post(/\/toggle-oc$/, lib.loggedin, async (req, res) => {
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

    group.post(/\/item\/(?<id>[0-9]+)\/rating$/, lib.loggedin, async (req, res) => {
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

        const isOwner = item[0].username === req.session.user;
        const isAdmin = req.session.admin || req.session.is_moderator;

        if (!isOwner && !isAdmin) {
            return res.json({ success: false, msg: 'Unauthorized' }, 403);
        }

        const nsfl_id = cfg.nsfl_tag_id || 3;
        const existingRating = await db`
            SELECT tag_id FROM tags_assign 
            WHERE item_id = ${itemid} AND tag_id IN (1, 2, ${nsfl_id})
            LIMIT 1
        `;

        const currentRatingId = existingRating.length > 0 ? existingRating[0].tag_id : null;
        let newRatingId;
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

        await db.begin(async sql => {
            // Remove old rating tags
            await sql`DELETE FROM tags_assign WHERE item_id = ${itemid} AND tag_id IN (1, 2, ${nsfl_id})`;
            
            // Insert new rating tag
            await sql`
                INSERT INTO tags_assign (item_id, tag_id, user_id)
                VALUES (${itemid}, ${newRatingId}, ${req.session.id})
            `;

            // Ensure blurred thumbnail exists
            await queue.genBlurredThumbnail(itemid).catch(err => {
                console.error(`[RATING_TOGGLE] Blurred thumbnail generation failed for ${itemid}:`, err);
            });
        });

        const newRating = newRatingId === 1 ? 'sfw' : (newRatingId === 2 ? 'nsfw' : 'nsfl');
        const ratingLabels = { 1: 'sfw', 2: 'nsfw', [nsfl_id]: 'nsfl' };
        const oldRating = currentRatingId ? ratingLabels[currentRatingId] : 'none';
        audit.log(req.session.id, 'update_rating', 'item', itemid, { old: oldRating, new: newRating }).catch(() => {});

        // Notify that tags have changed
        const freshTags = await lib.getTags(itemid);
        db.notify('tags', JSON.stringify({ item_id: itemid, fresh: true, tags: freshTags })).catch(() => {});

        return res.json({
            success: true,
            itemid: itemid,
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
