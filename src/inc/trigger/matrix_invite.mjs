import db from "../sql.mjs";
import cfg from "../config.mjs";
import lib from "../lib.mjs";

export default async self => {
    return [{
        name: "invite_matrix",
        call: /^!invite$/i,
        active: true,
        f: async e => {
            console.log(`[MATRIX INVITE] Triggered. Type: ${e.type}`);
            if (e.type !== 'matrix') return;
            
            const mxid = e.user.account;
            const matrixClient = self.bot.clients.find(c => c.type === 'matrix')?.client;
            
            if (!matrixClient) {
                return await e.reply("Matrix client not found.");
            }

            // Check existing
            const existing = await db`select 1 from invite_tokens where created_by_matrix = ${mxid} limit 1`;
            if (existing.length > 0) {
                 await matrixClient.sendmsg(null, mxid, "You have already generated an invite token.");
                 return;
            }
            
            // Generate
            const secret = cfg.main.invite_secret;
            const token = lib.sha256(lib.createID() + secret).substring(0, 10).toUpperCase();

            await db`
                insert into invite_tokens (token, created_at, created_by_matrix)
                values (${token}, ${~~(Date.now() / 1e3)}, ${mxid})
            `;
            
            // DM
            const msg = `**Your Invite Token:** ${token}\n**Register here:** ${cfg.main.url.full}/register?token=${token}`;
            await matrixClient.sendmsg(null, mxid, msg);
            
            // Reply in room (if not DM? But we ignore DMs now anyway so this trigger only works in public rooms)
            await e.reply("I've sent you a direct message with your invite token.");
        }
    }];
};
