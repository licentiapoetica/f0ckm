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
 */

import db from "../src/inc/sql.mjs";
import queue from "../src/inc/queue.mjs";
import cfg from "../src/inc/config.mjs";
import fs from "fs/promises";
import path from "path";

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log('Usage:');
    console.log('  node regen.mjs <itemid>           - Regenerate a single item');
    console.log('  node regen.mjs <id1> <id2> ...    - Regenerate multiple items');
    console.log('  node regen.mjs --all              - Regenerate ALL items');
    console.log('  node regen.mjs --audio            - Regenerate all audio items');
    console.log('  node regen.mjs --pdf              - Regenerate all PDF items');
    console.log('  node regen.mjs --youtube          - Regenerate all YouTube thumbnails');
    process.exit(0);
}

const regen = async (item) => {
    const { id, dest, mime, src } = item;
    console.log(`[${id}] Regenerating: ${dest} (${mime})`);

    try {
        await queue.genThumbnail(dest, mime, id, src || '', false);

        if (mime.startsWith('audio/') && queue._lastCoverExtracted) {
            await db`UPDATE items SET has_coverart = TRUE WHERE id = ${id}`;
            console.log(`[${id}] ✓ Cover art extracted and saved`);
        } else if (mime.startsWith('audio/')) {
            await db`UPDATE items SET has_coverart = FALSE WHERE id = ${id}`;
            console.log(`[${id}] ✓ No cover art found, placeholder generated`);
        } else {
            console.log(`[${id}] ✓ Thumbnail regenerated`);
        }

        // Regenerate blurred thumbnail if item has NSFW tag
        const nsfw = await db`SELECT 1 FROM tags_assign WHERE item_id = ${id} AND tag_id = 2 LIMIT 1`;
        if (nsfw.length > 0) {
            await queue.genBlurredThumbnail(id, false);
            console.log(`[${id}] ✓ Blurred thumbnail regenerated`);
        }
    } catch (err) {
        console.error(`[${id}] ✗ FAILED:`, err.message || err);
    }
};

try {
    let items;

    if (args.includes('--all')) {
        items = await db`SELECT id, dest, mime, src FROM items WHERE active = true AND is_deleted = false ORDER BY id`;
        console.log(`Regenerating ALL ${items.length} items...\n`);
    } else if (args.includes('--audio')) {
        items = await db`SELECT id, dest, mime, src FROM items WHERE active = true AND is_deleted = false AND mime ILIKE 'audio/%' ORDER BY id`;
        console.log(`Regenerating ${items.length} audio items...\n`);
    } else if (args.includes('--pdf')) {
        items = await db`SELECT id, dest, mime, src FROM items WHERE active = true AND is_deleted = false AND mime = 'application/pdf' ORDER BY id`;
        console.log(`Regenerating ${items.length} PDF items...\n`);
    } else if (args.includes('--youtube')) {
        items = await db`SELECT id, dest, mime, src FROM items WHERE active = true AND is_deleted = false AND mime = 'video/youtube' ORDER BY id`;
        console.log(`Regenerating ${items.length} YouTube items...\n`);
    } else {
        const ids = args.map(Number).filter(n => !isNaN(n) && n > 0);
        if (ids.length === 0) {
            console.error('No valid item IDs provided.');
            process.exit(1);
        }
        items = await db`SELECT id, dest, mime, src FROM items WHERE id IN ${db(ids)} ORDER BY id`;
        const found = items.map(i => i.id);
        const missing = ids.filter(id => !found.includes(id));
        if (missing.length) console.warn(`Items not found: ${missing.join(', ')}\n`);
    }

    for (const item of items) {
        await regen(item);
    }

    console.log(`\nDone. ${items.length} items processed.`);
    process.exit(0);
} catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
}
