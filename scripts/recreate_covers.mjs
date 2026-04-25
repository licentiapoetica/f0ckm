import db from "../src/inc/sql.mjs";
import cfg from "../src/inc/config.mjs";
import queue from "../src/inc/queue.mjs";
import fs from "fs";
import path from "path";

async function run() {
    console.log("[BOOT] Starting coverart recreation script...");
    const audioItems = await db`SELECT id, dest, mime FROM items WHERE mime LIKE 'audio/%' AND is_deleted = false`;
    console.log(`[INFO] Found ${audioItems.length} audio items.`);

    let count = 0;
    for (const item of audioItems) {
        process.stdout.write(`\r[${++count}/${audioItems.length}] Processing ${item.id}...`);
        
        try {
            const caPath = path.join(cfg.paths.ca, `${item.id}.webp`);
            const tPath = path.join(cfg.paths.t, `${item.id}.webp`);
            
            let needsProcessing = !fs.existsSync(caPath);
            if (!needsProcessing) {
                const stats = fs.statSync(caPath);
                if (stats.size < 5000) needsProcessing = true; // Detect old gray placeholder
            }

            if (needsProcessing) {
                try {
                    // Try extraction first
                    await queue.genThumbnail(item.dest, item.mime, item.id, '', false);
                } catch (e) {
                    // If extraction fails, use the music.webp fallback
                    await fs.promises.copyFile('public/s/img/music.webp', caPath);
                }
            }

            if (!fs.existsSync(tPath)) {
                try {
                   await queue.spawn('magick', ['-size', '128x128', 'xc:#1a1a1a', tPath]);
                } catch (err) { }
            }
        } catch (e) {
            console.error(`\n[ERROR] ${item.id} processing failed:`, e.message);
        }
    }

    console.log("\n[FINISH] All audio items processed.");
    process.exit(0);
}

run().catch(err => {
    console.error("[FATAL]", err);
    process.exit(1);
});
