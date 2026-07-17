import { getLevel } from "../admin.mjs";
import cfg from "../config.mjs";

export default async self => {
    return [{
        name: "help",
        call: /^!help$/i,
        active: true,
        f: async e => {
            const userLevel = getLevel(e.user).level;
            const availableCommands = [];

            for (const [name, trigger] of self._trigger.entries()) {
                // Skip if not active or not for this client
                if (!trigger.active) continue;
                if (trigger.clients && !trigger.clients.includes(e.type)) continue;

                // Skip if user level is too low
                if (trigger.level > userLevel) continue;

                // Determine display name for the command
                let cmdDisplay = name;
                if (trigger.call instanceof RegExp) {
                    // Try to extract a clean string from common RegExp patterns
                    cmdDisplay = trigger.call.source
                        .replace(/^(\^)/, '') // Remove ^ first
                        .replace(/(\$)$/, '') // Remove $
                        .replace(/^\\?\\\!/, '!') // Change \! or \\! to !
                        .replace(/(\.\*)$/, '...') // Change .* to ...
                        .replace(/\\s\+/, ' ') // Change \s+ to space
                        .replace(/\s\.\*/, ' ...') // Change space+.* to ...
                        .trim();
                }

                // Filter out specific commands requested by the user
                // We check both name and display name to be safe
                const ignored = ['f0ck', 'tags', 'thumb', 'self', 'level', 'del', 'rm', 'recover', 'parser', 'thumbnails', 'link'];
                if (ignored.some(i =>
                    name.toLowerCase().startsWith(i) ||
                    cmdDisplay.toLowerCase().replace(/^!/, '').startsWith(i)
                )) continue;

                availableCommands.push(cmdDisplay.startsWith('!') ? cmdDisplay : `!${cmdDisplay}`);
            }

            // Deduplicate and sort
            const uniqueCommands = [...new Set(availableCommands)].sort();

            const trigger = cfg.main.trigger || "!w";
            if (uniqueCommands.length === 0) {
                availableCommands.push(e.type === 'matrix' ? `${trigger} -sfw/nsfw -t tag1,tag2,tag3` : `${trigger} <url> or attachment`);
            } else {
                availableCommands.push(e.type === 'matrix' ? `${trigger} -sfw/nsfw -t tag1,tag2,tag3` : `${trigger} <url> or attachment`);
            }

            // Re-sort to include manually added command
            const finalCommands = [...new Set(availableCommands)].sort();

            const message = `**Available Commands:**\n\`\`\`\n${finalCommands.join('\n')}\n\`\`\``;

            await e.reply(message);
        }
    }];
};
