import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import cfg from "./inc/config.mjs";
import queue from "./inc/queue.mjs";
import path from "path";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";

const sendJson = (res, data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

/**
 * Specialized bypass handler for metadata extraction.
 * Bypasses the main router to ensure raw stream access for multipart data.
 */
export const handleMetaExtract = async (req, res) => {
    // Manual session lookup (bypass middleware pattern)
    if (!req.session && req.cookies?.session) {
        try {
            const user = await db`
                select "user".id, "user".login, "user".user, "user".admin, "user".is_moderator, "user_sessions".id as sess_id, "user_sessions".csrf_token, "user_options".*
                from "user_sessions"
                left join "user" on "user".id = "user_sessions".user_id
                left join "user_options" on "user_options".user_id = "user_sessions".user_id
                where "user_sessions".session = ${lib.sha256(req.cookies.session)}
                limit 1
            `;
            if (user.length > 0) {
                req.session = user[0];
            }
        } catch (err) {}
    }

    if (!req.session) {
        return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
    }

    // CSRF validation
    const csrfToken = req.headers['x-csrf-token'];
    if (!csrfToken || csrfToken !== req.session.csrf_token) {
        console.error(`[META-EXTRACT] CSRF mismatch for ${req.session.user}`);
        return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
    }

    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);

        if (!contentType.includes('multipart/form-data') || !boundaryMatch) {
            return sendJson(res, { success: false, msg: 'Invalid content type' }, 400);
        }

        const boundary = boundaryMatch[1] || boundaryMatch[2];
        
        // Collect tiny chunk (max 5MB)
        const body = await collectBody(req, 5 * 1024 * 1024);
        const parts = parseMultipart(body, boundary);

        const file = parts.file;
        if (!file || !file.data) {
            return sendJson(res, { success: false, msg: 'No file chunk provided' }, 400);
        }

        const tmpPath = path.join(cfg.paths.tmp, `meta_byp_${Math.random().toString(36).substring(7)}`);
        await fs.writeFile(tmpPath, file.data);

        const results = [];
        const seen = new Set();
        const addResult = (val) => {
            if (!val) return;
            const clean = String(val)
                .replace(/<[^>]*>/g, '')
                .replace(/[\x00-\x1F\x7F]/g, '')
                .trim();
            if (clean && clean.length > 1 && clean.length <= 255 && !seen.has(clean.toLowerCase())) {
                seen.add(clean.toLowerCase());
                results.push(clean);
            }
        };

        // Detect image vs video/audio from file chunk magic bytes
        const magic = file.data.slice(0, 12);
        const isJpeg = magic[0] === 0xFF && magic[1] === 0xD8;
        const isPng  = magic[0] === 0x89 && magic[1] === 0x50;
        const isWebp = magic[8] === 0x57 && magic[9] === 0x45 && magic[10] === 0x42 && magic[11] === 0x50;
        const isGif  = magic[0] === 0x47 && magic[1] === 0x49;
        const isTiff = (magic[0] === 0x49 && magic[1] === 0x49) || (magic[0] === 0x4D && magic[1] === 0x4D);
        const isImage = isJpeg || isPng || isWebp || isGif || isTiff;

        if (isImage) {
            // Use exiftool for rich EXIF extraction
            try {
                const { stdout: exifOut } = await queue.spawn('exiftool', ['-json', '-charset', 'utf8', tmpPath], { quiet: true });
                if (exifOut && exifOut.trim()) {
                    const parsed = JSON.parse(exifOut);
                    const tags = parsed[0] || {};

                    // Text fields
                    const textFields = [
                        'Title', 'Description', 'Comment', 'Artist', 'Author',
                        'Creator', 'Copyright', 'CopyrightNotice', 'Rights',
                        'Make', 'Model', 'LensModel', 'Software',
                        'ObjectName', 'Headline', 'Caption', 'CaptionAbstract',
                        'Subject', 'Keywords', 'By-line', 'ByLine', 'Credit', 'Source',
                    ];
                    for (const key of textFields) {
                        const val = tags[key];
                        if (val) {
                            if (Array.isArray(val)) val.forEach(v => addResult(v));
                            else addResult(val);
                        }
                    }

                    // Location text fields
                    const locationFields = [
                        'City', 'Sub-location', 'Province-State', 'Country-PrimaryLocationName',
                        'Country', 'State', 'Location', 'Sublocation', 'CountryCode',
                        'XMP-iptcExt:LocationName', 'XMP-photoshop:City', 'XMP-photoshop:Country',
                    ];
                    let hasTextLocation = false;
                    for (const key of locationFields) {
                        if (tags[key]) { addResult(tags[key]); hasTextLocation = true; }
                    }

                    // GPS: raw coords + reverse geocode
                    let hasGpsData = false;
                    if (tags['GPSLatitude'] != null && tags['GPSLongitude'] != null) {
                        const lat = parseFloat(tags['GPSLatitude']);
                        const lon = parseFloat(tags['GPSLongitude']);
                        if (!isNaN(lat) && !isNaN(lon)) {
                            hasGpsData = true;
                            addResult(`${lat.toFixed(6)},${lon.toFixed(6)}`);
                            if (!hasTextLocation && cfg.main.socks) {
                                try {
                                    const proxyUrl = cfg.main.socks.replace(/^socks5:\/\//i, 'socks5h://');
                                    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
                                    const { stdout: geoOut } = await queue.spawn('curl', [
                                        '--proxy', proxyUrl,
                                        '-s', '--max-time', '10',
                                        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                                        nominatimUrl
                                    ], { quiet: true });
                                    if (geoOut && geoOut.trim()) {
                                        const geo = JSON.parse(geoOut);
                                        const addr = geo.address || {};
                                        const parts = [
                                            addr.city || addr.town || addr.village || addr.hamlet,
                                            addr.state,
                                            addr.country,
                                        ].filter(Boolean);
                                        parts.forEach(p => addResult(p));
                                    }
                                } catch (_) {}
                            }
                        }
                    }
                    if (hasGpsData) tags._hasGpsData = true;
                }
            } catch (exifErr) {
                console.warn('[META-EXTRACT] exiftool failed, skipping EXIF:', exifErr.message);
            }
        } else {
            // Video/audio: use ffprobe metadata
            const metadata = await queue.getVideoMetadata(tmpPath);
            const keysToCheck = [
                'title', 'TITLE', 'comment', 'COMMENT', 'artist', 'ARTIST',
                'album_artist', 'ALBUM_ARTIST', 'author', 'AUTHOR',
                'genre', 'GENRE', 'description', 'DESCRIPTION',
            ];
            keysToCheck.forEach(key => {
                const val = metadata?.[key];
                if (val && typeof val === 'string') addResult(val);
            });
        }

        if (cfg.websrv.debug) {
            console.log(`[META-EXTRACT] Result for ${req.session.user}: ${results.length} unique fields found`);
        }

        await fs.unlink(tmpPath).catch(() => {});

        return sendJson(res, {
            success: true,
            fields: results,
            hasGpsData: isImage && results.some(r => /^-?\d+\.\d+,-?\d+\.\d+$/.test(r))
        });
    } catch (err) {
        console.error('[META-BYPASS-EXTRACT ERROR]', err);
        return sendJson(res, { success: false, msg: 'Error extracting metadata' }, 500);
    }
};
