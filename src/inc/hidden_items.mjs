import db from "./sql.mjs";

/**
 * IDs of items that are not live (pending approval, soft-deleted, purged).
 * The public media routes (/t/, /ca/) consult this so a leftover file on disk can never
 * expose a pending or removed item. Cached briefly because every thumbnail request hits it.
 */

const TTL_MS = 5000;
let cache = new Set();
let loadedAt = 0;
let inflight = null;

const refresh = () => {
  if (!inflight) {
    inflight = db`select id from items where active = false`
      .then(rows => { cache = new Set(rows.map(r => r.id)); loadedAt = Date.now(); })
      .catch(e => { console.warn('[HIDDEN ITEMS] refresh failed:', e.message); })
      .finally(() => { inflight = null; });
  }
  return inflight;
};

export const isHiddenItem = async (id) => {
  if (Date.now() - loadedAt > TTL_MS) await refresh();
  return cache.has(+id);
};

// Call after an item changes state (approve / withdraw) so the next lookup reloads
export const invalidateHiddenItems = () => { loadedAt = 0; };
