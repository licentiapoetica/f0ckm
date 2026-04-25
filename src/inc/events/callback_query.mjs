import logger from "../log.mjs";
import { getLevel } from "../../inc/admin.mjs";
import { promises as fs } from "fs";
import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";
import path from "path";

const tagkeyboard = id => {
  const tags = [{
    tag: 'music',
    id: 9124
  }, {
    tag: 'german',
    id: 9161
  }, {
    tag: 'cat',
    id: 559
  }, {
    tag: 'doggo',
    id: 10932
  }];
  return Promise.all(tags.map(async t => ({ text: `${await lib.hasTag(id, t.id) ? '✓ ' : ''}${t.tag}`, callback_data: `b_settag_${t.id}:${id}` })));
};

export default async bot => {

  return [{
    name: "callback_query",
    listener: "callback_query",
    f: async e => {
      logger.info(`${e.network} -> ${e.channel} -> ${e.user.nick}: ${e.message}`);

      let [cmd, id] = e.opt.data.split(':');
      let f0ck;
      id = +id;

      if (cmd.startsWith('b_settag_')) {
        const tagid = +cmd.replace('b_settag_', '');

        if (!(await lib.getTags(id)).filter(tag => tag.id == tagid).length) {
          // insert
          await db`
            insert into "tags_assign" ${db({
            item_id: id,
            tag_id: tagid,
            user_id: 1
          })
            }
          `;
        }
        else {
          // delete
          await db`
            delete from "tags_assign"
            where tag_id = ${tagid}
            and item_id = ${id}
          `;
        }

        const keyboard = await tagkeyboard(id);

        return await e.editMessageText(e.raw.chat.id, e.raw.message_id, e.message, {
          reply_markup: JSON.stringify({
            inline_keyboard: [[
              ...keyboard
            ], [
              { text: 'back', callback_data: `b_back:${id}` }
            ]]
          })
        });
      }

      switch (cmd) {
        case "b_tags":
          if (!id)
            return;

          const keyboard = await tagkeyboard(id);

          await e.editMessageText(e.raw.chat.id, e.raw.message_id, e.message, {
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                ...keyboard
              ], [
                { text: 'back', callback_data: `b_back:${id}` }
              ]]
            })
          });
          break;
        case "b_back":
          if (!id)
            return;

          await e.editMessageText(e.raw.chat.id, e.raw.message_id, e.message, {
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: (await lib.hasTag(id, 1) ? '✓ ' : '') + 'sfw', callback_data: `b_sfw:${id}` },
                { text: (await lib.hasTag(id, 2) ? '✓ ' : '') + 'nsfw', callback_data: `b_nsfw:${id}` },
                { text: 'tags', callback_data: `b_tags:${id}` },
                { text: '❌ delete', callback_data: `b_delete:${id}` }
              ], [
                { text: `open f0ck #${id}`, url: `${cfg.main.url.full}/${id}` }
              ]]
            })
          });
          break;
        case "b_sfw":

          if (!id)
            return;

          if (!await lib.hasTag(id, 1)) {
            // insert
            await db`
              insert into "tags_assign" ${db({
              item_id: id,
              tag_id: 1, // sfw
              user_id: 1
            })
              }
            `;
            if (await lib.hasTag(id, 2)) {
              await db`
                delete from "tags_assign"
                where tag_id = 2
                and item_id = ${id}
              `;
            }
          }
          else {
            // delete
            await db`
              delete from "tags_assign"
              where tag_id = 1
              and item_id = ${id}
            `;
          }

          return await e.editMessageText(e.raw.chat.id, e.raw.message_id, e.message, {
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: (await lib.hasTag(id, 1) ? '✓ ' : '') + 'sfw', callback_data: `b_sfw:${id}` },
                { text: (await lib.hasTag(id, 2) ? '✓ ' : '') + 'nsfw', callback_data: `b_nsfw:${id}` },
                { text: 'tags', callback_data: `b_tags:${id}` },
                { text: '❌ delete', callback_data: `b_delete:${id}` }
              ], [
                { text: `open f0ck #${id}`, url: `${cfg.main.url.full}/${id}` }
              ]]
            })
          });

          break;
        case "b_nsfw":
          if (!id)
            return;

          if (!await lib.hasTag(id, 2)) {
            // insert
            await db`
              insert into "tags_assign" ${db({
              item_id: id,
              tag_id: 2, // nsfw
              user_id: 1
            })
              }
            `;
            if (await lib.hasTag(id, 1)) {
              await db`
                delete from "tags_assign"
                where tag_id = 1
                and item_id = ${id}
              `;
            }
          }
          else {
            // delete
            await db`
              delete from "tags_assign"
              where tag_id = 2
              and item_id = ${id}
            `;
          }

          return await e.editMessageText(e.raw.chat.id, e.raw.message_id, e.message, {
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: (await lib.hasTag(id, 1) ? '✓ ' : '') + 'sfw', callback_data: `b_sfw:${id}` },
                { text: (await lib.hasTag(id, 2) ? '✓ ' : '') + 'nsfw', callback_data: `b_nsfw:${id}` },
                { text: 'tags', callback_data: `b_tags:${id}` },
                { text: '❌ delete', callback_data: `b_delete:${id}` }
              ], [
                { text: `open f0ck #${id}`, url: `${cfg.main.url.full}/${id}` }
              ]]
            })
          });
          break;
        case "b_delete":
          if (id <= 1)
            return;

          e.user = {
            prefix: `${e.raw.reply_to_message.from.username}!${e.raw.reply_to_message.from.id}@${e.network}`,
            nick: e.raw.reply_to_message.from.first_name,
            username: e.raw.reply_to_message.from.username,
            account: e.raw.reply_to_message.from.id.toString()
          };

          f0ck = await db`
            select dest, mime, username, userchannel, usernetwork
            from "items"
            where
              id = ${id} and
              active = 'true'
            limit 1
          `;
          const level = getLevel(e.user).level;

          if (f0ck.length === 0) {
            return await e.reply(`f0ck ${id}: f0ck not found`);
          }

          if (
            (f0ck[0].username !== (e.user.nick || e.user.username) ||
              f0ck[0].userchannel !== e.channel ||
              f0ck[0].usernetwork !== e.network) &&
            level < 100
          ) {
            return await e.reply(`f0ck ${id}: insufficient permissions`);
          }

          if (~~(new Date() / 1e3) >= (f0ck[0].stamp + 600) && level < 100) {
            return await e.reply(`f0ck ${id}: too late lol`);
          }

          await db`update "items" set active = 'false', is_deleted = true where id = ${id}`;

          await fs.copyFile(path.join(cfg.paths.b, f0ck[0].dest), path.join(cfg.paths.deleted, 'b', f0ck[0].dest)).catch(_ => { });
          await fs.copyFile(path.join(cfg.paths.t, `${id}.webp`), path.join(cfg.paths.deleted, 't', `${id}.webp`)).catch(_ => { });
          await fs.unlink(path.join(cfg.paths.b, f0ck[0].dest)).catch(_ => { });
          await fs.unlink(path.join(cfg.paths.t, `${id}.webp`)).catch(_ => { });

          if (f0ck[0].mime.startsWith('audio')) {
            await fs.copyFile(path.join(cfg.paths.ca, `${id}.webp`), path.join(cfg.paths.deleted, 'ca', `${id}.webp`)).catch(_ => { });
            await fs.unlink(path.join(cfg.paths.ca, `${id}.webp`)).catch(_ => { });
          }

          await e.editMessageText(e.raw.chat.id, e.raw.message_id, e.message, {
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: (await lib.hasTag(id, 1) ? '✓ ' : '') + 'sfw', callback_data: `b_sfw:${id}` },
                { text: (await lib.hasTag(id, 2) ? '✓ ' : '') + 'nsfw', callback_data: `b_nsfw:${id}` },
                { text: 'tags', callback_data: `b_tags:${id}` },
                { text: 'recover', callback_data: `b_recover:${id}` }
              ], [
                { text: `open f0ck #${id}`, url: `${cfg.main.url.full}/${id}` }
              ]]
            })
          });
          break;
        case "b_recover":
          if (id <= 1)
            return;

          e.user = {
            prefix: `${e.raw.reply_to_message.from.username}!${e.raw.reply_to_message.from.id}@${e.network}`,
            nick: e.raw.reply_to_message.from.first_name,
            username: e.raw.reply_to_message.from.username,
            account: e.raw.reply_to_message.from.id.toString()
          };

          f0ck = await db`
            select dest, mime
            from "items"
            where
              id = ${id} and
              active = 'false'
            limit 1
          `;

          if (f0ck.length === 0) {
            return await e.reply(`f0ck ${id}: f0ck not found`);
          }

          await fs.copyFile(path.join(cfg.paths.deleted, 'b', f0ck[0].dest), path.join(cfg.paths.b, f0ck[0].dest)).catch(_ => { });
          await fs.copyFile(path.join(cfg.paths.deleted, 't', `${id}.webp`), path.join(cfg.paths.t, `${id}.webp`)).catch(_ => { });
          await fs.unlink(path.join(cfg.paths.deleted, 'b', f0ck[0].dest)).catch(_ => { });
          await fs.unlink(path.join(cfg.paths.deleted, 't', `${id}.webp`)).catch(_ => { });

          if (f0ck[0].mime.startsWith('audio')) {
            await fs.copyFile(path.join(cfg.paths.deleted, 'ca', `${id}.webp`), path.join(cfg.paths.ca, `${id}.webp`)).catch(_ => { });
            await fs.unlink(path.join(cfg.paths.deleted, 'ca', `${id}.webp`)).catch(_ => { });
          }

          await db`update "items" set active = 'true' where id = ${id}`;

          await e.editMessageText(e.raw.chat.id, e.raw.message_id, e.message, {
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: (await lib.hasTag(id, 1) ? '✓ ' : '') + 'sfw', callback_data: `b_sfw:${id}` },
                { text: (await lib.hasTag(id, 2) ? '✓ ' : '') + 'nsfw', callback_data: `b_nsfw:${id}` },
                { text: 'tags', callback_data: `b_tags:${id}` },
                { text: '❌ delete', callback_data: `b_delete:${id}` }
              ], [
                { text: `open f0ck #${id}`, url: `${cfg.main.url.full}/${id}` }
              ]]
            })
          });
          break;
        default:
          await e.reply('lol');
      }
    }
  }];

};
