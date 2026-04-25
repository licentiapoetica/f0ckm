import queue from '../queue.mjs';
import db from '../sql.mjs';

export default async bot => {

  return [{
    name: "thumbnailer",
    call: /^\!thumb .*/i,
    active: true,
    level: 100,
    f: async e => {
      let processed = [];

      for(let id of e.args) {
        id = +id;
        if(id <= 1)
          continue;

        const f0ck = await db`
          select id, dest, mime, src
          from "items"
          where
            id = ${id} and
            active = 'true'
          limit 1
        `;

        if(f0ck.length === 0) {
          await e.reply(`f0ck ${id}: f0ck not found`);
          continue;
        }

        // gen thumb
        await queue.genThumbnail(f0ck[0].dest, f0ck[0].mime, f0ck[0].id, f0ck[0].src);

        processed.push(id);
      }

      return await e.reply(`thumbnails: ${processed.length}/${e.args.length} (${processed.join(",")})`);
    }
  }];
};
