
import db from "../src/inc/sql.mjs";

const THRESHOLD = 15;
const REQUIRED_MATCHES = 2;

// Hamming distance helper — operates on a single hex-encoded hash segment
const getHammingDistance = (h1, h2) => {
    if (!h1 || !h2 || h1.length !== h2.length) return 9999;
    let distance = 0;
    for (let i = 0; i < h1.length; i += 2) {
        const v1 = parseInt(h1.substr(i, 2), 16);
        const v2 = parseInt(h2.substr(i, 2), 16);
        let xor = v1 ^ v2;
        while (xor) {
            distance += xor & 1;
            xor >>= 1;
        }
    }
    return distance;
};

async function findDuplicates() {
    console.log("Fetching items...");

    // Fetch all valid phashes
    const items = await db`
        SELECT id, phash 
        FROM items 
        WHERE phash IS NOT NULL 
        AND phash != '' 
        AND phash != 'MISSING' 
        AND phash != 'ERROR'
        AND phash NOT LIKE '00000000%'
        ORDER BY id ASC
    `;

    console.log(`Checking ${items.length} items for duplicates (Threshold: ${THRESHOLD}, Required frame matches: ${REQUIRED_MATCHES})...`);

    const duplicates = new Map(); // Map<OriginalID, List<{id, dist}>>
    const processed = new Set();

    for (let i = 0; i < items.length; i++) {
        const current = items[i];

        if (processed.has(current.id)) continue;

        const matchList = [];

        for (let j = i + 1; j < items.length; j++) {
            const compare = items[j];
            if (processed.has(compare.id)) continue;

            // Split multi-frame hashes properly — do NOT compare the whole string
            const aHashes = current.phash.split('_');
            const bHashes = compare.phash.split('_');
            const framesToCompare = Math.min(aHashes.length, bHashes.length);

            let matchCount = 0;
            for (let f = 0; f < framesToCompare; f++) {
                const dist = getHammingDistance(aHashes[f], bHashes[f]);
                if (dist <= THRESHOLD) matchCount++;
            }

            const isMatch = (framesToCompare >= 3 && matchCount >= REQUIRED_MATCHES)
                || (framesToCompare === 2 && matchCount >= 2)
                || (framesToCompare === 1 && matchCount === 1);

            if (isMatch) {
                const avgDist = Math.round(
                    aHashes.slice(0, framesToCompare)
                        .reduce((sum, h, idx) => sum + getHammingDistance(h, bHashes[idx]), 0)
                    / framesToCompare
                );
                matchList.push({ id: compare.id, dist: avgDist });
                processed.add(compare.id);
            }
        }

        if (matchList.length > 0) {
            duplicates.set(current.id, matchList);
            processed.add(current.id);
        }
    }

    if (duplicates.size === 0) {
        console.log("No duplicates found.");
    } else {
        console.log(`Found ${duplicates.size} duplicate sets:`);
        console.log("---------------------------------------------------");
    }

    for (const [originalId, matchList] of duplicates.entries()) {
        const matchStr = matchList.map(m => `ID:${m.id} (avg-dist:${m.dist})`).join(", ");
        console.log(`Original ID: ${originalId} matches with: ${matchStr}`);
    }

    process.exit(0);
}

findDuplicates().catch(err => {
    console.error(err);
    process.exit(1);
});
