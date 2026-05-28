/**
 * Backfill script: populate width/height for existing image and video items.
 *
 * Usage:
 *   node scripts/backfill_dimensions.mjs
 *   node scripts/backfill_dimensions.mjs --dry-run   (print without writing)
 *   node scripts/backfill_dimensions.mjs --limit 500 (process first N items)
 *
 * Skips: audio, flash, PDF, YouTube items (width/height left as NULL).
 * Skips: items where the physical file is missing.
 * Safe to run multiple times — only processes rows where width IS NULL.
 */

import { spawn as _spawn } from 'child_process';
import db from '../src/inc/sql.mjs';
import cfg from '../src/inc/config.mjs';
import path from 'path';
import fs from 'fs/promises';

const isDryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const limit    = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : null;
const BATCH    = 50;

// ---- tiny spawn helper (no shell) ----
const spawn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = _spawn(cmd, args, opts);
    let out = '';
    let err = '';
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { err += d; });
    child.on('close', code => {
      if (code !== 0 && !opts.ignoreExitCode) {
        const e = new Error(`${cmd} exited ${code}`);
        e.stderr = err;
        return reject(e);
      }
      resolve(out);
    });
    child.on('error', reject);
  });

// ---- probe helpers ----
async function getDimsImage(filePath) {
  try {
    // magick identify -format "%wx%h" reports raw pixel dimensions
    const out = await spawn('magick', ['identify', '-format', '%wx%h\n', filePath + '[0]'], { ignoreExitCode: true });
    // Take the first line (multi-frame GIF etc. may have many)
    const line = out.trim().split('\n')[0];
    const match = line.match(/^(\d+)x(\d+)$/);
    if (match) return { w: parseInt(match[1], 10), h: parseInt(match[2], 10) };
  } catch (_) {}
  return null;
}

async function getDimsVideo(filePath) {
  try {
    const out = await spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', filePath
    ], { ignoreExitCode: true });
    const parts = out.trim().split(',');
    if (parts.length < 2) return null;
    const w = parseInt(parts[0], 10);
    const h = parseInt(parts[1], 10);
    if (w > 0 && h > 0) return { w, h };
  } catch (_) {}
  return null;
}

// ---- main ----
async function run() {
  console.log(`[BACKFILL] Starting dimension backfill${isDryRun ? ' (DRY RUN)' : ''}${limit ? ` (limit: ${limit})` : ''}`);

  // Count pending
  const [{ count }] = await db`
    SELECT count(*) FROM items
    WHERE width IS NULL
      AND active = true
      AND (mime LIKE 'image/%' OR (mime LIKE 'video/%' AND mime != 'video/youtube'))
  `;
  const total = parseInt(count, 10);
  const toProcess = limit ? Math.min(total, limit) : total;
  console.log(`[BACKFILL] ${total} items need backfill${limit ? `, processing up to ${toProcess}` : ''}`);

  let offset   = 0;
  let updated  = 0;
  let skipped  = 0;
  let failed   = 0;

  while (offset < toProcess) {
    const rows = await db`
      SELECT id, dest, mime FROM items
      WHERE width IS NULL
        AND active = true
        AND (mime LIKE 'image/%' OR (mime LIKE 'video/%' AND mime != 'video/youtube'))
      ORDER BY id DESC
      LIMIT ${BATCH} OFFSET ${offset}
    `;

    if (rows.length === 0) break;

    for (const row of rows) {
      const filePath = path.join(cfg.paths.b, row.dest);

      // Check file exists (may be deleted/purged)
      try {
        await fs.access(filePath);
      } catch {
        console.log(`[BACKFILL] SKIP #${row.id} — file missing: ${row.dest}`);
        skipped++;
        continue;
      }

      let dims = null;
      try {
        if (row.mime.startsWith('image/')) {
          dims = await getDimsImage(filePath);
        } else if (row.mime.startsWith('video/')) {
          dims = await getDimsVideo(filePath);
        }
      } catch (e) {
        console.warn(`[BACKFILL] PROBE ERROR #${row.id}: ${e.message}`);
        failed++;
        continue;
      }

      if (!dims) {
        console.log(`[BACKFILL] SKIP #${row.id} — no dimensions found (${row.mime})`);
        skipped++;
        continue;
      }

      console.log(`[BACKFILL] ${isDryRun ? '[DRY]' : 'UPDATE'} #${row.id} → ${dims.w}×${dims.h}`);
      if (!isDryRun) {
        await db`UPDATE items SET width = ${dims.w}, height = ${dims.h} WHERE id = ${row.id}`;
      }
      updated++;
    }

    offset += rows.length;
    console.log(`[BACKFILL] Progress: ${Math.min(offset, toProcess)} / ${toProcess} (updated=${updated}, skipped=${skipped}, failed=${failed})`);
  }

  console.log(`[BACKFILL] Done. updated=${updated}, skipped=${skipped}, failed=${failed}`);
  process.exit(0);
}

run().catch(err => {
  console.error('[BACKFILL] Fatal error:', err);
  process.exit(1);
});
