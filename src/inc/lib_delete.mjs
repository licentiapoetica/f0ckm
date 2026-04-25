/**
 * lib_delete.mjs — Safe file deletion helpers for symlink-deduplicated uploads.
 *
 * When bypass_duplicate_check is active, reposts are stored as relative symlinks
 * pointing at the original file. If the original item is deleted, we must not
 * remove the real file from disk as long as at least one other non-deleted item
 * still references it.
 *
 * Strategy for deleteMediaFile(dest):
 *   1. lstat(b/dest) to check if it's a symlink or a real file.
 *   2. If symlink  → safe to just unlink it (other items are unaffected).
 *   3. If real file → query the DB for any other non-deleted item whose dest
 *      resolves to the same real filename (i.e. items that are symlinks HERE
 *      pointing at `dest`).
 *      - If none → the file is exclusively owned; unlink it.
 *      - If found → one of those symlinks must become the new canonical file.
 *        Rename the real file to `survivorDest` and update its symlink to
 *        point at itself (i.e. remove its symlink and leave the real file).
 *        The item being deleted just loses its file entry (it was the real one).
 */

import { promises as fs } from 'fs';
import path from 'path';
import db from './sql.mjs';
import cfg from './config.mjs';

/**
 * Safely remove the media file for a deleted item.
 *
 * @param {string} dest       - The `dest` filename of the item being deleted (e.g. "531f3737.webm")
 * @param {number} deletedId  - The item ID being deleted (used to exclude it from survivor query)
 * @returns {Promise<void>}
 */
export async function safeDeleteMediaFile(dest, deletedId) {
    const filePath = path.join(cfg.paths.b, dest);

    let lstat;
    try {
        lstat = await fs.lstat(filePath);
    } catch (e) {
        // File doesn't exist in public dir — nothing to do
        return;
    }

    if (lstat.isSymbolicLink()) {
        // Just a symlink — safe to remove, real data is unaffected
        await fs.unlink(filePath).catch(() => {});
        console.error(`[DELETE] Unlinked symlink b/${dest}`);
        return;
    }

    // It's a real file. Check if any other active (non-deleted, non-purged) item
    // references this filename via a symlink — i.e. items whose dest, when resolved,
    // matches `dest`.
    const survivors = await db`
        SELECT id, dest FROM items
        WHERE id != ${deletedId}
          AND is_deleted = false
          AND is_purged = false
          AND active = true
          AND dest IS NOT NULL
    `;

    // Find which of those survivors are symlinks pointing at our file
    const symlinkSurvivors = [];
    for (const s of survivors) {
        const sPath = path.join(cfg.paths.b, s.dest);
        try {
            const sLstat = await fs.lstat(sPath);
            if (sLstat.isSymbolicLink()) {
                const target = await fs.readlink(sPath);
                // target is relative (e.g. "531f3737.webm"), resolve relative to b/
                const resolvedTarget = path.resolve(path.dirname(sPath), target);
                if (resolvedTarget === filePath) {
                    symlinkSurvivors.push(s);
                }
            }
        } catch (e) {
            // Skip missing files
        }
    }

    if (symlinkSurvivors.length === 0) {
        // No other item references this real file — safe to unlink
        await fs.unlink(filePath).catch(() => {});
        console.error(`[DELETE] Unlinked real file b/${dest} (no surviving references)`);
        return;
    }

    // At least one surviving item symlinks to this file.
    // Promote the first survivor: rename the real file to its dest name,
    // and remove its old symlink. All other survivors then need to point at
    // the new canonical name.
    const promoted = symlinkSurvivors[0];
    const promotedPath = path.join(cfg.paths.b, promoted.dest);

    try {
        // Remove the promoted item's symlink
        await fs.unlink(promotedPath);
        // Move the real file to the promoted dest name
        await fs.rename(filePath, promotedPath);
        console.error(`[DELETE] Promoted b/${promoted.dest} as new canonical file (was b/${dest})`);

        // Update remaining symlinks to point at the new canonical name
        for (const s of symlinkSurvivors.slice(1)) {
            const sPath = path.join(cfg.paths.b, s.dest);
            try {
                await fs.unlink(sPath);
                await fs.symlink(promoted.dest, sPath);
                console.error(`[DELETE] Re-targeted symlink b/${s.dest} → ${promoted.dest}`);
            } catch (e) {
                console.error(`[DELETE] Failed to re-target b/${s.dest}:`, e.message);
            }
        }
    } catch (e) {
        console.error(`[DELETE] Failed to promote b/${promoted.dest}:`, e.message);
        // Last resort: just unlink original (data may be lost, but avoid leaving dangling state)
        await fs.unlink(filePath).catch(() => {});
    }
}

/**
 * Move a media file from b/ to deleted/b/ safely (for soft-delete / trash flow).
 * If the file is a symlink, we copy the real data to deleted/b/ so it's self-contained,
 * then remove the symlink from b/.
 * If it's the real file and other items reference it, promote a survivor first.
 *
 * @param {string} dest
 * @param {number} deletedId
 */
export async function moveToDeleted(dest, deletedId) {
    const srcPath = path.join(cfg.paths.b, dest);
    const dstPath = path.join(cfg.paths.deleted, 'b', dest);

    let lstat;
    try {
        lstat = await fs.lstat(srcPath);
    } catch (e) {
        return; // Nothing to move
    }

    if (lstat.isSymbolicLink()) {
        // Copy the resolved real data to deleted/ (so the trash viewer works standalone)
        await fs.copyFile(srcPath, dstPath).catch(() => {});
        await fs.unlink(srcPath).catch(() => {});
        console.error(`[DELETE] Moved symlink b/${dest} to deleted/ (copied real data)`);
        return;
    }

    // Real file — check for survivors before removing from b/
    const survivors = await db`
        SELECT id, dest FROM items
        WHERE id != ${deletedId}
          AND is_deleted = false
          AND is_purged = false
          AND active = true
          AND dest IS NOT NULL
    `;

    const symlinkSurvivors = [];
    for (const s of survivors) {
        const sPath = path.join(cfg.paths.b, s.dest);
        try {
            const sLstat = await fs.lstat(sPath);
            if (sLstat.isSymbolicLink()) {
                const target = await fs.readlink(sPath);
                const resolvedTarget = path.resolve(path.dirname(sPath), target);
                if (resolvedTarget === srcPath) {
                    symlinkSurvivors.push(s);
                }
            }
        } catch (e) {}
    }

    // Copy real data to deleted/ regardless
    await fs.copyFile(srcPath, dstPath).catch(() => {});

    if (symlinkSurvivors.length === 0) {
        // No survivors — remove the real file from b/
        await fs.unlink(srcPath).catch(() => {});
        console.error(`[DELETE] Moved real file b/${dest} to deleted/`);
        return;
    }

    // Promote a survivor to hold the real file
    const promoted = symlinkSurvivors[0];
    const promotedPath = path.join(cfg.paths.b, promoted.dest);

    try {
        await fs.unlink(promotedPath);           // remove symlink
        await fs.rename(srcPath, promotedPath);  // real file takes promoted's name
        console.error(`[DELETE] Promoted b/${promoted.dest} as canonical; moved b/${dest} to deleted/`);

        // Re-target remaining survivors to point at the new canonical name
        for (const s of symlinkSurvivors.slice(1)) {
            const sPath = path.join(cfg.paths.b, s.dest);
            try {
                await fs.unlink(sPath);
                await fs.symlink(promoted.dest, sPath);
            } catch (e) {}
        }
    } catch (e) {
        console.error(`[DELETE] Promotion failed for b/${promoted.dest}:`, e.message);
        await fs.unlink(srcPath).catch(() => {});
    }
}
