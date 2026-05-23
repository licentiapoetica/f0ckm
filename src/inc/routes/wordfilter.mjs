import db from "../sql.mjs";
import lib from "../lib.mjs";
import audit from "../audit.mjs";

export default (router, tpl) => {
  // Auto-migration on startup
  db`CREATE TABLE IF NOT EXISTS public.wordfilter (
    id SERIAL PRIMARY KEY,
    word VARCHAR(255) NOT NULL UNIQUE,
    replacement VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`.catch(err => console.error('[WORDFILTER] DB Table Setup Failed:', err));

  // Admin View Render
  router.get(/^\/admin\/wordfilter\/?$/, lib.auth, async (req, res) => {
    res.reply({
      body: tpl.render("admin/wordfilter", {
        session: req.session,
        totals: await lib.countf0cks(),
        csrf_token: req.session?.csrf_token || ''
      }, req)
    });
  });

  // API list rules
  router.get('/api/v2/admin/wordfilter', lib.auth, async (req, res) => {
    try {
      const filters = await db`SELECT * FROM wordfilter ORDER BY created_at DESC`;
      return res.json({ success: true, filters });
    } catch (err) {
      return res.json({ success: false, msg: err.message }, 500);
    }
  });

  // API create rule
  router.post('/api/v2/admin/wordfilter', lib.auth, async (req, res) => {
    try {
      const { word, replacement } = req.post || {};
      if (!word || !word.trim() || !replacement || !replacement.trim()) {
        return res.json({ success: false, msg: 'Word and replacement are required' }, 400);
      }

      const cleanWord = word.trim();
      const cleanReplacement = replacement.trim();

      // Ensure no infinite loops or matches
      if (cleanWord.toLowerCase() === cleanReplacement.toLowerCase()) {
        return res.json({ success: false, msg: 'Word and replacement cannot be identical' }, 400);
      }

      await db`
        INSERT INTO wordfilter (word, replacement) 
        VALUES (${cleanWord}, ${cleanReplacement})
        ON CONFLICT (word) DO UPDATE SET replacement = EXCLUDED.replacement
      `;

      await audit.log(req.session.id, 'add_wordfilter', 'wordfilter', 0, { word: cleanWord, replacement: cleanReplacement });

      return res.json({ success: true });
    } catch (err) {
      return res.json({ success: false, msg: err.message }, 500);
    }
  });

  // API delete rule
  router.post('/api/v2/admin/wordfilter/delete', lib.auth, async (req, res) => {
    try {
      const { id } = req.post || {};
      if (!id) return res.json({ success: false, msg: 'ID required' }, 400);

      const rows = await db`DELETE FROM wordfilter WHERE id = ${id} RETURNING word`;
      if (rows.length > 0) {
        await audit.log(req.session.id, 'delete_wordfilter', 'wordfilter', id, { word: rows[0].word });
      }

      return res.json({ success: true });
    } catch (err) {
      return res.json({ success: false, msg: err.message }, 500);
    }
  });

  return router;
};
