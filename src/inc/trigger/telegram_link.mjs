import db from "../sql.mjs";
import cfg from "../config.mjs";

export default async self => {
    return [{
        name: "telegram_link",
        call: /^!link(?:\s+(.+))?$/i,
        active: true,
        clients: ["tg"],
        f: async e => {
            // Only for Telegram
            if (e.type !== 'tg') return false;

            let token = (e.args[0] || '').trim().toUpperCase();

            // Scenario 1: User typed "!link" only (no token)
            if (!token) {
                await e.reply(`Please generate a link token on the website at ${cfg.main.url.full}/settings and then send: !link <TOKEN>`);
                return true;
            }

            // Scenario 2: Processing a token
            try {
                // Find token in DB
                const linkData = (await db`
                    SELECT user_id FROM link_token WHERE token = ${token}
                `)[0];

                if (!linkData) {
                    return await e.reply("Invalid or expired token. Please generate a new one at the website settings page.");
                }

                // Use the Telegram numeric user ID as the alias (most stable identifier)
                const alias = e.user.account; // e.g. "123456789"

                // Check if already linked to THIS user
                const existing = await db`
                    SELECT 1 FROM user_alias
                    WHERE userid = ${linkData.user_id}
                    AND alias = ${alias}
                    AND type = 'telegram'
                `;

                if (existing.length > 0) {
                    return await e.reply("This Telegram account is already linked to your website profile.");
                }

                // Check if this Telegram account is linked to ANOTHER user (prevent hijacking)
                const taken = await db`
                    SELECT 1 FROM user_alias
                    WHERE alias = ${alias}
                    AND type = 'telegram'
                `;

                if (taken.length > 0) {
                    return await e.reply("This Telegram account is already linked to a different website profile.");
                }

                // Perform Link
                await db`
                    INSERT INTO user_alias (userid, alias, type)
                    VALUES (${linkData.user_id}, ${alias}, 'telegram')
                    ON CONFLICT DO NOTHING
                `;

                // Delete used token
                await db`DELETE FROM link_token WHERE token = ${token}`;

                const tgUsername = e.user.username ? `@${e.user.username}` : e.user.nick;
                return await e.reply(`Successfully linked Telegram account ${tgUsername} (ID: ${alias}) to your website profile!`);

            } catch (err) {
                console.error("[Telegram Link] Error:", err);
                return await e.reply("An internal error occurred while linking your account.");
            }
        }
    }];
};
