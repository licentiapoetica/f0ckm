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

const isDocker = process.env.DB_HOST === 'f0ckm-db' || config.sql.host === 'f0ckm-db' || process.env.CONTAINER === 'true';
if (process.env.NODE_ENV === 'production' || isDocker) {
    config.main.development = false;
}

if (config.main.development) {
    if (!process.env.DB_HOST && (config.sql.host === 'f0ckm-db' || !config.sql.host)) {
        config.sql.host = 'localhost';
    }
    if (!process.env.DB_PORT && config.sql.port === 5432) {
        config.sql.port = 5454;
    }
    if (!process.env.STORAGE_DIR) {
        process.env.STORAGE_DIR = 'f0ckm-data';
    }
}

// Set timezone from config if not already set via environment variable
if (!process.env.TZ && config.main.timezone) {
    process.env.TZ = config.main.timezone;
}

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const storage = process.env.STORAGE_DIR;

const resolvePath = (defaultRel) => {
    const local = path.resolve(path.join(base, defaultRel));
    let target = local;
    if (storage) {
        const absStorage = path.resolve(storage);
        if (defaultRel.startsWith('public/')) {
            const sub = defaultRel.replace('public/', '');
            if (sub === 's/emojis' || sub === 's/koepfe' || sub === 's/fonts') {
                const storagePath = path.join(absStorage, sub.split('/').pop());
                if (fs.existsSync(storagePath)) target = path.resolve(storagePath);
                else target = local;
            } else {
                target = path.resolve(path.join(absStorage, sub));
            }
        } else {
            target = path.resolve(path.join(absStorage, defaultRel));
        }
    }
    try {
        if (fs.existsSync(target)) {
            return fs.realpathSync(target);
        }
        const parent = path.dirname(target);
        if (fs.existsSync(parent)) {
            return path.join(fs.realpathSync(parent), path.basename(target));
        }
    } catch (_) {}
    return target;
};

const resolveImportPath = () => {
    const p = storage ? path.resolve(path.join(path.resolve(storage), 'import')) : path.resolve(path.join(base, 'f0ckm-data/import'));
    try {
        if (fs.existsSync(p)) return fs.realpathSync(p);
        const parent = path.dirname(p);
        if (fs.existsSync(parent)) return path.join(fs.realpathSync(parent), path.basename(p));
    } catch (_) {}
    return p;
};

config.paths = {
    a: resolvePath('public/a'),
    b: resolvePath('public/b'),
    c: resolvePath('public/c'),
    t: resolvePath('public/t'),
    ca: resolvePath('public/ca'),
    s: (() => {
        const sPath = path.join(base, 'public/s');
        try { if (fs.existsSync(sPath)) return fs.realpathSync(sPath); } catch (_) {}
        return sPath;
    })(),
    emojis: resolvePath('public/s/emojis'),
    koepfe: resolvePath('public/s/koepfe'),
    fonts: resolvePath('public/s/fonts'),
    memes: resolvePath('public/memes'),
    e: resolvePath('public/e'),
    cu: resolvePath('public/cu'),
    pending: resolvePath('pending'),
    deleted: resolvePath('deleted'),
    logs: resolvePath('logs'),
    tmp: resolvePath('tmp'),
    import: resolveImportPath()
};

const configFilePath = path.resolve(base, "config.json");
let watchDebounceTimer = null;
try {
    if (fs.existsSync(configFilePath)) {
        const watcher = fs.watch(configFilePath, (eventType) => {
            if (eventType === 'change' || eventType === 'rename') {
                if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
                watchDebounceTimer = setTimeout(() => {
                    try {
                        const raw = fs.readFileSync(configFilePath, 'utf8');
                        const updated = JSON.parse(raw);
                        Object.assign(config, updated);
                        if (config.sql) {
                            config.sql.host = process.env.DB_HOST || process.env.POSTGRES_HOST || process.env.PGHOST || config.sql.host;
                            config.sql.port = parseInt(process.env.DB_PORT || process.env.POSTGRES_PORT || process.env.PGPORT || config.sql.port, 10);
                            config.sql.user = process.env.DB_USER || process.env.POSTGRES_USER || process.env.PGUSER || config.sql.user;
                            config.sql.password = process.env.DB_PASS || process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || config.sql.password;
                            config.sql.database = process.env.DB_NAME || process.env.POSTGRES_DB || process.env.PGDATABASE || config.sql.database;
                        }
                        console.log('[CONFIG] config.json reloaded dynamically');
                    } catch (_) {}
                }, 100);
                if (watchDebounceTimer.unref) watchDebounceTimer.unref();
            }
        });
        if (watcher.unref) watcher.unref();
    }
} catch (_) {}

export default config;
