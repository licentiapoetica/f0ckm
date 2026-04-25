import fs from 'fs';
import crypto from 'crypto';
import db from '../src/inc/sql.mjs';
import path from 'path';

const run = async () => {
    console.log('Starting hash recreation (Production Mode - Streams)...');

    try {
        // Fetch only necessary columns
        const items = await db`SELECT id, dest, checksum, size FROM items ORDER BY id ASC`;
        console.log(`Found ${items.length} items. Processing...`);

        let updated = 0;
        let errors = 0;
        let skipped = 0;

        for (const [index, item] of items.entries()) {
            const filePath = path.join('./public/b', item.dest);

            try {
                if (!fs.existsSync(filePath)) {
                    // Silent error in logs for missing files to avoid spamming "thousands" of lines if many are missing
                    // Use verbose logging if needed, but here we'll just count them.
                    // Actually, precise logs are better for "production" to know what's wrong.
                    console.error(`[MISSING] File not found for item ${item.id}: ${filePath}`);
                    errors++;
                    continue;
                }

                // Get file size without reading content
                const stats = await fs.promises.stat(filePath);
                const size = stats.size;

                // Calculate hash using stream to ensure low memory usage
                const hash = await new Promise((resolve, reject) => {
                    const hashStream = crypto.createHash('sha256');
                    const rs = fs.createReadStream(filePath);

                    rs.on('error', reject);
                    rs.on('data', chunk => hashStream.update(chunk));
                    rs.on('end', () => resolve(hashStream.digest('hex')));
                });

                if (hash !== item.checksum || size !== item.size) {
                    console.log(`[UPDATE] Item ${item.id} (${index + 1}/${items.length})`);
                    if (hash !== item.checksum) console.log(`  - Hash: ${item.checksum} -> ${hash}`);
                    if (size !== item.size) console.log(`  - Size: ${item.size} -> ${size}`);

                    await db`
                UPDATE items
                SET checksum = ${hash}, size = ${size}
                WHERE id = ${item.id}
            `;
                    updated++;
                } else {
                    skipped++;
                }

                // Log progress every 100 items
                if ((index + 1) % 100 === 0) {
                    console.log(`Progress: ${index + 1}/${items.length} (Updated: ${updated}, Errors: ${errors})`);
                }

            } catch (err) {
                console.error(`[ERROR] Processing item ${item.id}:`, err);
                errors++;
            }
        }

        console.log('Done.');
        console.log(`Total: ${items.length}`);
        console.log(`Updated: ${updated}`);
        console.log(`Skipped (No changes): ${skipped}`);
        console.log(`Errors (Missing files): ${errors}`);

    } catch (err) {
        console.error('Fatal error:', err);
    } finally {
        process.exit(0);
    }
};

run();
