import db from "../sql.mjs";

export default async self => {
    return [{
        name: "matrix_link",
        call: /(^!link(?:\s+(.+))?$)|(^[a-z0-9]{6}$)/i, // Accepts !link, !link <token>, or just <token>
        active: true,
        f: async e => {
            // Only for Matrix
            if (e.type !== 'matrix') return false;

            let token = e.args[0] || e.message; // args[0] if !link <token>, message if just token match
            
            // Clean up token
            token = token.replace('!link', '').trim().toUpperCase();

            // Senerio 1: User typed "!link" only (no token)
            if (!token) {
                 // Send DM
                 const matrixClient = self.bot.clients.find(c => c.type === 'matrix')?.client;
                 if (matrixClient) {
                     try {
                        await matrixClient.sendmsg(null, e.user.account, "Please paste your link token here.");
                        if (e.channel !== 'DM' && !e.channelid.includes(e.user.account)) { 
                            // Only reply in public if not already in DM (heuristics vary)
                             await e.reply("I've sent you a DM. Please paste your token there.");
                        }
                     } catch (err) {
                         await e.reply("I couldn't DM you. Please check your privacy settings or start a chat with me first.");
                     }
                 }
                 return true;
            }

            // Scenario 2: Processing a potential token
            try {
                // Find token
                const linkData = (await db`
                    SELECT user_id FROM link_token WHERE token = ${token}
                `)[0];

                if (!linkData) {
                    // If it looked like a token but isn't valid, and was sent as !link <token>, warn.
                    // If just a random 6-char string in public, ignore silently to avoid spam.
                    if (e.message.toLowerCase().startsWith('!link')) {
                         return await e.reply("Invalid or expired token. Please generate a new one.");
                    }
                    return false; // Not a command, not a valid token. Pass.
                }

                // Format alias for Matrix (usually the sender ID)
                const alias = e.user.account; // This should be the full Matrix ID e.g. @user:server

                // Check if already linked to THIS user
                const existing = await db`
                    SELECT 1 FROM user_alias 
                    WHERE userid = ${linkData.user_id} 
                    AND lower(alias) = lower(${alias}) 
                    AND type = 'matrix'
                `;

                if (existing.length > 0) {
                    return await e.reply("This Matrix account is already linked to your website profile.");
                }

                // Check if this Matrix account is linked to ANOTHER user (prevent hijacking)
                const taken = await db`
                    SELECT 1 FROM user_alias 
                    WHERE lower(alias) = lower(${alias}) 
                    AND type = 'matrix'
                `;

                if (taken.length > 0) {
                    return await e.reply("This Matrix account is already linked to a different website profile.");
                }

                // Perform Link
                await db`
                    INSERT INTO user_alias (userid, alias, type) 
                    VALUES (${linkData.user_id}, ${alias}, 'matrix')
                    ON CONFLICT DO NOTHING
                `;

                // Delete used token
                await db`DELETE FROM link_token WHERE token = ${token}`;

                return await e.reply({
                    body: `Successfully linked Matrix account ${alias} to your website profile!`,
                    formatted_body: `Successfully linked Matrix account <b>${alias}</b> to your website profile!`
                });

            } catch (err) {
                console.error("[Matrix Link] Error:", err);
                if (e.message.toLowerCase().startsWith('!link')) {
                    return await e.reply("An internal error occurred while linking your account.");
                }
            }
        }
    }];
};
