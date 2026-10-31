import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import YAML from "yaml";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
export const configFilePath = path.resolve(base, "config.yaml");

const readConfigFile = () => {
    let raw;
    try {
        raw = fs.readFileSync(configFilePath, "utf8");
    } catch (err) {
        const hint = fs.existsSync(path.resolve(base, "config.json"))
            ? "An old config.json was found: convert it once with `npm run config:migrate`."
            : "Create it from the example: `cp config_example.yaml config.yaml`.";
        throw new Error(`[CONFIG] Cannot read ${configFilePath} (${err.code || err.message}). ${hint}`);
    }
    const parsed = YAML.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error(`[CONFIG] ${configFilePath} is empty or not a YAML mapping`);
    return parsed;
};

// Values that come from the environment, not the file. Applied at startup and after every reload.
const applyOverrides = (cfg) => {
    cfg.sql = cfg.sql || {};
    cfg.main = cfg.main || {};
    cfg.sql.host = process.env.DB_HOST || process.env.POSTGRES_HOST || process.env.PGHOST || cfg.sql.host;
    cfg.sql.port = parseInt(process.env.DB_PORT || process.env.POSTGRES_PORT || process.env.PGPORT || cfg.sql.port, 10);
    cfg.sql.user = process.env.DB_USER || process.env.POSTGRES_USER || process.env.PGUSER || cfg.sql.user;
    cfg.sql.password = process.env.DB_PASS || process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || cfg.sql.password;
    cfg.sql.database = process.env.DB_NAME || process.env.POSTGRES_DB || process.env.PGDATABASE || cfg.sql.database;

    const isDocker = process.env.DB_HOST === 'f0ckm-db' || cfg.sql.host === 'f0ckm-db' || process.env.CONTAINER === 'true';
    if (process.env.NODE_ENV === 'production' || isDocker) {
        cfg.main.development = false;
    }
    if (cfg.main.development) {
        if (!process.env.DB_HOST && (cfg.sql.host === 'f0ckm-db' || !cfg.sql.host)) cfg.sql.host = 'localhost';
        if (!process.env.DB_PORT && cfg.sql.port === 5432) cfg.sql.port = 5454;
    }
};

let config = readConfigFile();
applyOverrides(config);

if (config.main.development && !process.env.STORAGE_DIR) {
    process.env.STORAGE_DIR = 'f0ckm-data';
}

// Set timezone from config if not already set via environment variable
if (!process.env.TZ && config.main.timezone) {
    process.env.TZ = config.main.timezone;
}

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

// Re-read config.yaml into the live config object (top-level sections are replaced; settings read once
// at boot still need a restart). Throws when the file can't be read or parsed; the running config is kept then.
export const reloadConfig = () => {
    const updated = readConfigFile();
    const paths = config.paths;
    Object.assign(config, updated);
    config.paths = paths;
    applyOverrides(config);
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Bring a YAML document in line with a plain object, touching only what differs so comments and order survive
const syncNode = (doc, keyPath, value) => {
    const node = keyPath.length ? doc.getIn(keyPath, true) : doc.contents;
    if (isPlainObject(value) && YAML.isMap(node)) {
        for (const item of [...node.items]) {
            const key = YAML.isScalar(item.key) ? item.key.value : item.key;
            if (!Object.prototype.hasOwnProperty.call(value, key)) node.delete(key);
        }
        for (const [key, val] of Object.entries(value)) syncNode(doc, [...keyPath, key], val);
        return;
    }
    const current = YAML.isNode(node) ? node.toJSON() : node;
    if (JSON.stringify(current) !== JSON.stringify(value)) {
        if (keyPath.length) doc.setIn(keyPath, value);
        else doc.contents = doc.createNode(value);
    }
};

// Save a full config object to config.yaml, keeping the file's comments and layout
export const writeConfigFile = (newConfig) => {
    if (!isPlainObject(newConfig)) throw new Error('Invalid configuration payload');
    const doc = YAML.parseDocument(fs.readFileSync(configFilePath, 'utf8'));
    if (doc.errors.length) throw new Error(`config.yaml has syntax errors: ${doc.errors[0].message}`);
    syncNode(doc, [], newConfig);
    fs.writeFileSync(configFilePath, String(doc), 'utf8');
};

// Live reload: edits to config.yaml apply without a restart. A file that fails to parse is ignored.
let watchDebounceTimer = null;
try {
    // Watch the directory, not the file: editors that save by rename would end a file watch
    const watcher = fs.watch(base, (_event, filename) => {
        if (filename !== path.basename(configFilePath)) return;
        if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
        watchDebounceTimer = setTimeout(() => {
            try {
                reloadConfig();
                console.log('[CONFIG] config.yaml reloaded');
            } catch (err) {
                console.error(`[CONFIG] config.yaml reload failed, keeping the running config: ${err.message}`);
            }
        }, 100);
        if (watchDebounceTimer.unref) watchDebounceTimer.unref();
    });
    if (watcher.unref) watcher.unref();
} catch (_) {}

export default config;
