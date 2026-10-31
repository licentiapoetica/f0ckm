import cfg from "../config.mjs";
import db from "../sql.mjs";
import lib from "../lib.mjs";

const regex = new RegExp(`(https?:\\/\\/${cfg.main.url.regex})(\\/(?:video|image|audio|tag\\/[^/\\s]+|user\\/[^/\\s]+(?:\\/favs)?|h\\/[^/\\s]+))?\\/(\\d+|(?:b\\/)\\w{8}\\.(?:jpg|webm|gif|mp4|png|mov|mp3|ogg|flac))`, 'gi');

export default async bot => {

  return [{
    name: "f0ckgag",
    call: regex,
    active: true,
    f: async e => {
      const dat = e.message.match(regex)[0].split(/\//).pop();
      const nsflId = cfg.nsfl_tag_id || 3;
      const rows = await db`
        select i.id, i.mime, i.size, i.username, i.stamp,
        (select t.tag from tags_assign ta join tags t on t.id = ta.tag_id where ta.item_id = i.id and ta.tag_id in (1, 2, ${nsflId}) order by ta.tag_id asc limit 1) as rating
        from "items" i
        ${dat.includes('.')
          ? db`where i.dest = ${dat}`
          : db`where i.id = ${dat}`
        }
      `;

      if (rows.length === 0)
        return await e.reply("no f0cks given! lol D:");

      const row = rows[0];
      const rating = row.rating || 'untagged';
      
      let ratingStr = rating;
      if (e.type === 'irc') {
        const color = rating === 'sfw' ? 'green' : (rating === 'nsfw' ? 'red' : 'brown');
        ratingStr = `[color=${color}]${rating}[/color]`;
      }

      const link = `${cfg.main.url.full}/${row.id}`.replace('http://', 'https://');
      const msg = [
        e.type === 'matrix' ? `ID: ${row.id}` : link,
        ratingStr,
        `user: ${row.username}`,
        `~${lib.formatSize(row.size)}`,
        row.mime,
        new Date(row.stamp * 1e3).toString().slice(0, 24)
      ].join(" - ");

      if (e.type === 'matrix') {
        const color = rating === 'sfw' ? '#00ff00' : (rating === 'nsfw' ? '#ff0000' : '#888888');
        const formattedRating = `<font color="${color}"><b>${rating}</b></font>`;
        const formattedMsg = [
          e.type === 'matrix' ? `ID: ${row.id}` : link,
          formattedRating,
          `user: ${row.username}`,
          `~${lib.formatSize(row.size)}`,
          row.mime,
          new Date(row.stamp * 1e3).toString().slice(0, 24)
        ].join(" - ");
        
        return await e.reply({
          body: msg.replace(/\[\/?(b|color.*?|i)\]/g, ''),
          formatted_body: formattedMsg
        });
      }

      await e.reply(msg);
    }
  }];
};
