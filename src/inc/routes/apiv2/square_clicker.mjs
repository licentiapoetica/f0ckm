import db from '../../sql.mjs';
import lib from '../../lib.mjs';
import audit from '../../audit.mjs';
import { isSquareClickerActive, cleanNotes, cleanTitle, canSeeItem, resolveTarget, insertMap } from '../../square_clicker.mjs';
import { convertOsu, saveDiffs } from '../../beatmap.mjs';

// Square Clicker API: user-made beatmaps for audio and video items and their scores.
// 404 when the feature is switched off (websrv.square_clicker_enabled: false, see inc/square_clicker.mjs).
// Maps of an album belong to one of its entries (album_item_id), since every entry is its own track.
const notFound = (res) => res.json({ success: false, msg: 'Not found' }, 404);
const bodyOf = (req) => req.body || req.post || {};

export default router => {
  // List the maps of an item
  router.get(/^\/api\/v2\/sqc\/maps\/?$/, async (req, res) => {
    if (!isSquareClickerActive(new Date(), req.session)) return notFound(res);
    const itemId = parseInt(req.url.qs?.item_id, 10);
    if (!itemId) return res.json({ success: false, msg: 'item_id required' }, 400);
    const subId = parseInt(req.url.qs?.album_item_id, 10) || null;
    const [item] = await db`SELECT id, username, COALESCE(visibility, 0) AS visibility FROM items WHERE id = ${itemId} AND active = true AND is_deleted = false LIMIT 1`;
    if (!item || !canSeeItem(item, req.session)) return notFound(res);
    const maps = await db`
      SELECT m.id, m.title, m.note_count, m.duration_ms, m.plays, m.created_at, m.user_id, m.album_item_id,
             u.user AS username,
             (SELECT MAX(s.score) FROM sqc_scores s WHERE s.map_id = m.id) AS best
      FROM sqc_maps m
      LEFT JOIN "user" u ON u.id = m.user_id
      WHERE m.item_id = ${itemId} AND m.album_item_id IS NOT DISTINCT FROM ${subId}::int
      ORDER BY m.created_at DESC
      LIMIT 100
    `;
    return res.json({ success: true, maps });
  });

  // One map with its notes and top 10 scores
  router.get(/^\/api\/v2\/sqc\/maps\/(?<id>\d+)\/?$/, async (req, res) => {
    if (!isSquareClickerActive(new Date(), req.session)) return notFound(res);
    const id = parseInt(req.params.id, 10);
    const [map] = await db`
      SELECT m.id, m.item_id, m.album_item_id, m.title, m.notes, m.note_count, m.duration_ms, m.plays, m.created_at, m.user_id,
             u.user AS username, i.username AS item_owner, COALESCE(i.visibility, 0) AS visibility
      FROM sqc_maps m
      JOIN items i ON i.id = m.item_id AND i.active = true AND i.is_deleted = false
      LEFT JOIN "user" u ON u.id = m.user_id
      WHERE m.id = ${id}
      LIMIT 1
    `;
    if (!map || !canSeeItem({ visibility: map.visibility, username: map.item_owner }, req.session)) return notFound(res);
    const scores = await db`
      SELECT s.score, s.accuracy, s.max_combo, s.created_at, u.user AS username
      FROM sqc_scores s
      LEFT JOIN "user" u ON u.id = s.user_id
      WHERE s.map_id = ${id}
      ORDER BY s.score DESC, s.created_at ASC
      LIMIT 10
    `;
    delete map.item_owner;
    delete map.visibility;
    return res.json({ success: true, map, scores });
  });

  // Create a map (logged in; audio and video items)
  router.post(/^\/api\/v2\/sqc\/maps\/?$/, lib.loggedin, async (req, res) => {
    if (!isSquareClickerActive(new Date(), req.session)) return notFound(res);
    const b = bodyOf(req);
    const target = await resolveTarget(b.item_id, b.album_item_id, req.session);
    if (target.error) return res.json({ success: false, msg: target.error }, target.code);
    const duration = Math.max(0, Math.min(6 * 3600 * 1000, parseInt(b.duration_ms, 10) || 0));
    const v = cleanNotes(b.notes, duration);
    if (v.error) return res.json({ success: false, msg: v.error }, 400);
    const id = await insertMap({ itemId: target.item.id, albumItemId: target.albumItemId, userId: req.session.id, title: b.title, notes: v.notes, durationMs: duration });
    return res.json({ success: true, id });
  });

  // Import beatmap difficulties (.osu texts; the browser unpacks .osz sets and sends only these) as maps
  // of an item or album entry. Standard mode only; other modes and invalid files are reported as skipped.
  router.post(/^\/api\/v2\/sqc\/import\/?$/, lib.loggedin, async (req, res) => {
    if (!isSquareClickerActive(new Date(), req.session)) return notFound(res);
    const b = bodyOf(req);
    const target = await resolveTarget(b.item_id, b.album_item_id, req.session);
    if (target.error) return res.json({ success: false, msg: target.error }, target.code);
    const files = Array.isArray(b.files) ? b.files.slice(0, 40) : [];
    if (!files.length) return res.json({ success: false, msg: 'No .osu files' }, 400);
    if (files.reduce((sum, f) => sum + String((f && f.text) || '').length, 0) > 16 * 1024 * 1024) {
      return res.json({ success: false, msg: 'Too large' }, 413);
    }
    const diffs = [], skipped = [];
    for (const f of files) {
      const d = convertOsu(String((f && f.text) || ''));
      if (d.error) skipped.push({ version: d.version || String((f && f.name) || '?'), reason: d.error });
      else diffs.push(d);
    }
    diffs.sort((a, z) => a.notes.length - z.notes.length);
    const duration = Math.max(0, parseInt(b.duration_ms, 10) || 0);
    const r = await saveDiffs({ itemId: target.item.id, albumItemId: target.albumItemId, userId: req.session.id, diffs, durationMs: duration });
    return res.json({ success: true, imported: r.ids.length, ids: r.ids, skipped: [...skipped, ...r.skipped] });
  });

  // Edit a map (its creator, or staff: audited). Title and/or notes; changed notes clear the old scores,
  // which were made on a different map.
  router.put(/^\/api\/v2\/sqc\/maps\/(?<id>\d+)\/?$/, lib.loggedin, async (req, res) => {
    if (!isSquareClickerActive(new Date(), req.session)) return notFound(res);
    const id = parseInt(req.params.id, 10);
    const [map] = await db`SELECT id, item_id, user_id, title, duration_ms FROM sqc_maps WHERE id = ${id} LIMIT 1`;
    if (!map) return notFound(res);
    const isOwner = map.user_id === req.session.id;
    const isStaff = !!(req.session.admin || req.session.is_moderator);
    if (!isOwner && !isStaff) return res.json({ success: false, msg: 'Unauthorized' }, 403);
    const b = bodyOf(req);
    const upd = {};
    if (b.title !== undefined) upd.title = cleanTitle(b.title);
    let notesChanged = false;
    if (b.notes !== undefined) {
      const v = cleanNotes(b.notes, map.duration_ms);
      if (v.error) return res.json({ success: false, msg: v.error }, 400);
      upd.notes = db.json(v.notes);
      upd.note_count = v.notes.length;
      notesChanged = true;
    }
    if (!Object.keys(upd).length) return res.json({ success: false, msg: 'Nothing to change' }, 400);
    await db`UPDATE sqc_maps SET ${db(upd)} WHERE id = ${id}`;
    let scoresCleared = 0;
    if (notesChanged) {
      const r = await db`DELETE FROM sqc_scores WHERE map_id = ${id}`;
      scoresCleared = r.count || 0;
      await db`UPDATE sqc_maps SET plays = 0 WHERE id = ${id}`;
    }
    if (!isOwner) {
      audit.log(req.session.id, 'sqc_map_edit', 'sqc_map', id, { item_id: map.item_id, title: upd.title || map.title, notes_changed: notesChanged }).catch(() => {});
    }
    return res.json({ success: true, id, scores_cleared: scoresCleared });
  });

  // Submit a score (logged in). Plausibility-checked against the map, not trusted blindly.
  router.post(/^\/api\/v2\/sqc\/maps\/(?<id>\d+)\/scores\/?$/, lib.loggedin, async (req, res) => {
    if (!isSquareClickerActive(new Date(), req.session)) return notFound(res);
    const id = parseInt(req.params.id, 10);
    const [map] = await db`SELECT id, note_count FROM sqc_maps WHERE id = ${id} LIMIT 1`;
    if (!map) return notFound(res);
    const b = bodyOf(req);
    const hits = b.hits && typeof b.hits === 'object' ? b.hits : {};
    const h = {
      300: Math.max(0, parseInt(hits[300], 10) || 0),
      100: Math.max(0, parseInt(hits[100], 10) || 0),
      50: Math.max(0, parseInt(hits[50], 10) || 0),
      miss: Math.max(0, parseInt(hits.miss, 10) || 0),
    };
    if (h[300] + h[100] + h[50] + h.miss !== map.note_count) {
      return res.json({ success: false, msg: 'Score does not match the map' }, 400);
    }
    const maxCombo = Math.max(0, Math.min(map.note_count, parseInt(b.max_combo, 10) || 0));
    const accuracy = map.note_count ? +(((h[300] * 300 + h[100] * 100 + h[50] * 50) / (map.note_count * 300)) * 100).toFixed(2) : 0;
    // Upper bound: every note a 300 at full combo multiplier
    const maxScore = map.note_count * 300 * (1 + map.note_count / 25);
    const score = Math.max(0, Math.min(Math.round(maxScore), parseInt(b.score, 10) || 0));

    await db`
      INSERT INTO sqc_scores ${db({
        map_id: id,
        user_id: req.session.id,
        score,
        accuracy,
        max_combo: maxCombo,
        hits: db.json(h),
        created_at: ~~(Date.now() / 1e3),
      })}
    `;
    await db`UPDATE sqc_maps SET plays = plays + 1 WHERE id = ${id}`;
    return res.json({ success: true, score, accuracy });
  });

  // Delete a map: its creator, or staff (audited)
  router.delete(/^\/api\/v2\/sqc\/maps\/(?<id>\d+)\/?$/, lib.loggedin, async (req, res) => {
    if (!isSquareClickerActive(new Date(), req.session)) return notFound(res);
    const id = parseInt(req.params.id, 10);
    const [map] = await db`SELECT id, item_id, user_id, title FROM sqc_maps WHERE id = ${id} LIMIT 1`;
    if (!map) return notFound(res);
    const isOwner = map.user_id === req.session.id;
    const isStaff = !!(req.session.admin || req.session.is_moderator);
    if (!isOwner && !isStaff) return res.json({ success: false, msg: 'Unauthorized' }, 403);
    await db`DELETE FROM sqc_maps WHERE id = ${id}`;
    if (!isOwner) {
      audit.log(req.session.id, 'sqc_map_delete', 'sqc_map', id, { item_id: map.item_id, title: map.title }).catch(() => {});
    }
    return res.json({ success: true });
  });

  return router;
};
