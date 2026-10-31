import cfg from './config.mjs';
import db from './sql.mjs';

// Square Clicker: audio / video items become playable rhythm-game maps. For everyone, on unless
// websrv.square_clicker_enabled is false. Callers may pass (date, session); both are ignored.
export const isSquareClickerActive = () => cfg.websrv?.square_clicker_enabled !== false;

export const MAX_NOTES = 3000;
export const MAX_HOLD_MS = 60000;
const MAX_TITLE = 80;
const MAX_PATH_POINTS = 1000;      // per slider
const MAX_MAP_PATH_POINTS = 50000; // per map

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
export const cleanTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || 'Untitled';

// Validate + normalise a notes array (used by create, edit and imports). -> { notes } or { error }
// Slider path: [[dt, x, y], ...] inside the hold (0..d), sorted by time; dropped if under 2 points
export const cleanNotes = (raw, duration) => {
  if (!Array.isArray(raw) || raw.length < 1) return { error: 'A map needs at least one note' };
  if (raw.length > MAX_NOTES) return { error: 'Too many notes (max ' + MAX_NOTES + ')' };
  const cleanPath = (p, d) => {
    if (!Array.isArray(p) || !d) return null;
    const pts = p.slice(0, MAX_PATH_POINTS)
      .filter(q => Array.isArray(q) && q.length >= 3)
      .map(q => [Math.max(0, Math.min(d, Math.round(Number(q[0]) || 0))), +clamp01(q[1]).toFixed(4), +clamp01(q[2]).toFixed(4)])
      .sort((a, z) => a[0] - z[0]);
    return pts.length >= 2 ? pts : null;
  };
  const notes = raw
    .map(n => {
      const d = Math.max(0, Math.min(MAX_HOLD_MS, Math.round(Number(n && n.d) || 0)));
      const note = { t: Math.max(0, Math.round(Number(n && n.t) || 0)), x: +clamp01(n && n.x).toFixed(4), y: +clamp01(n && n.y).toFixed(4), d };
      const path = cleanPath(n && n.p, d);
      if (path) note.p = path;
      return note;
    })
    .filter(n => !duration || n.t <= duration + 1000)
    .sort((a, z) => a.t - z.t);
  if (!notes.length) return { error: 'No valid notes' };
  if (notes.reduce((sum, n) => sum + (n.p ? n.p.length : 0), 0) > MAX_MAP_PATH_POINTS) return { error: 'Slider paths too long' };
  return { notes };
};

// Can the session see this item (private items only for their owner and staff)
export const canSeeItem = (item, session) => {
  if ((item.visibility || 0) !== 2) return true;
  if (!session) return false;
  return session.admin || session.is_moderator || (item.username || '').toLowerCase() === (session.user || '').toLowerCase();
};

// Audio and video files; YouTube items are iframes the game can't time or control
const playableMime = (mime) => {
  mime = String(mime || '');
  return (mime.startsWith('audio/') || mime.startsWith('video/')) && mime !== 'video/youtube';
};

// What a map belongs to: an item, or one entry of an album item (every entry is its own track).
// -> { item, albumItemId } or { error, code }. albumItemId is null for normal items.
export const resolveTarget = async (itemId, albumItemId, session) => {
  itemId = parseInt(itemId, 10) || 0;
  albumItemId = parseInt(albumItemId, 10) || null;
  const [item] = await db`SELECT id, mime, username, COALESCE(visibility, 0) AS visibility, is_album FROM items WHERE id = ${itemId} AND active = true AND is_deleted = false LIMIT 1`;
  if (!item || !canSeeItem(item, session)) return { error: 'Not found', code: 404 };
  if (albumItemId) {
    const [sub] = await db`SELECT id, mime FROM album_items WHERE id = ${albumItemId} AND item_id = ${itemId} LIMIT 1`;
    if (!sub) return { error: 'Not found', code: 404 };
    if (!playableMime(sub.mime)) return { error: 'Maps are only for audio and video', code: 400 };
    return { item, albumItemId: sub.id };
  }
  if (!playableMime(item.mime)) return { error: 'Maps are only for audio and video items', code: 400 };
  return { item, albumItemId: null };
};

// Store a map (notes already validated with cleanNotes). -> id
export const insertMap = async ({ itemId, albumItemId = null, userId, title, notes, durationMs = 0 }) => {
  const [row] = await db`
    INSERT INTO sqc_maps ${db({
      item_id: itemId,
      album_item_id: albumItemId,
      user_id: userId,
      title: cleanTitle(title),
      notes: db.json(notes),
      note_count: notes.length,
      duration_ms: Math.max(0, Math.min(6 * 3600 * 1000, Math.round(durationMs) || 0)),
      created_at: ~~(Date.now() / 1e3),
    })}
    RETURNING id
  `;
  return row.id;
};
