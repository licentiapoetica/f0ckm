/**
 * fix_youtube_dest.mjs
 *
 * One-time fix: the backfill_uuid_filenames.mjs script failed to exclude
 * YouTube items, which store dest as "yt:VIDEO_ID" rather than a real file.
 * As a result, those dest values were replaced with random UUIDs, breaking
 * embed URLs like youtube.com/embed/<uuid>.
 *
 * This script:
 *   1. Finds all items with mime = 'video/youtube'
 *   2. For each, re-extracts the video ID from the src column
 *      (src holds the original YouTube watch URL: https://www.youtube.com/watch?v=VIDEO_ID)
 *   3. Restores dest to "yt:VIDEO_ID"
 *
 * Usage:
 *   node scripts/fix_youtube_dest.mjs           # live run
 *   node scripts/fix_youtube_dest.mjs --dry-run  # preview only, no DB changes
 */

import db from '../src/inc/sql.mjs';

const isDryRun = process.argv.includes('--dry-run');

const ytRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\/?\?(?:\S*?&?v=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;

async function run() {
  console.log(`[FIX-YT-DEST] Starting${isDryRun ? ' (DRY RUN)' : ''}...`);

  const rows = await db`
    SELECT id, dest, src
    FROM items
    WHERE mime = 'video/youtube'
    ORDER BY id
  `;

  console.log(`[FIX-YT-DEST] Found ${rows.length} YouTube item(s) to check.`);

  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    // Already correct format
    if (row.dest && row.dest.startsWith('yt:')) {
      skipped++;
      continue;
    }

    // Try to extract video ID from src URL
    const match = row.src && row.src.match(ytRegex);
    if (!match) {
      console.warn(`[FIX-YT-DEST] [WARN] Item ${row.id}: cannot extract video ID from src="${row.src}", dest="${row.dest}" — skipping`);
      failed++;
      continue;
    }

    const videoId = match[1];
    const newDest = `yt:${videoId}`;

    console.log(`[FIX-YT-DEST] Item ${row.id}: "${row.dest}" → "${newDest}" (src: ${row.src})`);

    if (!isDryRun) {
      await db`UPDATE items SET dest = ${newDest} WHERE id = ${row.id}`;
    }
    fixed++;
  }

  console.log(`\n[FIX-YT-DEST] Done.`);
  console.log(`  Fixed:   ${fixed}`);
  console.log(`  Skipped: ${skipped} (already correct)`);
  console.log(`  Failed:  ${failed} (no video ID recoverable from src)`);

  if (isDryRun) {
    console.log('\n[FIX-YT-DEST] DRY RUN — no changes were written to the database.');
  }

  process.exit(0);
}

run().catch(err => {
  console.error('[FIX-YT-DEST] Fatal error:', err);
  process.exit(1);
});
