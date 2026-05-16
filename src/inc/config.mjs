import _config from "../../config.json" with { type: "json" };
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

let config = JSON.parse(JSON.stringify(_config));

// Environment variable overrides for database connection
config.sql.host = process.env.DB_HOST || process.env.POSTGRES_HOST || process.env.PGHOST || config.sql.host;
config.sql.port = parseInt(process.env.DB_PORT || process.env.POSTGRES_PORT || process.env.PGPORT || config.sql.port, 10);
config.sql.user = process.env.DB_USER || process.env.POSTGRES_USER || process.env.PGUSER || config.sql.user;
config.sql.password = process.env.DB_PASS || process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || config.sql.password;
config.sql.database = process.env.DB_NAME || process.env.POSTGRES_DB || process.env.PGDATABASE || config.sql.database;

if (process.env.NODE_ENV === 'production') {
    config.main.development = false;
}

// Set timezone from config if not already set via environment variable
if (!process.env.TZ && config.main.timezone) {
    process.env.TZ = config.main.timezone;
}

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const storage = process.env.STORAGE_DIR;

const resolvePath = (defaultRel) => {
    const local = path.resolve(path.join(base, defaultRel));
    if (storage) {
        const absStorage = path.resolve(storage);
        if (defaultRel.startsWith('public/')) {
            const sub = defaultRel.replace('public/', '');
            if (sub === 's/emojis' || sub === 's/koepfe') {
                const storagePath = path.join(absStorage, sub.split('/').pop());
                if (fs.existsSync(storagePath)) return path.resolve(storagePath);
                return local;
            }
            return path.resolve(path.join(absStorage, sub));
        }
        return path.resolve(path.join(absStorage, defaultRel));
    }
    return local;
};

config.paths = {
    a: resolvePath('public/a'),
    b: resolvePath('public/b'),
    c: resolvePath('public/c'),
    t: resolvePath('public/t'),
    ca: resolvePath('public/ca'),
    s: path.join(base, 'public/s'),
    emojis: resolvePath('public/s/emojis'),
    koepfe: resolvePath('public/s/koepfe'),
    memes: resolvePath('public/memes'),
    pending: resolvePath('pending'),
    deleted: resolvePath('deleted'),
    logs: resolvePath('logs'),
    tmp: resolvePath('tmp')
};

export default config;
