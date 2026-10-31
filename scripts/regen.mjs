#!/usr/bin/env node
/**
 * Regenerate thumbnails and coverart for specific items.
 * 
 * Usage:
 *   node regen.mjs <itemid>           - Regenerate a single item
 *   node regen.mjs <id1> <id2> ...    - Regenerate multiple items
 *   node regen.mjs --all              - Regenerate ALL items
 *   node regen.mjs --audio            - Regenerate all audio items
 *   node regen.mjs --pdf              - Regenerate all PDF items
 *   node regen.mjs --blur             - Regenerate ONLY the blurred thumbnails for all items
 *
 * Flash (SWF) items are always excluded — their thumbnails are set via the
 * Ruffle snapshot mechanism and must never be touched by this script.
 */

import db from "../src/inc/sql.mjs";
import queue from "../src/inc/queue.mjs";
import cfg from "../src/inc/config.mjs";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '.regen_state.json');

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log('Usage:');
    console.log('  node regen.mjs <itemid>           - Regenerate a single item');
    console.log('  node regen.mjs <id1> <id2> ...    - Regenerate multiple items');
    console.log('  node regen.mjs --all              - Regenerate ALL items');
    console.log('  node regen.mjs --audio            - Regenerate all audio items');
    console.log('  node regen.mjs --pdf              - Regenerate all PDF items');
    console.log('  node regen.mjs --youtube          - Regenerate all YouTube thumbnails');
    console.log('  node regen.mjs --blur             - Regenerate ONLY the blurred thumbnails for all items');
    console.log('  --from <id>                       - Resume/start from a specific item ID (inclusive)');
    console.log('  --resume                          - Resume from last checkpoint saved in .regen_state.json');
    process.exit(0);
}

// Flash mime types — never regenerate these
const FLASH_MIMES = [
    'application/x-shockwave-flash',
    'application/vnd.adobe.flash.movie',
];
const isFlash = (mime) => FLASH_MIMES.includes(mime?.toLowerCase());

const THUMB_SIZE = 512;
const blurOnly = args.includes('--blur');
console.log(`[regen] Thumb size: ${THUMB_SIZE}px\n`);

let fromId = null;
const fromIdx = args.indexOf('--from');
if (fromIdx !== -1 && args[fromIdx + 1]) {
    fromId = parseInt(args[fromIdx + 1], 10);
    if (isNaN(fromId)) {
        console.error('Invalid ID provided for --from');
        process.exit(1);
    }
}

if (!fromId && args.includes('--resume')) {
    try {
        const raw = await fs.readFile(STATE_FILE, 'utf8');
        const state = JSON.parse(raw);
        if (state.lastId) {
            fromId = state.lastId;
            console.log(`[regen] Resuming from checkpoint at item ID: ${fromId}\n`);
        }
    } catch (e) {
        console.warn(`[regen] No previous state checkpoint found to resume from.\n`);
    }
}

if (fromId) {
    console.log(`[regen] Starting from item ID >= ${fromId}\n`);
}

const regen = async (item) => {
    const { id, dest, mime, src } = item;

    if (isFlash(mime)) {
        console.log(`[${id}] Skipped (Flash/SWF — thumbnail managed by Ruffle snapshot)`);
        return;
    }

    if (blurOnly) {
        console.log(`[${id}] Regenerating blurred thumbnail only: ${dest}`);
        try {
            await queue.genBlurredThumbnail(id, false);
            console.log(`[${id}] ✓ Blurred thumbnail regenerated`);
        } catch (err) {
            console.error(`[${id}] ✗ FAILED:`, err.message || err);
        }
        return;
    }

    console.log(`[${id}] Regenerating: ${dest} (${mime})`);

    try {
        await queue.genThumbnail(dest, mime, id, src || '', false, THUMB_SIZE);

        if (mime.startsWith('audio/') && queue._lastCoverExtracted) {
            await db`UPDATE items SET has_coverart = TRUE WHERE id = ${id}`;
            console.log(`[${id}] ✓ Cover art extracted and saved`);
        } else if (mime.startsWith('audio/')) {
            await db`UPDATE items SET has_coverart = FALSE WHERE id = ${id}`;
            console.log(`[${id}] ✓ No cover art found, placeholder generated`);
        } else {
            console.log(`[${id}] ✓ Thumbnail regenerated`);
        }

        // Regenerate blurred thumbnail unconditionally
        await queue.genBlurredThumbnail(id, false);
        console.log(`[${id}] ✓ Blurred thumbnail regenerated`);
    } catch (err) {
        console.error(`[${id}] ✗ FAILED:`, err.message || err);
    }
};

// Shared NOT IN clause for Flash exclusion
const flashExclude = db`mime NOT IN ${db(FLASH_MIMES)}`;
const fromClause = fromId ? db`AND id >= ${fromId}` : db``;

const saveState = async (id) => {
    try {
        await fs.writeFile(STATE_FILE, JSON.stringify({ lastId: id, timestamp: new Date().toISOString() }, null, 2));
    } catch (_) {}
};

let currentItemId = null;
process.on('SIGINT', async () => {
    if (currentItemId) {
        await saveState(currentItemId);
        console.log(`\n[regen] Interrupted! Saved state at item ID ${currentItemId}.`);
        console.log(`[regen] Resume anytime with: node scripts/regen.mjs --resume (or --from ${currentItemId})\n`);
    }
    process.exit(130);
});

try {
    let items;

    if (args.includes('--all')) {
        items = await db`SELECT id, dest, mime, src FROM items WHERE active = true AND is_deleted = false AND ${flashExclude} ${fromClause} ORDER BY id`;
        console.log(`Regenerating ALL ${items.length} non-Flash items...\n`);
    } else if (args.includes('--audio')) {
        items = await db`SELECT id, dest, mime, src FROM items WHERE active = true AND is_deleted = false AND mime ILIKE 'audio/%' ${fromClause} ORDER BY id`;
        console.log(`Regenerating ${items.length} audio items...\n`);
    } else if (args.includes('--pdf')) {
        items = await db`SELECT id, dest, mime, src FROM items WHERE active = true AND is_deleted = false AND mime = 'application/pdf' ${fromClause} ORDER BY id`;
        console.log(`Regenerating ${items.length} PDF items...\n`);
    } else if (args.includes('--youtube')) {
        items = await db`SELECT id, dest, mime, src FROM items WHERE active = true AND is_deleted = false AND mime = 'video/youtube' ${fromClause} ORDER BY id`;
        console.log(`Regenerating ${items.length} YouTube items...\n`);
    } else if (blurOnly) {
        items = await db`
            SELECT id, dest, mime, src 
            FROM items
            WHERE active = true AND is_deleted = false AND ${flashExclude} ${fromClause}
            ORDER BY id
        `;
        console.log(`Regenerating ONLY blurred thumbnails for all ${items.length} non-Flash items...\n`);
    } else {
        const positionalArgs = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--from') {
                i++;
                continue;
            }
            if (args[i].startsWith('--')) continue;
            positionalArgs.push(args[i]);
        }
        const ids = positionalArgs.map(Number).filter(n => !isNaN(n) && n > 0);
        if (ids.length === 0) {
            console.error('No valid item IDs provided.');
            process.exit(1);
        }
        items = await db`SELECT id, dest, mime, src FROM items WHERE id IN ${db(ids)} ${fromClause} ORDER BY id`;
        const found = items.map(i => i.id);
        const missing = ids.filter(id => !found.includes(id));
        if (missing.length) console.warn(`Items not found: ${missing.join(', ')}\n`);
    }

    for (const item of items) {
        currentItemId = item.id;
        await regen(item);
        await saveState(item.id);
    }

    // Clean up state file on normal completion
    await fs.unlink(STATE_FILE).catch(() => {});

    console.log(`\nDone. ${items.length} items processed.`);
    process.exit(0);
} catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
}

