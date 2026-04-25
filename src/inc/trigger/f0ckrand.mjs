import db from "../sql.mjs";
import lib from "../lib.mjs";
import cfg from "../config.mjs";

export default async bot => {

  return [{
    name: "f0ckrand",
    call: /^gib f0ck/i,
    active: false,
    f: async e => {
      let args = e.args.slice(1);

      /*let rows = sql("items").select("id", "username", "mime", "size");

      for(let i = 0; i < args.length; i++) {
        if(args[i].charAt(0) === "!")
          rows = rows.where("username", "not ilike", args[i].slice(1));
        else
          rows = rows.where("username", "ilike", args[i]);
      }

      rows = await rows.orderByRaw("random()").limit(1);*/

      let rows = [];

      if (args.length === 0) {
        // Optimized random logic for no-args (global)
        const maxIdResult = await db`select max(id) as max_id from items`;
        const maxId = maxIdResult[0]?.max_id || 0;

        if (maxId > 0) {
          const randomId = Math.floor(Math.random() * maxId);
          rows = await db`
            select id, mime, username, size
            from "items"
            where id >= ${randomId} and active = true
            order by id asc
            limit 1
          `;

          if (rows.length === 0) {
            rows = await db`
              select id, mime, username, size
              from "items"
              where active = true
              order by id asc
              limit 1
            `;
          }
        }
      } else {
        // Filtered logic
        rows = await db`
          select id, mime, username, size
          from "items"
          where
          ${args.map(a => a.charAt(0) === "!"
          ? db`username not ilike ${a.slice(1)}`
          : db`username ilike ${a}`
        ).join(' and ')}
          order by random()
          limit 1
        `;
      }

      if (rows.length === 0)
        return await e.reply("nothing found, f0cker");

      return await e.reply(`f0ckrnd: ${cfg.main.url.full}/${rows[0].id} by: ${rows[0].username} (${rows[0].mime}, ~${lib.formatSize(rows[0].size)})`);
    }
  }];
};
