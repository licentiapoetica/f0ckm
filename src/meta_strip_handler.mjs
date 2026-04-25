import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import cfg from "./inc/config.mjs";
import queue from "./inc/queue.mjs";
import path from "path";
import { parseMultipart, collectBody } from "./inc/multipart.mjs";

/**
 * Strip GPS/location EXIF data from an uploaded image chunk and return the clean bytes.
 * POST /api/v2/meta/strip-gps
 */
export const handleMetaStrip = async (req, res) => {
    // Manual session lookup
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
            if (user.length > 0) req.session = user[0];
        } catch (err) {}
    }

    if (!req.session) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, msg: 'Unauthorized' }));
    }

    const csrfToken = req.headers['x-csrf-token'];
    if (!csrfToken || csrfToken !== req.session.csrf_token) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, msg: 'Invalid CSRF token' }));
    }

    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
        if (!contentType.includes('multipart/form-data') || !boundaryMatch) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, msg: 'Invalid content type' }));
        }

        const boundary = boundaryMatch[1] || boundaryMatch[2];
        const body = await collectBody(req, 20 * 1024 * 1024); // 20MB max for full image
        const parts = parseMultipart(body, boundary);

        const file = parts.file;
        if (!file || !file.data) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, msg: 'No file provided' }));
        }

        const tmpPath = path.join(cfg.paths.tmp, `strip_gps_${Math.random().toString(36).substring(7)}`);
        await fs.writeFile(tmpPath, file.data);

        // Strip all GPS and location EXIF tags in-place
        await queue.spawn('exiftool', [
            '-gps:all=',
            '-xmp:gps:all=',
            '-iptc:city=',
            '-iptc:province-state=',
            '-iptc:country-primary-location-name=',
            '-iptc:sub-location=',
            '-overwrite_original',
            tmpPath,
        ], { quiet: true, ignoreExitCode: true });

        // Read the cleaned file and send it back
        const cleanData = await fs.readFile(tmpPath);
        await fs.unlink(tmpPath).catch(() => {});

        const filename = file.filename || 'image';
        const mime = file.contentType || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': cleanData.length,
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-GPS-Stripped': '1',
        });
        res.end(cleanData);

    } catch (err) {
        console.error('[META-STRIP-GPS ERROR]', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, msg: 'Failed to strip GPS data' }));
    }
};
