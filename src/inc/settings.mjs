import cfg from "./config.mjs";
import db from "./sql.mjs";
import lib from "./lib.mjs";

let manual_approval = false;
let min_tags = 0;
let registration_open = false;
let trusted_uploads = 0;
let bypass_duplicate_check = false;
let protect_files = false;
let private_messages = true;
let dm_attachments = true;
let dm_unencrypted = false;
let default_layout = 'modern';
let enable_pdf = false;
let enable_cleanup = false;
let cleanup_start_date = '';
let cleanup_end_date = '';
let cleanup_include_engaged = false;
export const getShitpostMode = () => !!cfg.websrv.shitpost_mode;
export const setShitpostMode = (val) => {}; // No-op, strictly config-based

export const getEnableExpiringUploads = () => {
    if (cfg.enable_expiring_uploads === false || cfg.websrv?.enable_expiring_uploads === false) return false;
    return true;
};

export const getEnableItemSlugs = () => {
    if (cfg.enable_item_slugs === false || cfg.websrv?.enable_item_slugs === false) return false;
    return true;
};

export const getEnableAnonymousAccess = () => {
    if (cfg.enable_anonymous_access === false || cfg.anonymous_access === false || cfg.websrv?.enable_anonymous_access === false || cfg.websrv?.anonymous_access === false) return false;
    return true;
};

export const DEFAULT_ANON_PERMISSIONS = Object.freeze({
    upload: false,
    comment: true,
    comment_attachments: false,
    comment_vote: true,
    poll_vote: true,
    tag: true,
    tag_vote: true,
    favorite: true,
    rate_item: false,
    filter: true,
    exclude_tags: true,
    chan: false, // 4chan viewer & rehost ("4chan mode")
    anonymize_users: false,
    allowed_modes: ['sfw', 'nsfw', 'untagged', 'all', 'nsfl'],
    allowed_mimes: ['image', 'video', 'audio', 'flash', 'pdf']
});

export const getAnonPermissions = () => {
    const fromConfig = cfg.anonymous_permissions || cfg.websrv?.anonymous_permissions || {};
    return {
        ...DEFAULT_ANON_PERMISSIONS,
        ...fromConfig
    };
};

export const getAnonAnonymize = () => {
    const perms = getAnonPermissions();
    if (typeof perms.anonymize_users === 'boolean') return perms.anonymize_users;
    if (typeof perms.anon_anonymize === 'boolean') return perms.anon_anonymize;
    if (cfg.main && typeof cfg.main.anon_anonymize === 'boolean') return cfg.main.anon_anonymize;
    if (cfg.main && typeof cfg.main.anonymous_anonymize === 'boolean') return cfg.main.anonymous_anonymize;
    if (typeof cfg.anon_anonymize === 'boolean') return cfg.anon_anonymize;
    if (typeof cfg.anonymous_anonymize === 'boolean') return cfg.anonymous_anonymize;
    return false;
};

export const isAnonymizeSession = (session) => {
    if (!session || typeof session !== 'object' || !session.user) {
        return !!(cfg.main?.guest_anonymize ?? cfg.guest_anonymize);
    }
    if (session.is_anon || session.user === 'anonymous' || (typeof session.user === 'string' && session.user.startsWith('anon_'))) {
        return getAnonAnonymize();
    }
    return false;
};

export const canAnonDo = (action) => {
    if (!getEnableAnonymousAccess()) return false;
    const perms = getAnonPermissions();
    if (action === 'exclude_tags' || action === 'exclude_tag' || action === 'tag_exclude') {
        if (perms.exclude_tags !== undefined) return !!perms.exclude_tags;
        if (perms.exclude_tag !== undefined) return !!perms.exclude_tag;
        if (perms.tag_exclude !== undefined) return !!perms.tag_exclude;
        return perms.filter !== undefined ? !!perms.filter : true;
    }
    return perms[action] !== undefined ? !!perms[action] : !!DEFAULT_ANON_PERMISSIONS[action];
};

export const getAnonAllowedModes = () => {
    const perms = getAnonPermissions();
    return Array.isArray(perms.allowed_modes) ? perms.allowed_modes.map(m => String(m).toLowerCase()) : DEFAULT_ANON_PERMISSIONS.allowed_modes;
};

export const getAnonAllowedMimes = () => {
    const perms = getAnonPermissions();
    return Array.isArray(perms.allowed_mimes) ? perms.allowed_mimes.map(m => String(m).toLowerCase()) : DEFAULT_ANON_PERMISSIONS.allowed_mimes;
};

export const canAnonMode = (mode) => {
    if (!canAnonDo('filter')) return false;
    const allowed = getAnonAllowedModes();
    const modeNames = ['sfw', 'nsfw', 'untagged', 'all', 'nsfl'];
    const name = typeof mode === 'number' ? modeNames[mode] : String(mode).toLowerCase();
    return allowed.includes(name);
};

export const canAnonMime = (mime) => {
    if (!canAnonDo('filter')) return false;
    const allowed = getAnonAllowedMimes();
    return allowed.includes(String(mime).toLowerCase());
};

export const isAnonSession = (session) => {
    if (!session) return true;
    if (session === true) return false;
    if (typeof session !== 'object' || !session.user) return true;
    return !!(session.is_anon || session.user === 'anonymous' || (typeof session.user === 'string' && session.user.startsWith('anon_')));
};

// Onara viewer is a per-user setting (cookie f0ck_onara, legacy cookie onara, or session value).
// config `onara` is only the default for users without a stored preference (true = on, false = off);
// users can always turn it on or off themselves. `forceOn` covers explicit requests like ?onara=1.
export const isOnaraEnabledFor = (req, forceOn = false) => {
    const c = cfg.onara !== undefined ? cfg.onara : cfg.websrv?.onara;
    if (forceOn) return true;
    const ck = req?.cookies || {};
    const raw = ck.f0ck_onara !== undefined ? ck.f0ck_onara : ck.onara;
    if (raw !== undefined) return raw === '1' || raw === 'true';
    if (req?.session && req.session.onara !== undefined && req.session.onara !== null) return !!req.session.onara;
    return c === true;
};

// The name items.username holds for this session's uploads. Anonymous sessions have
// user = 'anonymous' (shared by all anon users); their real account is the shadow login (anon_xxxx).
export const getSessionOwnerName = (session) => {
    if (!session || typeof session !== 'object') return null;
    if (session.is_anon) return session.anon_login || session.login || null;
    return session.user || null;
};

// 4chan viewer & rehost access: admins, members of the '4chan' group, and anonymous
// users when anonymous_permissions.chan is enabled
export const canUseChan = (session) => {
    if (!session || typeof session !== 'object') return false;
    if (session.admin) return true;
    if (Array.isArray(session.groups) && session.groups.includes('4chan')) return true;
    return !!(session.is_anon && canAnonDo('chan'));
};

export const checkAnonPermission = (session, action) => {
    if (!isAnonSession(session)) return true;
    return canAnonDo(action);
};

export const ensureAllItemsHaveSlugs = async () => {
    try {
        const rows = await db`SELECT id FROM items WHERE slug IS NULL OR slug = ''`;
        if (!rows || rows.length === 0) return;
        console.log(`[SLUG_BACKFILL] Found ${rows.length} item(s) missing slugs. Backfilling...`);
        for (const row of rows) {
            const newSlug = lib.generateSlug(11);
            await db`UPDATE items SET slug = ${newSlug} WHERE id = ${row.id} AND (slug IS NULL OR slug = '')`;
        }
        console.log(`[SLUG_BACKFILL] Successfully backfilled ${rows.length} item slug(s).`);
    } catch (err) {
        console.error('[SLUG_BACKFILL] Error during slug backfill:', err.message);
    }
};

export const ensureAllAlbumItemsHaveSlugs = async () => {
    try {
        const rows = await db`SELECT id FROM album_items WHERE slug IS NULL OR slug = ''`;
        if (!rows || rows.length === 0) return;
        console.log(`[ALBUM_SLUG_BACKFILL] Found ${rows.length} album item(s) missing slugs. Backfilling...`);
        for (const row of rows) {
            const newSlug = lib.generateSlug(11);
            await db`UPDATE album_items SET slug = ${newSlug} WHERE id = ${row.id} AND (slug IS NULL OR slug = '')`;
        }
        console.log(`[ALBUM_SLUG_BACKFILL] Successfully backfilled ${rows.length} album item slug(s).`);
    } catch (err) {
        console.error('[ALBUM_SLUG_BACKFILL] Error during album item slug backfill:', err.message);
    }
};



export const getEnableCleanup = () => {
    if (cfg.websrv.enable_cleanup === false) return false;
    return enable_cleanup;
};
export const setEnableCleanup = (val) => enable_cleanup = !!val;

export const getCleanupStartDate = () => cleanup_start_date;
export const setCleanupStartDate = (val) => cleanup_start_date = val || '';

export const getCleanupEndDate = () => cleanup_end_date;
export const setCleanupEndDate = (val) => cleanup_end_date = val || '';

export const getCleanupIncludeEngaged = () => cleanup_include_engaged;
export const setCleanupIncludeEngaged = (val) => cleanup_include_engaged = !!val;

export const getEnablePdf = () => enable_pdf;
export const setEnablePdf = (val) => enable_pdf = !!val;

export const getManualApproval = () => manual_approval;
export const setManualApproval = (val) => manual_approval = !!val;

export const getMinTags = () => min_tags;
export const setMinTags = (val) => {
    const parsed = parseInt(val);
    min_tags = isNaN(parsed) ? 0 : Math.max(0, parsed);
};

export const getRegistrationOpen = () => {
    if (cfg.websrv.open_registration_web_toggle === false) {
        return !!cfg.websrv.open_registration;
    }
    return registration_open;
};
export const setRegistrationOpen = (val) => registration_open = !!val;

// When false (default): open_registration=true means anyone can register with just username+password, activated immediately.
// When true: even in open registration, a valid email OR invite token is required.
export const getRegistrationRequireMailAndorToken = () => !!cfg.websrv.open_registration_require_mail_andor_token;
export const setRegistrationRequireMailAndorToken = (val) => {}; // No-op, strictly config-based

export const getTrustedUploads = () => trusted_uploads;
export const setTrustedUploads = (val) => trusted_uploads = Math.max(0, parseInt(val) ?? 3);

export const getBypassDuplicateCheck = () => bypass_duplicate_check;
export const setBypassDuplicateCheck = (val) => bypass_duplicate_check = !!val;

export const getProtectFiles = () => protect_files;
export const setProtectFiles = (val) => protect_files = !!val;

export const getPrivateMessages = () => private_messages;
export const setPrivateMessages = (val) => private_messages = !!val;

export const getDmAttachments = () => dm_attachments;
export const setDmAttachments = (val) => dm_attachments = !!val;

export const getDmUnencrypted = () => dm_unencrypted;
export const setDmUnencrypted = (val) => dm_unencrypted = !!val;

export const getDmAttachmentExpiryDays = () => {
    const v = parseInt(cfg.websrv.dm_attachment_expiry_days);
    return (Number.isFinite(v) && v > 0) ? v : 90;
};

export const getDefaultLayout = () => default_layout;
export const setDefaultLayout = (val) => default_layout = (val === 'legacy' ? 'legacy' : 'modern');

export const getLogUserIps = () => !!cfg.websrv.log_user_ips;
export const setLogUserIps = (val) => {}; // No-op, strictly config-based

export const getHashUserIps = () => !!cfg.websrv.hash_user_ips;
// Device (hardware) fingerprinting of anonymous users for ban enforcement. Off unless explicitly enabled.
export const getHwFingerprintEnabled = () => cfg.websrv.anon_hw_fingerprint === true;
export const setHashUserIps = (val) => {}; // No-op, strictly config-based

export const getAllowCommentDeletion = () => !!cfg.websrv.allow_comment_deletion;
export const setAllowCommentDeletion = (val) => {}; // No-op, strictly config-based

// Live-editable NSFP tag ID list — seeded from config.yaml, can be overridden by DB setting
let nsfp_ids = Array.isArray(cfg.nsfp) ? [...cfg.nsfp.map(Number).filter(n => !isNaN(n))] : [];

export const getNsfpIds = () => nsfp_ids;
export const setNsfpIds = (ids) => {
    nsfp_ids = Array.isArray(ids) ? ids.map(Number).filter(n => !isNaN(n) && n > 0) : [];
    // Also sync to cfg.nsfp so all code reading cfg.nsfp directly still works
    cfg.nsfp = [...nsfp_ids];
};

// Brand image URL — stored in site_settings DB, not config.yaml
// Falls back to cfg.websrv.custom_brand_image (array or string) on first boot
let brand_image_url = (() => {
    const raw = cfg.websrv?.custom_brand_image;
    return Array.isArray(raw) ? (raw[0] || '') : (raw || '');
})();

export const getBrandImageUrl = () => brand_image_url;
export const setBrandImageUrl = (val) => { brand_image_url = val || ''; };
