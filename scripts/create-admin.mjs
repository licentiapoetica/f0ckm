import db from "../src/inc/sql.mjs";
import lib from "../src/inc/lib.mjs";
import cfg from "../src/inc/config.mjs";

const [username, password] = process.argv.slice(2);

if (!username || !password) {
    console.error("Usage: node scripts/create-admin.mjs <username> '<password>'");
    console.error("Note: Wrap the password in single quotes to prevent your shell from interpreting special characters (like !).");
    process.exit(1);
}

if (password.length < 20) {
    console.error("Error: Password must be at least 20 characters long to meet system security requirements.");
    process.exit(1);
}

async function createAdmin() {
    console.log(`--- Creating Admin User: ${username} ---`);

    // Check if user exists
    const existing = await db`select id from "user" where "login" = ${username.toLowerCase()} or "user" = ${username}`;
    const hash = await lib.hash(password);
    const ts = ~~(Date.now() / 1e3);

    if (existing.length > 0) {
        const userId = existing[0].id;
        console.log(`User already exists. Updating password and ensuring admin status for ID: ${userId}...`);
        
        await db`
            update "user" 
            set password = ${hash}, admin = true, is_moderator = true, activated = true 
            where id = ${userId}
        `;
        
        console.log(`--- Admin User ${username} Updated Successfully ---`);
        process.exit(0);
    }

    // The first admin must be user id 1. Claim it explicitly when it is free; refuse if a non-admin already has it.
    const idOne = await db`select login, admin from "user" where id = 1`;
    if (idOne.length && !idOne[0].admin) {
        console.error(`Error: user id 1 belongs to the non-admin account "${idOne[0].login}". The first admin must be id 1.`);
        console.error('Create the admin on a fresh database (right after loading the schema), or move that account off id 1 first.');
        process.exit(1);
    }

    try {
        const newUser = idOne.length
            ? await db`
                insert into "user" ("login", "password", "user", "created_at", "admin", "is_moderator", "activated")
                values (${username.toLowerCase()}, ${hash}, ${username}, to_timestamp(${ts}), true, true, true)
                returning id
            `
            : await db.begin(async (sql) => {
                const row = await sql`
                    insert into "user" ("id", "login", "password", "user", "created_at", "admin", "is_moderator", "activated")
                    values (1, ${username.toLowerCase()}, ${hash}, ${username}, to_timestamp(${ts}), true, true, true)
                    returning id
                `;
                // An explicit id doesn't advance the sequence: move it past every existing id
                await sql`select setval('public.user_id_seq', (select max(id) from "user"))`;
                return row;
            });
        const userId = newUser[0].id;

        await db`
            insert into user_options (user_id, mode, theme, fullscreen, avatar, avatar_file, use_new_layout, disable_autoplay, disable_swiping)
            values (${userId}, 3, 'amoled', 0, null, 'default.png', ${(cfg.websrv.default_layout ?? 'modern') !== 'legacy'}, false, false)
        `;

        console.log(`--- Admin User ${username} Created Successfully ---`);
        process.exit(0);
    } catch (err) {
        console.error("Error creating admin user:", err);
        process.exit(1);
    }
}

createAdmin();
