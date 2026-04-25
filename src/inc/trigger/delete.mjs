import { promises as fs } from "fs";
import db from "../sql.mjs";
import cfg from "../config.mjs";
import path from "path";
import { getLevel } from "../../inc/admin.mjs";
import { moveToDeleted } from "../lib_delete.mjs";

export default async bot => {

  return [{
    name: "delete",
    call: /^\!(del|rm) .*/i,
    active: true,
    f: async e => {
      let deleted = [];

      for (let id of e.args) {
        id = +id;
        if (id <= 1)
          continue;

        const f0ck = await db`
          select dest, mime, username, userchannel, usernetwork
          from "items"
          where
            id = ${id} and
            active = 'true'
          limit 1
        `;
        const level = getLevel(e.user).level;

        if (f0ck.length === 0) {
          await e.reply(`f0ck ${id}: f0ck not found`);
          continue;
        }

        if (
          (f0ck[0].username !== (e.user.nick || e.user.username) ||
            f0ck[0].userchannel !== e.channel ||
            f0ck[0].usernetwork !== e.network) &&
          level < 100
        ) {
          await e.reply(`f0ck ${id}: insufficient permissions`);
          continue;
        }

        if (~~(new Date() / 1e3) >= (f0ck[0].stamp + 600) && level < 100) {
          await e.reply(`f0ck ${id}: too late lol`);
          continue;
        }

        await db`update "items" set active = 'false', is_deleted = true where id = ${id}`;

        await moveToDeleted(f0ck[0].dest, id);
        await fs.copyFile(path.join(cfg.paths.t, id + '.webp'), path.join(cfg.paths.deleted, 't', id + '.webp')).catch(_ => { });
        await fs.unlink(path.join(cfg.paths.t, id + '.webp')).catch(_ => { });

        if (f0ck[0].mime.startsWith('audio')) {
          await fs.copyFile(path.join(cfg.paths.ca, id + '.webp'), path.join(cfg.paths.deleted, 'ca', id + '.webp')).catch(_ => { });
          await fs.unlink(path.join(cfg.paths.ca, id + '.webp')).catch(_ => { });
        }

        deleted.push(id);
      }

      await e.reply(`deleted ${deleted.length}/${e.args.length} f0cks (${deleted.join(",")})`);
    }
  }, {
    name: "recover",
    call: /^\!(recover) .*/i,
    active: true,
    level: 100,
    f: async e => {
      let recovered = [];

      for (let id of e.args) {
        id = +id;
        if (id <= 1)
          continue;

        const f0ck = await db`
          select dest, mime
          from "items"
          where
            id = ${id} and
            active = 'false'
          limit 1
        `;

        if (f0ck.length === 0) {
          await e.reply(`f0ck ${id}: f0ck not found`);
          continue;
        }

        await fs.copyFile(path.join(cfg.paths.deleted, 'b', f0ck[0].dest), path.join(cfg.paths.b, f0ck[0].dest)).catch(_ => { });
        await fs.copyFile(path.join(cfg.paths.deleted, 't', id + '.webp'), path.join(cfg.paths.t, id + '.webp')).catch(_ => { });
        await fs.unlink(path.join(cfg.paths.deleted, 'b', f0ck[0].dest)).catch(_ => { });
        await fs.unlink(path.join(cfg.paths.deleted, 't', id + '.webp')).catch(_ => { });

        if (f0ck[0].mime.startsWith('audio')) {
          await fs.copyFile(path.join(cfg.paths.deleted, 'ca', id + '.webp'), path.join(cfg.paths.ca, id + '.webp')).catch(_ => { });
          await fs.unlink(path.join(cfg.paths.deleted, 'ca', id + '.webp')).catch(_ => { });
        }

        await db`update "items" set active = 'true' where id = ${id}`;

        recovered.push(id);
      }

      await e.reply(`recovered ${recovered.length}/${e.args.length} f0cks (${recovered.join(",")})`);
    }
  }]
};
