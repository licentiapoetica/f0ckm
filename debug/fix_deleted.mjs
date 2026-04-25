
import db from "../src/inc/sql.mjs";
import { promises as fs } from "fs";

(async () => {
    console.log("Starting migration...");

    // 1. Ensure column exists
    try {
        await db`select is_deleted from items limit 1`;
        console.log("Column 'is_deleted' already exists.");
    } catch (err) {
        if (err.message.includes('column "is_deleted" does not exist')) {
            console.log("Column 'is_deleted' missing. Adding it now...");
            await db`ALTER TABLE items ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE`;
            console.log("Column added successfully.");
        } else {
            console.error("Unexpected error checking column:", err);
            process.exit(1);
        }
    }

    const items = await db`select id, dest from items where active = false`;
    console.log(`Found ${items.length} inactive items.`);

    let trashCount = 0;
    let pendingCount = 0;
    let brokenCount = 0;

    for (const item of items) {
        try {
            await fs.access(`./deleted/b/${item.dest}`);
            // File exists in deleted, mark as is_deleted = true
            await db`update items set is_deleted = true where id = ${item.id}`;
            trashCount++;
        } catch {
            // Not in deleted, check public
            try {
                await fs.access(`./public/b/${item.dest}`);
                // In public, is_deleted = false (default)
                pendingCount++;
            } catch {
                // Not in either? Broken.
                console.log(`Item ${item.id} (${item.dest}) missing from both locations. Cleaning up...`);

                // 2. Fix FK constraint: Check if this item is used as an avatar
                try {
                    // Find a safe fallback avatar (active item)
                    const fallback = await db`select id from items where active = true limit 1`;
                    if (fallback.length > 0) {
                        const safeId = fallback[0].id;
                        const users = await db`update "user_options" set avatar = ${safeId} where avatar = ${item.id} returning user_id`;
                        if (users.length > 0) {
                            console.log(`  > Reassigned avatar for ${users.length} users (from ${item.id} to ${safeId})`);
                        }
                    }
                } catch (fkErr) {
                    console.error(`  ! Error fixing avatar FK for ${item.id}:`, fkErr.message);
                }

                await db`delete from items where id = ${item.id}`;
                brokenCount++;
            }
        }
    }

    console.log(`Migration complete.`);
    console.log(`Trash (soft-deleted): ${trashCount}`);
    console.log(`Pending: ${pendingCount}`);
    console.log(`Broken: ${brokenCount}`);
    process.exit(0);
})();
