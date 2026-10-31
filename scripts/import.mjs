import fs from "fs";
import path from "path";
import db from "../src/inc/sql.mjs";
import lib from "../src/inc/lib.mjs";
import cfg from "../src/inc/config.mjs";
import queue from "../src/inc/queue.mjs";
import f0cklib from "../src/inc/routeinc/f0cklib.mjs";
import { getBypassDuplicateCheck } from "../src/inc/settings.mjs";

// Helper for parsing CLI flags
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        user: null,
        rating: null,
        tags: [],
        dir: cfg.paths.import || path.resolve("f0ckm-data/import"),
        keep: false,
        bypass: null, // null means use config default, true = force bypass, false = force check
        is_oc: false,
        title: null,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--user' || arg === '-u') {
            options.user = args[++i];
        } else if (arg === '--rating' || arg === '-r') {
            options.rating = args[++i]?.toLowerCase();
        } else if (arg === '--tags' || arg === '-t') {
            const rawTags = args[++i];
            if (rawTags) {
                options.tags = rawTags.split(',').map(t => t.trim()).filter(Boolean);
            }
        } else if (arg === '--dir' || arg === '-d') {
            options.dir = path.resolve(args[++i]);
        } else if (arg === '--keep' || arg === '-k') {
            options.keep = true;
        } else if (arg === '--bypass' || arg === '-b') {
            options.bypass = true;
        } else if (arg === '--check') {
            options.bypass = false;
        } else if (arg === '--oc') {
            options.is_oc = true;
        } else if (arg === '--title') {
            options.title = args[++i];
        }
    }

    return options;
}

function showHelp() {
    console.log(`
f0ckm Bulk Import Script
========================
Imports all media files in f0ckm-data/import (or custom directory) into f0ckm.

Usage:
  node scripts/import.mjs [options]

Options:
  --user, -u <username>     User to attribute uploads to (defaults to first admin)
  --rating, -r <sfw|nsfw|nsfl|untagged>  Default rating for imported items
  --tags, -t <tag1,tag2>    Global tags to assign to imported items
  --dir, -d <path>          Directory to scan (default: f0ckm-data/import)
  --keep, -k                Keep source files in import dir after import (default: delete)
  --bypass, -b              Force bypass of duplicate checksum/pHash checks
  --check                   Force duplicate checking even if config enables bypass
  --oc                      Mark all imported files as Original Content (OC)
  --title <title>           Set title for imported files
  --help, -h                Show this help screen

Folder & Sidecar JSON Features:
  - Rating Subfolders: Files in 'import/sfw/', 'import/nsfw/', or 'import/nsfl/' automatically receive that rating.
  - Sidecar Metadata: Place a file.jpg.json or file.json alongside file.jpg to supply metadata:
    { "title": "My Post", "rating": "sfw", "tags": ["funny", "cat"], "comment": "First comment", "is_oc": true }
`);
}

// Derive archive MIME types from cfg.mimes
const ARCHIVE_MIMES = new Set(
    Object.entries(cfg.mimes || {})
        .filter(([mime, ext]) => mime.startsWith('application/') && !['swf', 'pdf'].includes(ext))
        .map(([mime]) => mime)
);
const isArchiveMime = (mime) => ARCHIVE_MIMES.has(mime);

// Recursively collect all target files in directory (follows symlinked dirs and files)
async function collectFiles(dir, visitedDirs = new Set()) {
    const results = [];

    let canonicalDir;
    try {
        canonicalDir = await fs.promises.realpath(dir);
    } catch (_) {
        canonicalDir = dir;
    }

    if (visitedDirs.has(canonicalDir)) {
        return results; // Avoid infinite loops on circular symlink references
    }
    visitedDirs.add(canonicalDir);

    let entries;
    try {
        entries = await fs.promises.readdir(dir);
    } catch (e) {
        console.warn(`[IMPORT] Warning: unable to read directory '${dir}':`, e.message);
        return results;
    }

    for (const name of entries) {
        if (name.startsWith('.')) continue; // skip hidden files & .gitkeep
        const fullPath = path.join(dir, name);

        try {
            // fs.promises.stat follows symlinks to inspect the underlying file/dir
            const st = await fs.promises.stat(fullPath);

            if (st.isDirectory()) {
                const subResults = await collectFiles(fullPath, visitedDirs);
                results.push(...subResults);
            } else if (st.isFile()) {
                if (name.endsWith('.json')) continue; // skip sidecar metadata files
                results.push(fullPath);
            }
        } catch (err) {
            console.warn(`[IMPORT] Warning: unable to stat '${fullPath}' (broken symlink?):`, err.message);
        }
    }
    return results;
}

// Read optional sidecar JSON metadata
async function readSidecarMetadata(filePath) {
    const candidates = [
        `${filePath}.json`,
        path.join(path.dirname(filePath), `${path.parse(filePath).name}.json`)
    ];

    for (const cand of candidates) {
        try {
            if (fs.existsSync(cand)) {
                const raw = await fs.promises.readFile(cand, 'utf-8');
                return { meta: JSON.parse(raw), sidecarPath: cand };
            }
        } catch (e) {
            console.warn(`[IMPORT] Warning: failed to parse sidecar JSON at ${cand}:`, e.message);
        }
    }
    return { meta: {}, sidecarPath: null };
}

async function runImport() {
    const opts = parseArgs();

    if (opts.help) {
        showHelp();
        process.exit(0);
    }

    console.log(`--- f0ckm Bulk Import Starting ---`);
    console.log(`Scan Directory: ${opts.dir}`);

    if (!fs.existsSync(opts.dir)) {
        console.error(`[IMPORT ERROR] Directory does not exist: ${opts.dir}`);
        process.exit(1);
    }

    // 1. Resolve Target User
    let targetUser = null;
    if (opts.user) {
        const userRows = await db`
            SELECT id, "user", login, admin, is_moderator
            FROM "user"
            WHERE LOWER(login) = ${opts.user.toLowerCase()} OR LOWER("user") = ${opts.user.toLowerCase()}
            LIMIT 1
        `;
        if (userRows.length > 0) {
            targetUser = userRows[0];
        } else {
            console.error(`[IMPORT ERROR] Specified user '${opts.user}' not found in database.`);
            process.exit(1);
        }
    } else {
        const adminRows = await db`
            SELECT id, "user", login, admin, is_moderator
            FROM "user"
            WHERE admin = true
            ORDER BY id ASC
            LIMIT 1
        `;
        if (adminRows.length > 0) {
            targetUser = adminRows[0];
        } else {
            const anyUser = await db`SELECT id, "user", login, admin, is_moderator FROM "user" ORDER BY id ASC LIMIT 1`;
            if (anyUser.length > 0) {
                targetUser = anyUser[0];
            } else {
                console.error(`[IMPORT ERROR] No users found in database. Please run npm run create-admin first.`);
                process.exit(1);
            }
        }
    }

    console.log(`Attributing uploads to user: ${targetUser.user} (ID: ${targetUser.id})`);

    // Ensure target directories exist
    await fs.promises.mkdir(cfg.paths.b, { recursive: true });
    await fs.promises.mkdir(cfg.paths.t, { recursive: true });
    await fs.promises.mkdir(cfg.paths.ca, { recursive: true });

    // 2. Discover files
    const fileList = await collectFiles(opts.dir);

    if (fileList.length === 0) {
        console.log(`[IMPORT] No files found in ${opts.dir}. Place files in '${opts.dir}' and re-run.`);
        process.exit(0);
    }

    console.log(`Found ${fileList.length} file(s) to process.\n`);

    const allowedCats = Array.isArray(cfg.allowedMimes) ? cfg.allowedMimes.map(c => c.toLowerCase()) : null;
    const allowedMimes = allowedCats
        ? Object.keys(cfg.mimes).filter(m => allowedCats.some(cat => cat.includes('/') ? m === cat : m.startsWith(`${cat}/`)))
        : Object.keys(cfg.mimes);

    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // 3. Process each file sequentially
    for (let index = 0; index < fileList.length; index++) {
        const filePath = fileList[index];
        const baseName = path.basename(filePath);
        const relPath = path.relative(opts.dir, filePath);
        const prefix = `[${index + 1}/${fileList.length}]`;

        try {
            // Check sidecar JSON metadata
            const { meta: sidecarMeta, sidecarPath } = await readSidecarMetadata(filePath);

            // Determine Rating: Sidecar -> CLI option -> Folder name (import/sfw/ etc.) -> Default
            let effectiveRating = sidecarMeta.rating || opts.rating;
            if (!effectiveRating) {
                const parentDirName = path.basename(path.dirname(filePath)).toLowerCase();
                if (['sfw', 'nsfw', 'nsfl', 'untagged'].includes(parentDirName)) {
                    effectiveRating = parentDirName;
                }
            }
            if (effectiveRating === 'untagged') effectiveRating = null;
            if (!effectiveRating && !cfg.websrv.shitpost_mode) {
                effectiveRating = 'sfw'; // Default fallback if rating required
            }

            // Determine Title & Comments & OC
            const effectiveTitle = sidecarMeta.title || opts.title || null;
            const effectiveComment = sidecarMeta.comment || null;
            const effectiveIsOc = (sidecarMeta.is_oc !== undefined) ? !!sidecarMeta.is_oc : opts.is_oc;
            const effectiveVisibility = (typeof sidecarMeta.visibility === 'number') ? sidecarMeta.visibility : 0;

            // Collect tags
            let mergedTags = [...opts.tags];
            if (Array.isArray(sidecarMeta.tags)) {
                mergedTags.push(...sidecarMeta.tags);
            } else if (typeof sidecarMeta.tags === 'string') {
                mergedTags.push(...sidecarMeta.tags.split(',').map(t => t.trim()));
            }
            mergedTags = mergedTags.filter(t => t && !['sfw', 'nsfw', 'nsfl'].includes(t.toLowerCase()));

            // Verify file stats & MIME
            const stat = await fs.promises.stat(filePath);
            if (stat.size === 0) {
                console.warn(`${prefix} [SKIP] ${relPath} (0 bytes)`);
                skippedCount++;
                continue;
            }

            // Detect actual MIME via file command (with -L to follow symlinks)
            let actualMime = (await queue.spawn('file', ['-L', '--mime-type', '-b', filePath])).stdout.trim();

            if ((actualMime === 'application/octet-stream' || !actualMime) && baseName.toLowerCase().endsWith('.swf')) {
                actualMime = 'application/x-shockwave-flash';
            }

            if (!allowedMimes.includes(actualMime)) {
                console.warn(`${prefix} [SKIP] ${relPath} - Unsupported MIME type: '${actualMime}'`);
                skippedCount++;
                continue;
            }

            // Phase A: SHA-256, PHash, Dimensions, Audio-MP4 probe
            const needsPHash = !isArchiveMime(actualMime);
            const needsDims = !isArchiveMime(actualMime);
            const needsAudioMP4 = (actualMime === 'video/mp4' || actualMime === 'video/quicktime');

            const [checksum, phash, dimResult, audioMp4Result] = await Promise.all([
                queue.spawn('sha256sum', [filePath]).then(r => r.stdout.trim().split(' ')[0]),
                needsPHash ? queue.generatePHash(filePath).catch(e => { console.error(`[IMPORT] PHash error:`, e.message); return null; }) : Promise.resolve(null),
                needsDims ? (async () => {
                    try {
                        if (actualMime.startsWith('image/')) {
                            const { stdout: magickOut } = await queue.spawn('magick', ['identify', '-format', '%wx%h\n', filePath + '[0]'], { quiet: true, ignoreExitCode: true });
                            const match = magickOut.trim().split('\n')[0].match(/^(\d+)x(\d+)$/);
                            if (match) return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
                        } else if (actualMime.startsWith('video/') && actualMime !== 'video/youtube') {
                            const { stdout: probeOut } = await queue.spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath], { quiet: true, ignoreExitCode: true });
                            const dimParts = probeOut.trim().split(',');
                            if (dimParts.length >= 2) {
                                const w = parseInt(dimParts[0], 10);
                                const h = parseInt(dimParts[1], 10);
                                if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) return { width: w, height: h };
                            }
                        }
                    } catch (_) {}
                    return null;
                })() : Promise.resolve(null),
                needsAudioMP4 ? (async () => {
                    const ext = baseName.split('.').pop().toLowerCase();
                    if (['m4a', 'aac'].includes(ext)) return 'audio/mp4';
                    try {
                        const probe = await queue.spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath]);
                        if (!probe.stdout.trim()) return 'audio/mp4';
                    } catch (_) {}
                    return null;
                })() : Promise.resolve(null)
            ]);

            if (audioMp4Result) {
                actualMime = audioMp4Result;
            }

            // Phase B: Duplicate check
            const bypassDupes = (opts.bypass !== null) ? opts.bypass : (getBypassDuplicateCheck() || cfg.websrv.bypass_duplicate_check === true);
            if (!bypassDupes) {
                const [repostBySum, repostByPhash] = await Promise.all([
                    queue.checkrepostsum(checksum),
                    phash ? queue.checkrepostphash(phash) : Promise.resolve(null)
                ]);

                if (repostBySum) {
                    console.warn(`${prefix} [SKIP] ${relPath} - Duplicate file (matches existing Item #${repostBySum})`);
                    skippedCount++;
                    continue;
                }
                if (repostByPhash) {
                    console.warn(`${prefix} [SKIP] ${relPath} - Visual duplicate (matches existing Item #${repostByPhash})`);
                    skippedCount++;
                    continue;
                }
            }

            // Generate target filename & UUID
            const uuid = await queue.genuuid();
            const ext = cfg.mimes[actualMime] || 'bin';
            const filename = `${uuid}.${ext}`;
            const destPath = path.join(cfg.paths.b, filename);
            const nowStamp = ~~(Date.now() / 1000);
            const itemSlug = lib.generateSlug(11);

            // Copy file to public/b
            await fs.promises.copyFile(filePath, destPath);

            const insertChecksum = bypassDupes ? `${checksum}_bypass_${Date.now()}` : checksum;

            // Insert into items table
            await db`
                INSERT INTO items ${db({
                    src: '',
                    dest: filename,
                    mime: actualMime,
                    size: stat.size,
                    checksum: insertChecksum,
                    phash: phash,
                    username: targetUser.user,
                    userchannel: 'import_script',
                    usernetwork: 'local',
                    stamp: nowStamp,
                    active: true,
                    is_oc: effectiveIsOc,
                    original_filename: baseName,
                    title: effectiveTitle,
                    width: dimResult?.width ?? null,
                    height: dimResult?.height ?? null,
                    visibility: effectiveVisibility,
                    slug: itemSlug,
                    expires_at: null
                }, 'src', 'dest', 'mime', 'size', 'checksum', 'phash', 'username', 'userchannel', 'usernetwork', 'stamp', 'active', 'is_oc', 'original_filename', 'title', 'width', 'height', 'visibility', 'slug', 'expires_at')}
            `;

            const itemid = await queue.getItemID(filename);

            // Subscribe uploader to comments
            try {
                await db`
                    INSERT INTO comment_subscriptions (user_id, item_id)
                    VALUES (${targetUser.id}, ${itemid})
                    ON CONFLICT DO NOTHING
                `;
            } catch (_) {}

            // Generate thumbnails
            try {
                await queue.genThumbnail(filename, actualMime, itemid, '', false, 512);
                if (actualMime.startsWith('audio/') && queue._lastCoverExtracted) {
                    await db`UPDATE items SET has_coverart = TRUE WHERE id = ${itemid}`;
                }
            } catch (err) {
                console.warn(`${prefix} [WARN] Thumbnail generation warning for #${itemid}:`, err.message);
            }

            // Blurred thumbnail
            await queue.genBlurredThumbnail(itemid, false);

            // Assign Rating Tag
            if (effectiveRating) {
                const ratingTagId = effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3));
                await db`
                    INSERT INTO tags_assign ${db({ item_id: itemid, tag_id: ratingTagId, user_id: targetUser.id })}
                `;
            }

            // Assign Custom Tags
            for (const tagName of mergedTags) {
                let tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagName}) LIMIT 1`;
                if (tagRow.length === 0) {
                    await db`INSERT INTO tags ${db({ tag: tagName }, 'tag')}`;
                    tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagName}) LIMIT 1`;
                }
                const tagId = tagRow[0].id;
                await db`
                    INSERT INTO tags_assign ${db({ item_id: itemid, tag_id: tagId, user_id: targetUser.id })}
                    ON CONFLICT DO NOTHING
                `;
            }

            // Auto OC tags
            if (effectiveIsOc) {
                for (const tagname of ['oc', 'original content']) {
                    let tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagname}) LIMIT 1`;
                    if (tagRow.length === 0) {
                        await db`INSERT INTO tags ${db({ tag: tagname }, 'tag')}`;
                        tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagname}) LIMIT 1`;
                    }
                    await db`
                        INSERT INTO tags_assign ${db({ item_id: itemid, tag_id: tagRow[0].id, user_id: targetUser.id })}
                        ON CONFLICT DO NOTHING
                    `;
                }
            }

            // Auto Flash tags
            if (actualMime === 'application/x-shockwave-flash' || actualMime === 'application/vnd.adobe.flash.movie') {
                for (const tagname of ['Flash', 'SWF']) {
                    let tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagname}) LIMIT 1`;
                    if (tagRow.length === 0) {
                        await db`INSERT INTO tags ${db({ tag: tagname }, 'tag')}`;
                        tagRow = await db`SELECT id FROM tags WHERE normalized = slugify(${tagname}) LIMIT 1`;
                    }
                    await db`
                        INSERT INTO tags_assign ${db({ item_id: itemid, tag_id: tagRow[0].id, user_id: targetUser.id })}
                        ON CONFLICT DO NOTHING
                    `;
                }
            }

            // Optional first comment
            if (effectiveComment && effectiveComment.trim().length > 0) {
                await db`
                    INSERT INTO comments ${db({
                        item_id: itemid,
                        user_id: targetUser.id,
                        content: effectiveComment.trim()
                    })}
                `;
            }

            // PostgreSQL Live Notification
            try {
                await db`SELECT pg_notify('new_item', ${JSON.stringify({
                    id: itemid,
                    dest: filename,
                    mime: actualMime,
                    username: targetUser.user,
                    display_name: targetUser.display_name || null,
                    tag_id: effectiveRating ? (effectiveRating === 'sfw' ? 1 : (effectiveRating === 'nsfw' ? 2 : (cfg.nsfl_tag_id || 3))) : 0,
                    is_oc: !!effectiveIsOc
                })})`;
            } catch (_) {}

            // Clear cache
            f0cklib.clearCountCache();

            // Cleanup imported source file unless --keep was passed
            if (!opts.keep) {
                await fs.promises.unlink(filePath).catch(() => {});
                if (sidecarPath) {
                    await fs.promises.unlink(sidecarPath).catch(() => {});
                }
            }

            console.log(`${prefix} [SUCCESS] Imported '${relPath}' -> Item #${itemid} (Rating: ${effectiveRating || 'untagged'}, MIME: ${actualMime})`);
            successCount++;

        } catch (err) {
            console.error(`${prefix} [ERROR] Failed to import '${relPath}':`, err.message);
            failedCount++;
        }
    }

    console.log(`\n========================================`);
    console.log(`Import Complete!`);
    console.log(`Total Scanned : ${fileList.length}`);
    console.log(`Successful    : ${successCount}`);
    console.log(`Skipped       : ${skippedCount}`);
    console.log(`Failed        : ${failedCount}`);
    console.log(`========================================`);

    process.exit(0);
}

runImport().catch(err => {
    console.error(`[IMPORT FATAL ERROR]`, err);
    process.exit(1);
});
