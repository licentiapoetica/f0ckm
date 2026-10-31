import db from "../sql.mjs";
import cfg from "../config.mjs";
import lib from "../lib.mjs";
import { getLevel } from "../admin.mjs";

export default async bot => {
  return [{
    name: "tags show",
    call: /^\!tags show \d+$/i,
    active: true,
    level: 100,
    f: async e => {
      const id = +e.args[1];
      if(!id)
        return await e.reply("lol no");
      const tags = (await lib.getTags(id)).map(t => t.tag);
      if(tags.length === 0)
        return await e.reply(`item ${cfg.main.url.full}/${id} has no tags!`);
      return await e.reply(`item ${cfg.main.url.full}/${id} is tagged as: ${tags.join(', ')}`);
    }
  }, {
    name: "tags add",
    call: /^\!tags add \d+ .*/i,
    active: false,
    level: 100,
    f: async e => {
      const id = +e.args[1];
      if(!id)
        return await e.reply("lol no");

      const tags = (await lib.getTags(id)).map(t => t.tag);
      
      const newtags = (e.message.includes(",")
        ? e.args.splice(2).join(" ").trim().split(",")
        : e.args.splice(2)).filter(t => !tags.includes(t) && t.length > 0);

      if(newtags.length === 0)
        return await e.reply("no (new) tags provided");

      await Promise.all(newtags.map(async ntag => {
        try {
          let tagid;
          const tag_exists = await db`
            select id, tag
            from "tags"
            where tag = ${ntag}
          `;
          if(tag_exists.length === 0) { // create new tag
            tagid = (await db`
              insert into "tags" ${
                db({
                  tag: ntag
                }, 'tag')
              }
            `)[0];
          }
          else {
            tagid = tag_exists[0].id;
          }
          return await db`
            insert into "tags_assign" ${
              db({
                tag_id: tagid,
                item_id: id,
                prefix: `${e.user.prefix}${e.channel}`
              }, 'tag_id', 'item_id', 'prefix')
            }
          `;
        } catch(err) {
          console.error(err);
        }
      }));

      const ntags = (await lib.getTags(id)).map(t => t.tag);
      if(ntags.length === 0)
        return await e.reply(`item ${cfg.main.url.full}/${id} has no tags!`);
      return await e.reply(`item ${cfg.main.url.full}/${id} is now tagged as: ${ntags.join(', ')}`);
    }
  }, {
    name: "tags remove",
    call: /^\!tags remove \d+ .*/i,
    active: false,
    level: 100,
    f: async e => {
      const id = +e.args[1];
      if(!id)
        return await e.reply("lol no");
      
      const tags = await lib.getTags(id);

      const removetags = (e.message.includes(",")
        ? e.args.splice(2).join(" ").trim().split(",")
        : e.args.splice(2)).filter(t => t.length > 0);
      
      if(removetags.length === 0)
        return await e.reply("no tags provided");

      const res = await Promise.all(removetags.map(async rtag => {
        const tagid = tags.filter(t => t.tag === rtag)[0]?.id ?? null;
        if(!tagid || tagid?.length === 0) {
          return {
            success: false,
            tag: rtag,
            msg: "tag is not assigned"
          };
        }

        const q = await db`
          delete from "tags_assign"
          where tag_id = ${+tagid}
          and item_id = ${+id}
          ${ getLevel(e.user.level < 50)
            ? db`and prefix = ${e.user.prefix + e.channel}`
            : db``
          }
        `;

        return {
          success: !!q,
          tag: rtag,
          tagid: tagid
        };
      }));

      await e.reply(JSON.stringify(res));

      const ntags = (await lib.getTags(id)).map(t => t.tag);
      if(ntags.length === 0)
        return await e.reply(`item ${cfg.main.url.full}/${id} has no tags!`);
      return await e.reply(`item ${cfg.main.url.full}/${id} is now tagged as: ${ntags.join(', ')}`);
    }
  }]
};
