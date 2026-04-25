/**
 * Backfill script to generate blurred thumbnails for existing NSFW items
 * 
 * Run with: node debug/blur_existing_thumbnails.mjs
 */

import { exec as _exec } from "child_process";
import fs from "fs";
import path from "path";
import cfg from "../src/inc/config.mjs";
import sql from "../src/inc/sql.mjs";

const db = sql;

const exec = (cmd) => new Promise((resolve, reject) => {
  _exec(cmd, { maxBuffer: 5e3 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      err.stderr = stderr;
      return reject(err);
    }
    resolve({ stdout });
  });
});

async function main() {
  console.log('[BACKFILL] Starting blurred thumbnail generation for existing NSFW items...');

  // Find all items with NSFW tag (tag_id = 2) that are active
  const nsfwItems = await db`
    SELECT DISTINCT items.id 
    FROM items
    JOIN tags_assign ON tags_assign.item_id = items.id
    WHERE tags_assign.tag_id = 2
    AND items.active = true
  `;

  console.log(`[BACKFILL] Found ${nsfwItems.length} NSFW items`);

  const tDir = cfg.paths.t;
  console.log(`[BACKFILL] Thumbnail directory: ${tDir}`);
  
  // Debug: check if directory exists and list some files
  try {
    const files = await fs.promises.readdir(tDir);
    console.log(`[BACKFILL] Directory exists, contains ${files.length} files`);
    console.log(`[BACKFILL] Sample files: ${files.slice(0, 5).join(', ')}`);
  } catch (e) {
    console.error(`[BACKFILL] ERROR: Cannot access thumbnail directory: ${e.message}`);
    process.exit(1);
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const item of nsfwItems) {
    const src = path.join(tDir, `${item.id}.webp`);
    const dst = path.join(tDir, `${item.id}_blur.webp`);

    // Check if blur already exists
    try {
      await fs.promises.access(dst);
      skipped++;
      continue; // Already exists
    } catch {
      // Doesn't exist, proceed
    }

    // Check if source exists
    try {
      await fs.promises.access(src);
    } catch {
      console.log(`[BACKFILL] Source thumbnail missing for item ${item.id}`);
      errors++;
      continue;
    }

    // Generate blurred thumbnail
    try {
      await exec(`magick "${src}" -blur 0x20 "${dst}"`);
      processed++;
      if (processed % 100 === 0) {
        console.log(`[BACKFILL] Progress: ${processed} processed, ${skipped} skipped, ${errors} errors`);
      }
    } catch (err) {
      console.error(`[BACKFILL] Failed to blur item ${item.id}:`, err.message);
      errors++;
    }
  }

  console.log(`[BACKFILL] Complete!`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Skipped (already exist): ${skipped}`);
  console.log(`  Errors: ${errors}`);

  process.exit(0);
}

main().catch(err => {
  console.error('[BACKFILL] Fatal error:', err);
  process.exit(1);
});
