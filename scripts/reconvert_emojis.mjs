#!/usr/bin/env node
/**
 * Reconvert all existing emoji images to WebP.
 * - Converts non-WebP files (PNG, GIF, JPG, etc.) to lossless WebP via ImageMagick.
 * - Keeps transparency. Handles animated GIFs via -coalesce.
 * - Updates the `url` column in `custom_emojis` to the new .webp path.
 * - Deletes the original file after successful conversion.
 *
 * Usage:
 *   STORAGE_DIR=f0ckm-data DB_HOST=localhost DB_PORT=5454 node scripts/reconvert_emojis.mjs
 */

import db from "../src/inc/sql.mjs";
import cfg from "../src/inc/config.mjs";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

// Custom IM policy that raises list-length from 128 → 65536 to handle large animated GIFs.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGICK_POLICY_PATH = path.resolve(__dirname, '../config/magick-policy');
const magickEnv = { ...process.env, MAGICK_CONFIGURE_PATH: MAGICK_POLICY_PATH };

const emojisDir = cfg.paths.emojis;
console.log(`[reconvert_emojis] Emoji directory: ${emojisDir}`);

let converted = 0;
let skipped = 0;
let errors = 0;

try {
    const emojis = await db`SELECT id, name, url FROM custom_emojis ORDER BY id`;
    console.log(`[reconvert_emojis] Found ${emojis.length} emojis in DB.\n`);

    for (const emoji of emojis) {
        const { id, name, url } = emoji;

        // Only handle locally hosted emojis (not external URLs)
        if (!url || !url.startsWith('/s/emojis/')) {
            console.log(`[${id}] "${name}" — skipping (external URL: ${url})`);
            skipped++;
            continue;
        }

        const filename = path.basename(url);
        const ext = path.extname(filename).toLowerCase().replace('.', '');

        if (ext === 'webp') {
            // Verify the file actually exists, then skip
            const fullPath = path.join(emojisDir, filename);
            try {
                await fs.access(fullPath);
                console.log(`[${id}] "${name}" — already WebP, skipping.`);
            } catch {
                console.warn(`[${id}] "${name}" — already WebP in DB but file missing: ${fullPath}`);
            }
            skipped++;
            continue;
        }

        const originalPath = path.join(emojisDir, filename);
        const webpFilename = filename.replace(/\.[^.]+$/, '.webp');
        const webpPath = path.join(emojisDir, webpFilename);
        const newUrl = `/s/emojis/${webpFilename}`;

        try {
            await fs.access(originalPath);
        } catch {
            console.warn(`[${id}] "${name}" — original file missing: ${originalPath}, skipping.`);
            skipped++;
            continue;
        }

        try {
            console.log(`[${id}] "${name}" — converting ${ext.toUpperCase()} → WebP …`);
            // -coalesce: handles animated GIFs properly
            // -quality 80: lossy WebP — ~50-70% smaller than GIF, transparency preserved
            await execFile('magick', [originalPath, '-coalesce', '-quality', '80', webpPath], { env: magickEnv });

            // Verify output exists and is non-empty
            const stat = await fs.stat(webpPath);
            if (!stat || stat.size === 0) throw new Error('Output file is empty');

            // Update DB
            await db`UPDATE custom_emojis SET url = ${newUrl} WHERE id = ${id}`;

            // Remove original
            await fs.unlink(originalPath);

            console.log(`[${id}] "${name}" — ✓ converted (${(stat.size / 1024).toFixed(1)} KB) → ${newUrl}`);
            converted++;
        } catch (err) {
            console.error(`[${id}] "${name}" — ✗ FAILED: ${err.message}`);
            // Clean up partial output if it exists
            await fs.unlink(webpPath).catch(() => {});
            errors++;
        }
    }

    // Notify connected clients of updated emoji list
    if (converted > 0) {
        await db`NOTIFY emojis_updated, '{}'`;
        console.log(`\n[reconvert_emojis] Notified clients of emoji update.`);
    }

    console.log(`\n[reconvert_emojis] Done.`);
    console.log(`  Converted : ${converted}`);
    console.log(`  Skipped   : ${skipped}`);
    console.log(`  Errors    : ${errors}`);

    process.exit(errors > 0 ? 1 : 0);
} catch (err) {
    console.error('[reconvert_emojis] Fatal error:', err);
    process.exit(1);
}
