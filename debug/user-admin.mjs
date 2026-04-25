import db from "../src/inc/sql.mjs";
import lib from "../src/inc/lib.mjs";

const usage = () => {
    console.log(`
Usage: node user-admin.mjs <command> [args]

Commands:
  hash <password>                            - Generate a password hash
  create <user> <pass> [--admin] [--mod]     - Create a new user
  delete <user>                              - Delete a user
  passwd <user> <new_pass>                   - Change a user's password
  list                                       - List all users
`);
    process.exit(1);
};

const args = process.argv.slice(2);
if (args.length === 0) usage();

const cmd = args[0];

(async () => {
    try {
        switch (cmd) {
            case "hash": {
                if (args.length < 2) usage();
                const hash = await lib.hash(args[1]);
                console.log(`Hash: ${hash}`);
                break;
            }

            case "create": {
                if (args.length < 3) usage();
                const username = args[1];
                const password = args[2];
                const isAdmin = args.includes("--admin");
                const isMod = args.includes("--mod");

                const hash = await lib.hash(password);
                const ts = ~~(Date.now() / 1e3);

                const existing = await db`select id from "user" where login = ${username.toLowerCase()}`;
                if (existing.length > 0) {
                    console.error(`Error: User '${username}' already exists.`);
                    process.exit(1);
                }

                const newUser = await db`
                    insert into "user" ("login", "user", "password", "admin", "is_moderator", "created_at")
                    values (${username.toLowerCase()}, ${username}, ${hash}, ${isAdmin}, ${isMod}, to_timestamp(${ts}))
                    returning id
                `;

                const userId = newUser[0].id;

                // Add default options
                await db`
                    insert into user_options (user_id, mode, theme, avatar)
                    values (${userId}, 3, 'amoled', 0)
                `;

                console.log(`Successfully created user '${username}' (ID: ${userId})`);
                break;
            }

            case "delete": {
                if (args.length < 2) usage();
                const username = args[1].toLowerCase();

                const result = await db`delete from "user" where login = ${username} returning id`;
                if (result.length === 0) {
                    console.error(`Error: User '${username}' not found.`);
                    process.exit(1);
                }
                console.log(`Successfully deleted user '${username}' (ID: ${result[0].id})`);
                break;
            }

            case "passwd": {
                if (args.length < 3) usage();
                const username = args[1].toLowerCase();
                const newPass = args[2];

                const hash = await lib.hash(newPass);
                const result = await db`update "user" set password = ${hash} where login = ${username} returning id`;

                if (result.length === 0) {
                    console.error(`Error: User '${username}' not found.`);
                    process.exit(1);
                }
                console.log(`Successfully updated password for user '${username}'`);
                break;
            }

            case "list": {
                const users = await db`select id, login, "user", admin, is_moderator, created_at from "user" order by id asc`;
                console.table(users);
                break;
            }

            default:
                usage();
        }
    } catch (err) {
        console.error("Fatal error:", err);
    } finally {
        process.exit(0);
    }
})();
