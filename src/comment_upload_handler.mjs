import { promises as fs } from "fs";
import db from "./inc/sql.mjs";
import lib from "./inc/lib.mjs";
import cfg from "./inc/config.mjs";
import queue from "./inc/queue.mjs";
import path from "path";
import { collectBody } from "./inc/multipart.mjs";

// Helper for JSON response
const sendJson = (res, data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

// One-time migration: ensure comment_files table exists
db`CREATE TABLE IF NOT EXISTS public.comment_files (
    id SERIAL PRIMARY KEY,
    comment_id INTEGER REFERENCES public.comments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    dest VARCHAR(40) NOT NULL,
    mime VARCHAR(100) NOT NULL,
    size INTEGER NOT NULL,
    checksum VARCHAR(255) NOT NULL,
    phash TEXT,
    original_filename TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
)`.catch(() => { });
db`CREATE INDEX IF NOT EXISTS idx_comment_files_comment_id ON public.comment_files(comment_id)`.catch(() => { });
db`CREATE INDEX IF NOT EXISTS idx_comment_files_checksum ON public.comment_files(checksum)`.catch(() => { });

/**
 * Parse multipart form data supporting multiple files with the same field name.
 * Returns { files: Array<{filename, contentType, data}>, fields: Object }
 */
const parseMultipartFiles = (buffer, boundary) => {
    const files = [];
    const fields = {};
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const segments = [];

    let start = 0;
    let idx;

    while ((idx = buffer.indexOf(boundaryBuffer, start)) !== -1) {
        if (start !== 0) {
            segments.push(buffer.slice(start, idx - 2));
        }
        start = idx + boundaryBuffer.length + 2;
    }

    for (const segment of segments) {
        const headerEnd = segment.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headers = segment.slice(0, headerEnd).toString();
        const body = segment.slice(headerEnd + 4);

        const nameMatch = headers.match(/name="([^"]+)"/);

        let extractedFilename = null;
        const filenameStarMatch = headers.match(/filename\*\s*=\s*[Uu][Tt][Ff]-8''([^\r\n;]+)/i);
        if (filenameStarMatch) {
            try { extractedFilename = decodeURIComponent(filenameStarMatch[1].trim()); } catch (e) { extractedFilename = filenameStarMatch[1].trim(); }
        } else {
            const filenameQuotedMatch = headers.match(/filename="((?:[^"\\]|\\.)*)"/);
            if (filenameQuotedMatch) {
                extractedFilename = filenameQuotedMatch[1].replace(/\\(.)/g, '$1');
            } else {
                const filenameUnquotedMatch = headers.match(/filename=([^\r\n;]+)/);
                if (filenameUnquotedMatch) extractedFilename = filenameUnquotedMatch[1].trim();
            }
        }

        const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

        if (nameMatch) {
            const name = nameMatch[1];
            if (extractedFilename !== null) {
                files.push({
                    fieldName: name,
                    filename: extractedFilename,
                    contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
                    data: body
                });
            } else {
                fields[name] = body.toString().trim();
            }
        }
    }

    return { files, fields };
};

/**
 * Build the allowed MIME list for comment uploads (image/*, video/*, audio/*).
 * Filters from cfg.mimes, excluding PDF, SWF, etc.
 */
const getAllowedCommentMimes = () => {
    return Object.keys(cfg.mimes).filter(mime =>
        mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')
    );
};

export const handleCommentUpload = async (req, res) => {
    // Manual session lookup (same pattern as upload_handler.mjs)
    if (req.cookies?.session) {
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
        } catch (err) {
            // Session lookup failed
        }
    }

    if (!req.session) {
        return sendJson(res, { success: false, msg: 'Unauthorized' }, 401);
    }

    // CSRF validation
    const csrfToken = req.headers['x-csrf-token'];
    if (!req.session.csrf_token || !csrfToken || csrfToken !== req.session.csrf_token) {
        return sendJson(res, { success: false, msg: 'Invalid CSRF token' }, 403);
    }

    // Check if comment file upload is enabled
    if (!cfg.websrv.allow_fileupload_comments) {
        return sendJson(res, { success: false, msg: 'Comment file uploads are disabled' }, 403);
    }

    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);

        if (!contentType.includes('multipart/form-data') || !boundaryMatch) {
            return sendJson(res, { success: false, msg: 'Invalid content type' }, 400);
        }

        const boundary = boundaryMatch[1] || boundaryMatch[2];

        // Determine max file size
        let maxFileSize = cfg.websrv.fileupload_comments_size || (10 * 1024 * 1024);
        if (req.session.admin) {
            maxFileSize = Math.floor(maxFileSize * (cfg.main.adminmultiplier || 3.5));
        }

        let body;
        try {
            body = await collectBody(req, maxFileSize * 10); // Allow overhead for multipart framing
        } catch (bodyErr) {
            if (bodyErr.code === 'BODY_TOO_LARGE') {
                return sendJson(res, { success: false, msg: 'Request body too large' }, 413);
            }
            throw bodyErr;
        }

        const { files, fields } = parseMultipartFiles(body, boundary);

        if (!files.length) {
            return sendJson(res, { success: false, msg: 'No files provided' }, 400);
        }

        // Multi-file check
        const multiFileAllowed = cfg.websrv.fileupload_comments_multifile;
        if (!multiFileAllowed && files.length > 1) {
            return sendJson(res, { success: false, msg: 'Only one file allowed per comment' }, 400);
        }

        const allowedMimes = getAllowedCommentMimes();
        const results = [];

        // Ensure directories exist
        await fs.mkdir(cfg.paths.c, { recursive: true });
        await fs.mkdir(cfg.paths.tmp, { recursive: true });
        await fs.mkdir(cfg.paths.t, { recursive: true });

        for (const file of files) {
            // Size check per file
            if (file.data.length > maxFileSize) {
                return sendJson(res, {
                    success: false,
                    msg: `File "${file.filename}" exceeds the maximum size limit`
                }, 413);
            }

            // MIME check (browser-reported)
            if (!allowedMimes.includes(file.contentType)) {
                return sendJson(res, {
                    success: false,
                    msg: `Invalid file type: ${file.contentType}`
                }, 400);
            }

            // Generate UUID and save temp
            const uuid = await queue.genuuid();
            const tmpPath = path.join(cfg.paths.tmp, `${uuid}.tmp`);
            await fs.writeFile(tmpPath, file.data);

            // Verify actual MIME with `file` command
            let actualMime = (await queue.spawn('file', ['--mime-type', '-b', tmpPath])).stdout.trim();
            if (!allowedMimes.includes(actualMime)) {
                await fs.unlink(tmpPath).catch(() => { });
                return sendJson(res, {
                    success: false,
                    msg: `Invalid file type detected: ${actualMime}`
                }, 400);
            }

            // Reclassify audio-only MP4 containers (same as upload_handler)
            if (actualMime === 'video/mp4' || actualMime === 'video/quicktime') {
                const origExt = file.filename.split('.').pop().toLowerCase();
                if (['m4a', 'aac'].includes(origExt)) {
                    actualMime = 'audio/mp4';
                } else {
                    try {
                        const probeResult = await queue.spawn('ffprobe', [
                            '-v', 'error', '-select_streams', 'v:0',
                            '-show_entries', 'stream=codec_type',
                            '-of', 'csv=p=0', tmpPath
                        ]);
                        if (!probeResult.stdout.trim()) {
                            actualMime = 'audio/mp4';
                        }
                    } catch (err) {
                        // ffprobe not available or failed, keep original MIME
                    }
                }
            }

            let ext = cfg.mimes[actualMime] || 'bin';
            // Max dimension for comment images (scale down if larger)
            const COMMENT_IMG_MAX_DIM = 1280;

            // Convert GIF → WebP (small) or WebM (large) to save disk space
            let convertedFromGif = false;
            if (actualMime === 'image/gif') {
                const gifSize = file.data.length;
                const GIF_WEBM_THRESHOLD = 5 * 1024 * 1024; // 8MB
                let converted = false;

                if (gifSize <= GIF_WEBM_THRESHOLD) {
                    // Small GIF → try WebP (with resize)
                    const webpTmpPath = tmpPath.replace(/\.tmp$/, '.webp');
                    try {
                        await queue.spawn('magick', [tmpPath, '-coalesce',
                            '-resize', `${COMMENT_IMG_MAX_DIM}x${COMMENT_IMG_MAX_DIM}>`,
                            '-quality', '80', webpTmpPath]);
                        const webpStat = await fs.stat(webpTmpPath);
                        if (webpStat.size < gifSize) {
                            await fs.unlink(tmpPath).catch(() => { });
                            await fs.rename(webpTmpPath, tmpPath);
                            actualMime = 'image/webp';
                            ext = 'webp';
                            converted = true;
                            console.log(`[COMMENT_UPLOAD] GIF → WebP (${(gifSize / 1024 / 1024).toFixed(1)}MB → ${(webpStat.size / 1024 / 1024).toFixed(1)}MB): ${file.filename}`);
                        } else {
                            console.log(`[COMMENT_UPLOAD] WebP larger than GIF, keeping original: ${file.filename}`);
                            await fs.unlink(webpTmpPath).catch(() => { });
                        }
                    } catch (e) {
                        console.warn(`[COMMENT_UPLOAD] GIF→WebP failed, keeping original:`, e.message);
                        await fs.unlink(webpTmpPath).catch(() => { });
                    }
                } else {
                    // Large GIF → go straight to WebM (VP9 with alpha + resize)
                    const webmTmpPath = tmpPath.replace(/\.tmp$/, '.webm');
                    try {
                        await queue.spawn('ffmpeg', [
                            '-y', '-i', tmpPath,
                            '-an',
                            '-vf', `scale='min(${COMMENT_IMG_MAX_DIM},iw)':min'(${COMMENT_IMG_MAX_DIM},ih)':force_original_aspect_ratio=decrease`,
                            '-c:v', 'libvpx-vp9',
                            '-pix_fmt', 'yuva420p',
                            '-auto-alt-ref', '0',
                            '-crf', '30', '-b:v', '0',
                            webmTmpPath
                        ]);
                        const webmStat = await fs.stat(webmTmpPath);
                        if (webmStat.size < gifSize) {
                            await fs.unlink(tmpPath).catch(() => { });
                            await fs.rename(webmTmpPath, tmpPath);
                            actualMime = 'video/webm';
                            ext = 'webm';
                            converted = true;
                            convertedFromGif = true;
                            console.log(`[COMMENT_UPLOAD] GIF → WebM (${(gifSize / 1024 / 1024).toFixed(1)}MB → ${(webmStat.size / 1024 / 1024).toFixed(1)}MB): ${file.filename}`);
                        } else {
                            console.log(`[COMMENT_UPLOAD] WebM also larger, keeping original GIF: ${file.filename}`);
                            await fs.unlink(webmTmpPath).catch(() => { });
                        }
                    } catch (e) {
                        console.warn(`[COMMENT_UPLOAD] GIF→WebM failed, keeping original:`, e.message);
                        await fs.unlink(webmTmpPath).catch(() => { });
                    }
                }
            }

            // Downscale regular images (JPEG, PNG, WebP) if too large
            if (actualMime.startsWith('image/') && actualMime !== 'image/gif') {
                try {
                    const { stdout: dims } = await queue.spawn('magick', [tmpPath, '-format', '%wx%h', 'info:']);
                    const [w, h] = dims.trim().split('x').map(Number);
                    if (w > COMMENT_IMG_MAX_DIM || h > COMMENT_IMG_MAX_DIM) {
                        await queue.spawn('magick', [tmpPath, '-resize', `${COMMENT_IMG_MAX_DIM}x${COMMENT_IMG_MAX_DIM}>`, '-quality', '85', tmpPath]);
                        console.log(`[COMMENT_UPLOAD] Resized ${w}x${h} → max ${COMMENT_IMG_MAX_DIM}px: ${file.filename}`);
                    }
                } catch (e) {
                    console.warn(`[COMMENT_UPLOAD] Resize check failed:`, e.message);
                }
            }

            const filename = `${uuid}.${ext}`;

            // SHA-256 checksum
            const checksum = (await queue.spawn('sha256sum', [tmpPath])).stdout.trim().split(" ")[0];

            // Repost detection: check both comment_files AND items tables
            let linkedToExisting = false;

            // Check comment_files first
            const commentRepost = await db`
                SELECT id, dest FROM comment_files WHERE checksum = ${checksum} LIMIT 1
            `;
            if (commentRepost.length > 0) {
                // Symlink to existing comment file
                const existingDest = commentRepost[0].dest;
                const existingAbsPath = path.join(cfg.paths.c, existingDest);
                try {
                    const realTarget = await fs.realpath(existingAbsPath);
                    const destPath = path.join(cfg.paths.c, filename);
                    const relTarget = path.relative(path.dirname(destPath), realTarget);
                    await fs.symlink(relTarget, destPath);
                    linkedToExisting = true;
                    console.log(`[COMMENT_UPLOAD] Symlinked to existing comment file: ${filename} → ${relTarget}`);
                } catch (e) {
                    console.error(`[COMMENT_UPLOAD] Symlink failed:`, e.message);
                }
            }

            if (!linkedToExisting) {
                // Check items table
                const itemRepost = await db`
                    SELECT id, dest FROM items WHERE checksum = ${checksum} LIMIT 1
                `;
                if (itemRepost.length > 0) {
                    const existingDest = itemRepost[0].dest;
                    const existingAbsPath = path.join(cfg.paths.b, existingDest);
                    try {
                        const realTarget = await fs.realpath(existingAbsPath);
                        const destPath = path.join(cfg.paths.c, filename);
                        const relTarget = path.relative(path.dirname(destPath), realTarget);
                        await fs.symlink(relTarget, destPath);
                        linkedToExisting = true;
                        console.log(`[COMMENT_UPLOAD] Symlinked to existing item: ${filename} → ${relTarget}`);
                    } catch (e) {
                        console.error(`[COMMENT_UPLOAD] Item symlink failed:`, e.message);
                    }
                }
            }

            // PHash check (only for image/video)
            let phash = null;
            if (actualMime.startsWith('image/') || actualMime.startsWith('video/')) {
                try {
                    phash = await queue.generatePHash(tmpPath);
                    if (phash && !linkedToExisting) {
                        // Check comment_files for visual duplicate
                        const cfItems = await db`
                            SELECT id, phash, dest FROM comment_files
                            WHERE phash IS NOT NULL AND phash != '' AND phash NOT LIKE '00000000%'
                        `;
                        for (const cf of cfItems) {
                            if (isPhashMatch(phash, cf.phash)) {
                                const existingAbsPath = path.join(cfg.paths.c, cf.dest);
                                try {
                                    const realTarget = await fs.realpath(existingAbsPath);
                                    const destPath = path.join(cfg.paths.c, filename);
                                    const relTarget = path.relative(path.dirname(destPath), realTarget);
                                    await fs.symlink(relTarget, destPath);
                                    linkedToExisting = true;
                                    console.log(`[COMMENT_UPLOAD] PHash match in comment_files: ${filename} → ${relTarget}`);
                                } catch (e) {
                                    console.error(`[COMMENT_UPLOAD] PHash symlink failed:`, e.message);
                                }
                                break;
                            }
                        }

                        // Also check items table for visual duplicate
                        if (!linkedToExisting) {
                            const phashMatch = await queue.checkrepostphash(phash);
                            if (phashMatch) {
                                const itemRow = await db`SELECT dest FROM items WHERE id = ${phashMatch} LIMIT 1`;
                                if (itemRow.length > 0) {
                                    const existingAbsPath = path.join(cfg.paths.b, itemRow[0].dest);
                                    try {
                                        const realTarget = await fs.realpath(existingAbsPath);
                                        const destPath = path.join(cfg.paths.c, filename);
                                        const relTarget = path.relative(path.dirname(destPath), realTarget);
                                        await fs.symlink(relTarget, destPath);
                                        linkedToExisting = true;
                                        console.log(`[COMMENT_UPLOAD] PHash match in items: ${filename} → ${relTarget}`);
                                    } catch (e) {
                                        console.error(`[COMMENT_UPLOAD] PHash item symlink failed:`, e.message);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('[COMMENT_UPLOAD] PHash error:', e);
                }
            }

            // If no duplicate found, copy file to /c/
            if (!linkedToExisting) {
                const destPath = path.join(cfg.paths.c, filename);
                await fs.copyFile(tmpPath, destPath);
            }

            // Clean up tmp
            await fs.unlink(tmpPath).catch(() => { });

            // Generate thumbnail (same size as regular uploads = 512px)
            const dynThumbSize = 512;
            try {
                // genThumbnail expects the file in bDir (pending/b or b).
                // For comment files we store in /c/, so we call thumbnail generation manually.
                await generateCommentThumbnail(filename, actualMime, uuid, dynThumbSize);
            } catch (err) {
                console.warn(`[COMMENT_UPLOAD] Thumbnail generation failed for ${filename}:`, err.message);
                // Fallback to placeholder
                const tPath = path.join(cfg.paths.t, `cf_${uuid}.webp`);
                await queue.spawn('magick', ['-size', `${dynThumbSize}x${dynThumbSize}`, 'xc:#1a1a1a', tPath]).catch(() => { });
            }

            // Insert into comment_files (comment_id is null; will be linked when comment is posted)
            const inserted = await db`
                INSERT INTO comment_files ${db({
                user_id: req.session.id,
                dest: filename,
                mime: actualMime,
                size: file.data.length,
                checksum: checksum,
                phash: phash,
                original_filename: file.filename || null
            }, 'user_id', 'dest', 'mime', 'size', 'checksum', 'phash', 'original_filename')}
                RETURNING id, dest, mime
            `;

            results.push({
                id: inserted[0].id,
                dest: inserted[0].dest,
                mime: inserted[0].mime,
                thumbnail: `/t/cf_${uuid}.webp`,
                converted_gif: convertedFromGif
            });
        }

        return sendJson(res, { success: true, files: results });

    } catch (err) {
        console.error('[COMMENT_UPLOAD] Error:', err);
        if (err.code === 'BODY_TOO_LARGE') {
            return sendJson(res, { success: false, msg: 'File too large' }, 413);
        }
        return sendJson(res, { success: false, msg: 'Upload failed' }, 500);
    }
};

/**
 * Generate thumbnail for a comment file.
 * Outputs to /t/cf_<uuid>.webp
 */
async function generateCommentThumbnail(filename, mime, uuid, size = 512) {
    const sourcePath = path.join(cfg.paths.c, filename);
    const thumbDest = path.join(cfg.paths.t, `cf_${uuid}.webp`);
    const tmpFile = path.join(cfg.paths.tmp, `cf_${uuid}_thumb.png`);
    const thumbSpec = `${size}x${size}`;

    // Resolve real path if symlink
    let realSource = sourcePath;
    try {
        const lstat = await fs.lstat(sourcePath);
        if (lstat.isSymbolicLink()) {
            realSource = await fs.realpath(sourcePath);
        }
    } catch (e) { }

    if (mime.startsWith('video/') || mime === 'image/gif') {
        const ffThumbSize = Math.max(size, 512);
        const seeks = ['20%', '40%', '60%', '80%'];
        for (const seek of seeks) {
            await queue.spawn('ffmpegthumbnailer', ['-i', realSource, '-s', String(ffThumbSize), '-t', seek, '-o', tmpFile]);
            try {
                const { stdout } = await queue.spawn('magick', [tmpFile, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']);
                if (parseFloat(stdout.trim()) > 0.05) break;
            } catch (e) { break; }
        }
    } else if (mime.startsWith('image/') && mime !== 'image/gif') {
        await queue.spawn('magick', [realSource + '[0]', tmpFile]);
    } else if (mime.startsWith('audio/')) {
        // Try extracting cover art
        let coverExtracted = false;
        try {
            await queue.spawn('ffmpeg', ['-i', realSource, '-an', '-vcodec', 'copy', '-frames:v', '1', '-update', '1', tmpFile]);
            const stat = await fs.stat(tmpFile).catch(() => null);
            if (stat && stat.size > 0) {
                coverExtracted = true;
            }
        } catch (err) { }

        if (!coverExtracted) {
            // Generate a placeholder for audio
            await queue.spawn('magick', ['-size', thumbSpec, 'xc:#1a1a1a', '-gravity', 'center',
                '-fill', '#ffffff', '-pointsize', '48', '-annotate', '0', '♪',
                tmpFile]);
        }
    }

    // Convert to webp thumbnail
    try {
        await queue.spawn('magick', [tmpFile, '-resize', `${thumbSpec}^`, '-gravity', 'center',
            '-crop', `${thumbSpec}+0+0`, '+repage', '-quality', '85', thumbDest]);
    } catch (e) {
        // If conversion fails, create placeholder
        await queue.spawn('magick', ['-size', thumbSpec, 'xc:#1a1a1a', thumbDest]);
    }

    // Cleanup tmp
    await fs.unlink(tmpFile).catch(() => { });
}

/**
 * PHash matching helper (same logic as queue.checkrepostphash)
 */
function isPhashMatch(newHash, dbHash) {
    if (!newHash || !dbHash) return false;
    const newHashes = newHash.split('_');
    const dbHashes = dbHash.split('_');
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

    const framesToCompare = Math.min(newHashes.length, dbHashes.length);
    let matches = 0;

    for (let i = 0; i < framesToCompare; i++) {
        const dist = getHammingDistance(newHashes[i], dbHashes[i]);
        if (dist <= THRESHOLD) matches++;
    }

    if (framesToCompare >= 3 && matches >= 2) return true;
    if (framesToCompare === 1 && matches === 1) return true;
    if (framesToCompare === 2 && matches >= 2) return true;

    return false;
}
