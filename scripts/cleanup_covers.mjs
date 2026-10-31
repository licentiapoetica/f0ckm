import db from "../src/inc/sql.mjs";
import cfg from "../src/inc/config.mjs";
import fs from "fs";
import path from "path";

async function run() {
    console.log("[BOOT] Starting coverart cleanup and migration...");
    
    // 1. Get all audio items
    const audioItems = await db`SELECT id, dest FROM items WHERE mime LIKE 'audio/%' AND is_deleted = false`;
    console.log(`[INFO] Found ${audioItems.length} audio items to evaluate.`);

    const PLACEHOLDER_SIZE = 649524; // Exact size of music.webp
    const OLD_PLACEHOLDER_MAX = 5000; // Max size of old gray placeholder

    let uniqueCount = 0;
    let placeholderCount = 0;
    let missingCount = 0;

    let count = 0;
    for (const item of audioItems) {
        process.stdout.write(`\r[${++count}/${audioItems.length}] Evaluating ${item.id}...`);
        
        const caPath = path.join(cfg.paths.ca, `${item.id}.webp`);
        let hasUniqueArt = false;

        if (fs.existsSync(caPath)) {
            const stats = fs.statSync(caPath);
            if (stats.size === PLACEHOLDER_SIZE || stats.size < OLD_PLACEHOLDER_MAX) {
                // It's a placeholder (new or old)
                // Delete it and set flag to false
                try {
                    fs.unlinkSync(caPath);
                    placeholderCount++;
                } catch (err) {
                    console.error(`\n[ERROR] Failed to delete ${item.id} placeholder:`, err.message);
                }
            } else {
                // It's likely a unique extracted cover
                hasUniqueArt = true;
                uniqueCount++;
            }
        } else {
            missingCount++;
        }

        // Update database
        await db`UPDATE items SET has_coverart = ${hasUniqueArt} WHERE id = ${item.id}`;
    }

    console.log("\n[FINISH] Migration Complete.");
    console.log(`[STATS] Total: ${audioItems.length}`);
    console.log(`[STATS] Unique Covers Kept: ${uniqueCount}`);
    console.log(`[STATS] Placeholders Deleted: ${placeholderCount}`);
    console.log(`[STATS] Missing/Already Clean: ${missingCount}`);
    
    process.exit(0);
}

run().catch(err => {
    console.error("[FATAL]", err);
    process.exit(1);
});
