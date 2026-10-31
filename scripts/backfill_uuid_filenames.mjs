import db from '../src/inc/sql.mjs';
import cfg from '../src/inc/config.mjs';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

const isDryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : null;
const BATCH_SIZE = 1000;

async function run() {
  console.log(`[BACKFILL] Starting long UUID migration & backfill script${isDryRun ? ' (DRY RUN)' : ''}${limit ? ` (Limit: ${limit})` : ''}`);

  if (!isDryRun) {
    console.log('[MIGRATION] Applying database schema migrations...');
    // Drop views first because they depend on columns we want to alter
    await db`DROP VIEW IF EXISTS public.items_sfw CASCADE`;
    await db`DROP VIEW IF EXISTS public.items_li CASCADE`;

    // Alter dest columns in items and comment_files
    await db`ALTER TABLE public.items ALTER COLUMN dest TYPE character varying(255)`;
    await db`ALTER TABLE public.comment_files ALTER COLUMN dest TYPE character varying(255)`;

    // Recreate public.items_li view
    await db`
      CREATE OR REPLACE VIEW public.items_li AS
      SELECT items.id,
         items.src,
         items.dest,
         items.mime,
         items.size,
         items.checksum,
         items.username,
         items.userchannel,
         items.usernetwork,
         items.stamp
        FROM ((public.items
          JOIN public.tags_assign ta1 ON (((ta1.tag_id = 1) AND (ta1.item_id = items.id))))
          JOIN public.tags_assign ta2 ON (((NOT (ta2.tag_id IN ( SELECT tags_nsfp.id
                FROM public.tags_nsfp))) AND (ta2.item_id = items.id))))
       WHERE items.active
       GROUP BY items.id;
    `;

    // Recreate public.items_sfw view
    await db`
      CREATE OR REPLACE VIEW public.items_sfw AS
      SELECT ( SELECT
                    CASE
                        WHEN (tags_assign.tag_id > 0) THEN tags_assign.tag_id
                        ELSE 0
                    END AS "case"
               FROM public.tags_assign
              WHERE ((tags_assign.tag_id = ANY (ARRAY[1, 2])) AND (tags_assign.item_id = items.id))) AS sfw,
        ( SELECT
                    CASE
                        WHEN (tags_assign.tag_id > 0) THEN 1
                        ELSE 0
                    END AS "case"
               FROM public.tags_assign
              WHERE ((tags_assign.tag_id IN ( SELECT tags_nsfp.id
                       FROM public.tags_nsfp)) AND (tags_assign.item_id = items.id))
             LIMIT 1) AS nsfp,
        id,
        src,
        dest,
        mime,
        size,
        checksum,
        username,
        userchannel,
        usernetwork,
        stamp,
        active
       FROM public.items;
    `;
    console.log('[MIGRATION] Schema changes applied and views successfully recreated.');
  }

  // Map to keep track of all renamed files: old_filename -> new_filename
  const renameMap = new Map();

  // 1. Process items
  console.log('[BACKFILL] Fetching items to process...');
  const items = await db`SELECT id, dest, mime FROM items`;
  console.log(`[BACKFILL] Found ${items.length} items in DB.`);

  let itemsProcessed = 0;
  let itemsRenamedCount = 0;

  for (const item of items) {
    if (limit && itemsProcessed >= limit) break;
    itemsProcessed++;

    // YouTube embeds store dest as "yt:VIDEO_ID" — not a real file, skip entirely
    if (item.mime === 'video/youtube') {
      continue;
    }

    const ext = path.extname(item.dest);
    const base = path.basename(item.dest, ext);

    // If name is already 48 characters long, skip
    if (base.length === 48) {
      continue;
    }

    const newUuid = crypto.randomBytes(24).toString('hex');
    const newDest = `${newUuid}${ext}`;
    renameMap.set(item.dest, newDest);

    // Physical files could be in active, pending or deleted folders
    const pathsToCheck = [
      path.join(cfg.paths.b, item.dest),
      path.join(cfg.paths.pending, 'b', item.dest),
      path.join(cfg.paths.deleted, 'b', item.dest)
    ];

    let foundPath = null;
    for (const p of pathsToCheck) {
      try {
        const stat = await fs.lstat(p);
        if (!stat.isSymbolicLink()) {
          foundPath = p;
          break;
        }
      } catch (e) {}
    }

    if (foundPath) {
      const newPath = path.join(path.dirname(foundPath), newDest);
      console.log(`[BACKFILL] Renaming item file: ${foundPath} -> ${newPath}`);
      if (!isDryRun) {
        await fs.rename(foundPath, newPath);
      }
    } else {
      console.log(`[BACKFILL] [WARNING] Item physical file not found/is symlink for: ${item.dest}`);
    }

    if (!isDryRun) {
      await db`UPDATE items SET dest = ${newDest} WHERE id = ${item.id}`;
    }
    itemsRenamedCount++;

    if (itemsRenamedCount % BATCH_SIZE === 0) {
      console.log(`[BACKFILL] Processed ${itemsRenamedCount} item renames...`);
    }
  }

  // 2. Process comment_files
  console.log('[BACKFILL] Fetching comment files to process...');
  const commentFiles = await db`SELECT id, dest FROM comment_files`;
  console.log(`[BACKFILL] Found ${commentFiles.length} comment files in DB.`);

  let commentsProcessed = 0;
  let commentsRenamedCount = 0;

  for (const cf of commentFiles) {
    if (limit && commentsProcessed >= limit) break;
    commentsProcessed++;

    const ext = path.extname(cf.dest);
    const base = path.basename(cf.dest, ext);

    if (base.length === 48) {
      continue;
    }

    const newUuid = crypto.randomBytes(24).toString('hex');
    const newDest = `${newUuid}${ext}`;
    renameMap.set(cf.dest, newDest);

    const oldPath = path.join(cfg.paths.c, cf.dest);
    const newPath = path.join(cfg.paths.c, newDest);

    try {
      const stat = await fs.lstat(oldPath);
      if (!stat.isSymbolicLink()) {
        console.log(`[BACKFILL] Renaming comment file: ${oldPath} -> ${newPath}`);
        if (!isDryRun) {
          await fs.rename(oldPath, newPath);
        }
      }
    } catch (e) {}

    // Rename corresponding thumbnail in t/ (cf_${old_uuid}.webp -> cf_${new_uuid}.webp)
    const oldThumbPath = path.join(cfg.paths.t, `cf_${base}.webp`);
    const newThumbPath = path.join(cfg.paths.t, `cf_${newUuid}.webp`);
    try {
      await fs.access(oldThumbPath);
      console.log(`[BACKFILL] Renaming comment thumbnail: ${oldThumbPath} -> ${newThumbPath}`);
      if (!isDryRun) {
        await fs.rename(oldThumbPath, newThumbPath);
      }
    } catch (e) {}

    if (!isDryRun) {
      await db`UPDATE comment_files SET dest = ${newDest} WHERE id = ${cf.id}`;
    }
    commentsRenamedCount++;

    if (commentsRenamedCount % BATCH_SIZE === 0) {
      console.log(`[BACKFILL] Processed ${commentsRenamedCount} comment file renames...`);
    }
  }

  // 3. Update Symlinks in c/
  console.log('[BACKFILL] Scanning /c/ directory for symlinks to update...');
  try {
    const filesInC = await fs.readdir(cfg.paths.c);
    for (const f of filesInC) {
      const filePath = path.join(cfg.paths.c, f);
      try {
        const stat = await fs.lstat(filePath);
        if (stat.isSymbolicLink()) {
          const target = await fs.readlink(filePath);
          const targetBasename = path.basename(target);
          if (renameMap.has(targetBasename)) {
            const newTargetBasename = renameMap.get(targetBasename);
            // Re-construct the symlink target path, pointing to public/b or public/c
            const resolvedTargetAbs = path.resolve(path.dirname(filePath), target);
            const resolvedTargetNewAbs = path.join(path.dirname(resolvedTargetAbs), newTargetBasename);
            const relativeNewTarget = path.relative(path.dirname(filePath), resolvedTargetNewAbs);

            console.log(`[BACKFILL] Updating symlink: ${filePath} -> ${relativeNewTarget}`);
            if (!isDryRun) {
              await fs.unlink(filePath);
              await fs.symlink(relativeNewTarget, filePath);
            }
          }
        }
      } catch (e) {
        console.error(`[BACKFILL] [ERROR] Failed processing file/symlink ${filePath}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[BACKFILL] Error reading /c/ directory:', e.message);
  }

  console.log(`[BACKFILL] Completed. Items renamed: ${itemsRenamedCount}. Comment files renamed: ${commentsRenamedCount}.`);
  process.exit(0);
}

run().catch(err => {
  console.error('[BACKFILL] Fatal error:', err);
  process.exit(1);
});
