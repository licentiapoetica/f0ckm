import db from "../src/inc/sql.mjs";
import lib from "../src/inc/lib.mjs";
import cfg from "../src/inc/config.mjs";
import { getDefaultLayout } from "../src/inc/settings.mjs";

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

    try {
        const newUser = await db`
            insert into "user" ("login", "password", "user", "created_at", "admin", "is_moderator", "activated")
            values (${username.toLowerCase()}, ${hash}, ${username}, to_timestamp(${ts}), true, true, true)
            returning id
        `;
        const userId = newUser[0].id;

        await db`
            insert into user_options (user_id, mode, theme, fullscreen, avatar, avatar_file, use_new_layout, disable_autoplay, disable_swiping)
            values (${userId}, 3, 'amoled', 0, null, 'default.png', ${getDefaultLayout() === 'modern'}, false, false)
        `;

        console.log(`--- Admin User ${username} Created Successfully ---`);
        process.exit(0);
    } catch (err) {
        console.error("Error creating admin user:", err);
        process.exit(1);
    }
}

createAdmin();
