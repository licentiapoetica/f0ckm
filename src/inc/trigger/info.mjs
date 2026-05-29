import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";

// Matches any URL that contains the site's own domain followed by an item ID,
// handling all URL patterns:
//   /<id>
//   /h/<hall>/<id>
//   /tag/<tag>/<id>
//   /user/<user>/<id>
//   /user/<user>/favs/<id>
//   etc.
const buildSiteItemRegex = (domain) => {
  // Escape dots in domain for use in regex
  const escapedDomain = domain.replace(/\./g, '\\.');
  // Match https://domain/<anything>/<digits> or https://domain/<digits>
  return new RegExp(
    `https?://${escapedDomain}/(?:[^\\s/]+/)*?(\\d+)(?:[/?#]|$)`,
    'gi'
  );
};

export default async bot => {
  const domain = cfg.main.url.domain;
  const siteItemRegex = buildSiteItemRegex(domain);

  return [{
    name: "info",
    // Match any message from matrix that contains a URL with the site domain + item ID
    call: new RegExp(
      `https?://${domain.replace(/\./g, '\\.')}(?:/[^\\s]*)?/(\\d+)`,
      'i'
    ),
    active: true,
    clients: ["matrix"],
    level: 0,
    f: async e => {
      // Reset lastIndex before exec since the regex is shared/stateful
      siteItemRegex.lastIndex = 0;

      // Collect all item IDs mentioned in the message (deduplicated)
      const itemIds = new Set();
      let match;
      const msgRegex = buildSiteItemRegex(domain);
      while ((match = msgRegex.exec(e.message)) !== null) {
        const id = parseInt(match[1], 10);
        if (id > 0) itemIds.add(id);
      }

      if (itemIds.size === 0) return;

      for (const itemid of itemIds) {
        try {
          const rows = await db`
            SELECT
              i.id,
              i.mime,
              i.size,
              i.username,
              i.stamp,
              (
                SELECT t.tag
                FROM tags_assign ta
                JOIN tags t ON t.id = ta.tag_id
                WHERE ta.item_id = i.id
                  AND ta.tag_id IN (1, 2, ${cfg.nsfl_tag_id || 3})
                ORDER BY ta.tag_id ASC
                LIMIT 1
              ) as rating
            FROM items i
            WHERE i.id = ${itemid}
              AND i.active = true
              AND i.is_deleted = false
            LIMIT 1
          `;

          if (!rows.length) continue;

          const item = rows[0];
          const rating = item.rating || 'untagged';
          // Format: "Sun Apr 12 2026 12:32:19" — matches existing bot output style
          const d = new Date(item.stamp * 1000);
          const dateStr = d.toString().replace(/\s*\(.+\)$/, '').replace(/\s+GMT[+-]\d+/, '').trim();
          const size = lib.formatSize(item.size);

          const reply = `ID: ${item.id} - ${rating} - user: ${item.username} - ~${size} - ${item.mime} - ${dateStr}`;
          await e.reply(reply);
        } catch (err) {
          console.error(`[INFO] Failed to look up item ${itemid}:`, err);
        }
      }
    }
  }];
};
