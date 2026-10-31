import crypto from "crypto";
import db from "../src/inc/sql.mjs";
import lib from "../src/inc/lib.mjs";

// Manage upload-only API keys for chat uploads (POST /api/chat/upload).
// The plain key is shown once on creation; only its sha256 is stored.

const [cmd, arg, maxMb] = process.argv.slice(2);

const usage = () => {
    console.error("Usage:");
    console.error("  node scripts/chat-upload-key.mjs create <name> [max_mb]");
    console.error("  node scripts/chat-upload-key.mjs list");
    console.error("  node scripts/chat-upload-key.mjs revoke <id>");
    process.exit(1);
};

async function run() {
    if (cmd === "create") {
        if (!arg) usage();
        const key = "cu_" + crypto.randomBytes(24).toString("base64url");
        const maxBytes = maxMb ? parseInt(maxMb, 10) * 1024 * 1024 : null;
        const [row] = await db`
            INSERT INTO upload_api_keys ${db({ name: arg, key_hash: lib.sha256(key), max_bytes: maxBytes })}
            RETURNING id
        `;
        console.log(`Created key #${row.id} "${arg}"${maxBytes ? ` (max ${maxMb} MB)` : ""}`);
        console.log(`Key (shown once): ${key}`);
    } else if (cmd === "list") {
        const rows = await db`
            SELECT k.id, k.name, k.max_bytes, k.revoked, k.created_at, k.last_used_at,
                   count(c.id)::int AS files, coalesce(sum(c.size_bytes), 0)::bigint AS bytes
            FROM upload_api_keys k
            LEFT JOIN chat_uploads c ON c.key_id = k.id
            GROUP BY k.id ORDER BY k.id
        `;
        console.table(rows.map(r => ({
            id: r.id,
            name: r.name,
            revoked: r.revoked,
            max_mb: r.max_bytes ? Number(r.max_bytes) / 1048576 : "-",
            files: r.files,
            used_mb: (Number(r.bytes) / 1048576).toFixed(1),
            last_used: r.last_used_at ? r.last_used_at.toISOString() : "-"
        })));
    } else if (cmd === "revoke") {
        const id = parseInt(arg, 10);
        if (!id) usage();
        const rows = await db`UPDATE upload_api_keys SET revoked = true WHERE id = ${id} RETURNING id`;
        console.log(rows.length ? `Revoked key #${id}` : `No key #${id}`);
    } else {
        usage();
    }
}

run().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.end());
