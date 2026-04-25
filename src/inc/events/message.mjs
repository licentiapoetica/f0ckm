import logger from "../log.mjs";
import { getLevel } from "../../inc/admin.mjs";

const parseArgs = msg => {
  let args = msg.trim().split(" ")
    , cmd = args.shift();
  return {
    cmd: cmd.replace(/^(\.|\/|\!)/, ""),
    args: args
  };
};

export default async bot => {

  return [{
    name: "message",
    listener: "message",
    f: e => {
      logger.info(`${e.network} -> ${e.channel} -> ${e.user.nick}: ${e.message}`);

      // Sanitize Matrix messages to remove reply fallback
      // Matrix reply fallback format:
      // > <@user:example.com> message
      // > continued quote
      //
      // Actual reply
      if (e.type === 'matrix' && e.message) {
        let lines = e.message.split('\n');
        let i = 0;
        while (i < lines.length && (lines[i].startsWith('>') || lines[i].trim() === '')) {
            i++;
        }
        // Only strip if we found reply blocks, otherwise keep original
        if (i > 0) {
            e.message = lines.slice(i).join('\n').trim();
        }
      }

      let trigger;

      if (e.media) {
        trigger = [...bot._trigger.entries()].filter(t => t[1].name === "parser");
        if (!e.message)
          e.message = "";
      } else {
        console.log(`[MESSAGE DEBUG] Processing message: '${e.message}' from ${e.user.nick} (${e.type}). Prefix: ${e.user.prefix}`);
        trigger = [...bot._trigger.entries()].filter(t => {
          const matchesCall = t[1].call.exec(e.message);
          const includesClient = t[1].clients.includes(e.type);
          const isActive = t[1].active;
          const userLevel = getLevel(e.user).level;
          const hasLevel = t[1].level <= userLevel;

          if (matchesCall) {
            console.log(`[MESSAGE DEBUG] Matched trigger '${t[1].name}': ClientMatch=${includesClient}, Active=${isActive}, LevelMatch=${hasLevel} (UserLevel=${userLevel} vs Req=${t[1].level})`);
          }

          return matchesCall && includesClient && isActive && hasLevel;
        });
      }

      trigger.forEach(async t => {
        try {
          await t[1].f({ ...e, ...parseArgs(e.message) });
          console.log(`triggered > ${t[0]}`);
        }
        catch (err) {
          console.error(err);
          await e.reply(`${t[0]}: An error occured.`);
          logger.error(`${e.network} -> ${e.channel} -> ${e.user.nick}: ${err.toString ? err : JSON.stringify(err)}`);
        }
      });
    }
  }];

};
