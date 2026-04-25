import fetch from "flumm-fetch";
import { promises as fs } from "fs";
import { exec } from "child_process";
import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";
import path from "path";

export default async bot => {

  return [{
    name: "f0ck",
    call: /^\!f0ck .*/i,
    active: true,
    level: 100,
    f: async e => {
      switch(e.args[0]) {
        case "stats":
          const dirs = {
            b: await fs.readdir(cfg.paths.b),
            t: await fs.readdir(cfg.paths.t),
            ca: await fs.readdir(cfg.paths.ca)
          };
          const sizes = {
            b:  lib.formatSize((await Promise.all(dirs.b.map( async file => (await fs.stat(path.join(cfg.paths.b, file))).size)) ).reduce((a, b) => b + a)),
            t:  lib.formatSize((await Promise.all(dirs.t.map( async file => (await fs.stat(path.join(cfg.paths.t, file))).size)) ).reduce((a, b) => b + a)),
            ca: lib.formatSize((await Promise.all(dirs.ca.map(async file => (await fs.stat(path.join(cfg.paths.ca, file))).size))).reduce((a, b) => b + a)),
          };
          return await e.reply(`${dirs.b.length} f0cks: ${sizes.b}, ${dirs.t.length} thumbnails: ${sizes.t}, ${dirs.ca.length} coverarts: ${sizes.ca}`);
        case "limit":
          return await e.reply(`up to ${lib.formatSize(cfg.main.maxfilesize)} (${lib.formatSize(cfg.main.maxfilesize * cfg.main.adminmultiplier)} for admins)`);
        case "thumb":
          const rows = await db`
            select id
            from "items"
          `;
          const dir = (await fs.readdir(cfg.paths.t)).filter(d => d.endsWith(".webp")).map(e => +e.split(".")[0]);
          const tmp = [];
          for(let row of rows)
            !dir.includes(row.id) ? tmp.push(row.id) : null;
          await e.reply(`${tmp.length}, ${rows.length}, ${dir.length}`);
        break;
        case "cache":
          cfg.websrv.cache = !cfg.websrv.cache;
          return await e.reply(`Cache is ${cfg.websrv.cache ? "enabled" : "disabled"}`);
        case "uptime":
          exec('sudo systemctl status f0ck', async (err, stdout) => {
            if(!err)
              return await e.reply(stdout.split('\n')[2].trim().replace("Active: active (running)", "i'm active"));
          });
        break;
        case "restart":
          await e.reply("hay hay patron, hemen!");
          exec("sudo systemctl restart f0ck");
        break;
        case "clearTmp":
          await Promise.all((await fs.readdir(cfg.paths.tmp)).filter(d => d !== ".empty").map(async d => fs.unlink(path.join(cfg.paths.tmp, d))));
          await e.reply("cleared lol");
        break;
        case "status":
          const tmpc = await lib.countf0cks();
          await e.reply(`tagged: ${tmpc.tagged}; untagged: ${tmpc.untagged}; sfw: ${tmpc.sfw}; nsfw: ${tmpc.nsfw}; total: ${tmpc.total}`);
        break;
        /*case "autotagger":
          const body = { headers: { Authorization: `Basic ${cfg.tagger.btoa}` } };
          const res = await (await fetch(`${cfg.tagger.endpoint}/usage`, body)).json();
          if(res) {
            const processed = res.result.monthly_processed;
            const limit = res.result.monthly_limit;
            return await e.reply(`autotagger: usage/limit: ${processed}/${limit}`);
          }
          return;
        break;*/
        /*case "renameTag":
          const origTag = e.args.slice(1).join(' ');

          if(origTag.length <= 1)
            return await e.reply("absichtliche Provokation!");

          const origTagID = (await sql('tags').where('tag', origTag))[0].id;

          const affected = (await sql('tags_assign')
            .update({ 'tag_id': sql.raw('(select id from tags where tag = ?)', [ origTag ]) })
            .whereIn('tag_id', sql.raw('select id from tags where normalized = slugify(?)', [ origTag ]))
          ).toString();

          const deleted = (await sql('tags')
            .where('normalized', sql.raw('slugify(?)', [ origTag ]))
            .andWhereNot('id', origTagID)
            .del()
          );

          await e.reply(JSON.stringify({ affected, deleted }));
        break;*/
        case "help":
          await e.reply("cmds: stats, limit, thumb, cache, uptime, restart, cleanTags, clearTmp, status");
        break;
        default:
          return;
      }
    }
  }]
};
