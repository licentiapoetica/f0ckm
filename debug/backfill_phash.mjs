import db from "../src/inc/sql.mjs";
import queue from "../src/inc/queue.mjs";
import fs from "fs";
import path from "path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BATCH_SIZE = 50;

async function backfill() {
    console.log("Starting PHash backfill...");

    try {
        // Count total items needing backfill
        const countResult = await db`SELECT count(*) as count FROM items WHERE (phash IS NULL OR phash = '') AND active = true`;
        const total = countResult[0].count;
        console.log(`Found ${total} items to process.`);

        let processed = 0;
        let errors = 0;

        while (true) {
            const items = await db`
                SELECT id, dest 
                FROM items 
                WHERE (phash IS NULL OR phash = '') 
                AND active = true 
                ORDER BY id DESC 
                LIMIT ${BATCH_SIZE}
            `;

            if (items.length === 0) break;

            for (const item of items) {
                // Correctly resolve path relative to project root
                const filePath = path.join(PROJECT_ROOT, 'public', 'b', item.dest);

                if (!fs.existsSync(filePath)) {
                    console.log(`[SKIP] File not found: ${item.dest} (ID: ${item.id})`);
                    // Mark as MISSING so we don't pick it up again
                    await db`UPDATE items SET phash = 'MISSING' WHERE id = ${item.id}`;
                    processed++;
                    continue;
                }

                try {
                    console.log(`[PROCESSING] ID ${item.id}: ${item.dest}`);
                    const phash = await queue.generatePHash(filePath);

                    if (phash) {
                        await db`UPDATE items SET phash = ${phash} WHERE id = ${item.id}`;
                        console.log(`[SUCCESS] ID ${item.id}: Updated PHash.`);
                    } else {
                        console.log(`[FAILED] ID ${item.id}: Could not generate PHash.`);
                        // Mark as ERROR so we don't pick it up again
                        await db`UPDATE items SET phash = 'ERROR' WHERE id = ${item.id}`;
                        errors++;
                    }
                } catch (err) {
                    console.error(`[ERROR] ID ${item.id}:`, err);
                    await db`UPDATE items SET phash = 'ERROR' WHERE id = ${item.id}`;
                    errors++;
                }
                processed++;
            }
            console.log(`Progress: ${processed} completed (Remaining in batch loop...)`);
        }

        console.log("Backfill complete!");
        process.exit(0);

    } catch (err) {
        console.error("Fatal error:", err);
        process.exit(1);
    }
}

backfill();
