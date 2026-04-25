import _config from "../../config.json" with { type: "json" };
import path from "path";
import fs from "fs";

let config = JSON.parse(JSON.stringify(_config));

// Environment variable overrides for database connection
if (process.env.DB_HOST) config.sql.host = process.env.DB_HOST;
if (process.env.DB_USER) config.sql.user = process.env.DB_USER;
if (process.env.DB_PASS) config.sql.password = process.env.DB_PASS;
if (process.env.DB_NAME) config.sql.database = process.env.DB_NAME;

if (process.env.NODE_ENV === 'production') {
    config.main.development = false;
}

const base = path.resolve();
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
