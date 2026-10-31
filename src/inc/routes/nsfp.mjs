import db from "../sql.mjs";
import lib from "../lib.mjs";
import audit from "../audit.mjs";
import { getNsfpIds, setNsfpIds } from "../settings.mjs";

export default (router, tpl) => {

  // Admin page
  router.get(/^\/admin\/nsfp\/?$/, lib.auth, async (req, res) => {
    try {
      res.reply({
        body: tpl.render("admin/nsfp", {
          session: req.session,
          totals: await lib.countf0cks(),
          csrf_token: req.session?.csrf_token || ''
        }, req)
      });
    } catch (err) {
      console.error('[NSFP] Page render failed:', err);
      res.reply({ code: 500, body: 'Internal server error' });
    }
  });

  // API: list current NSFP tag IDs with names
  router.get('/api/v2/admin/nsfp', lib.auth, async (req, res) => {
    try {
      const ids = getNsfpIds();
      const tagRows = ids.length > 0
        ? await db`SELECT id, tag, normalized FROM tags WHERE id IN ${db(ids)} ORDER BY id`
        : [];
      const tagMap = Object.fromEntries(tagRows.map(r => [r.id, r]));
      const enriched = ids.map(id => tagMap[id] || { id, tag: '(unknown)', normalized: null });

      const blockedCount = ids.length > 0
        ? Number((await db`
            SELECT COUNT(DISTINCT item_id) AS cnt
            FROM tags_assign
            WHERE tag_id IN ${db(ids)}
              AND item_id IN (SELECT id FROM items WHERE active = true)
          `)[0].cnt)
        : 0;

      return res.json({ success: true, nsfp: enriched, raw_ids: ids, blocked_count: blockedCount });
    } catch (err) {
      return res.json({ success: false, msg: err.message }, 500);
    }
  });

  // API: search tags for the add-tag autocomplete
  router.get('/api/v2/admin/nsfp/search', lib.auth, async (req, res) => {
    try {
      const q = (req.url.qs?.q || '').trim();
      if (!q) return res.json({ success: true, tags: [] });
      const pattern = '%' + q + '%';
      const tags = await db`
        SELECT id, tag, normalized
        FROM tags
        WHERE tag ILIKE ${pattern} OR normalized ILIKE ${pattern}
        ORDER BY tag
        LIMIT 20
      `;
      return res.json({ success: true, tags });
    } catch (err) {
      return res.json({ success: false, msg: err.message }, 500);
    }
  });

  // API: add a tag ID to the NSFP list
  router.post('/api/v2/admin/nsfp/add', lib.auth, async (req, res) => {
    try {
      const tagId = parseInt(req.post?.tag_id);
      if (!tagId || isNaN(tagId) || tagId <= 0) {
        return res.json({ success: false, msg: 'A valid tag_id is required' }, 400);
      }

      const tag = await db`SELECT id, tag FROM tags WHERE id = ${tagId} LIMIT 1`;
      if (tag.length === 0) {
        return res.json({ success: false, msg: 'Tag with id ' + tagId + ' does not exist' }, 404);
      }

      const current = getNsfpIds();
      if (current.includes(tagId)) {
        return res.json({ success: false, msg: 'Tag #' + tagId + ' (' + tag[0].tag + ') is already in the NSFP list' }, 409);
      }

      const updated = [...current, tagId];
      setNsfpIds(updated);

      await db`
        INSERT INTO site_settings (key, value)
        VALUES ('nsfp', ${JSON.stringify(updated)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;

      await audit.log(req.session.id, 'nsfp_add', 'tag', tagId, { tag: tag[0].tag, nsfp: updated });

      return res.json({ success: true, nsfp_ids: getNsfpIds(), added: tag[0] });
    } catch (err) {
      console.error('[NSFP] Add failed:', err);
      return res.json({ success: false, msg: err.message }, 500);
    }
  });

  // API: remove a tag ID from the NSFP list
  router.post('/api/v2/admin/nsfp/remove', lib.auth, async (req, res) => {
    try {
      const tagId = parseInt(req.post?.tag_id);
      if (!tagId || isNaN(tagId)) {
        return res.json({ success: false, msg: 'tag_id is required' }, 400);
      }

      const current = getNsfpIds();
      if (!current.includes(tagId)) {
        return res.json({ success: false, msg: 'Tag #' + tagId + ' is not in the NSFP list' }, 404);
      }

      const updated = current.filter(id => id !== tagId);
      setNsfpIds(updated);

      await db`
        INSERT INTO site_settings (key, value)
        VALUES ('nsfp', ${JSON.stringify(updated)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;

      await audit.log(req.session.id, 'nsfp_remove', 'tag', tagId, { nsfp: updated });

      return res.json({ success: true, nsfp_ids: getNsfpIds() });
    } catch (err) {
      console.error('[NSFP] Remove failed:', err);
      return res.json({ success: false, msg: err.message }, 500);
    }
  });

  return router;
};
