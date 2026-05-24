import cfg from "./config.mjs";

let manual_approval = true;
let min_tags = 3;
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
export const getShitpostMode = () => !!cfg.websrv.shitpost_mode;
export const setShitpostMode = (val) => {}; // No-op, strictly config-based

export const getEnableCleanup = () => {
    if (cfg.websrv.enable_cleanup === false) return false;
    return enable_cleanup;
};
export const setEnableCleanup = (val) => enable_cleanup = !!val;

export const getCleanupStartDate = () => cleanup_start_date;
export const setCleanupStartDate = (val) => cleanup_start_date = val || '';

export const getCleanupEndDate = () => cleanup_end_date;
export const setCleanupEndDate = (val) => cleanup_end_date = val || '';

export const getEnablePdf = () => enable_pdf;
export const setEnablePdf = (val) => enable_pdf = !!val;

export const getManualApproval = () => manual_approval;
export const setManualApproval = (val) => manual_approval = !!val;

export const getMinTags = () => min_tags;
export const setMinTags = (val) => {
    const parsed = parseInt(val);
    min_tags = isNaN(parsed) ? 3 : Math.max(0, parsed);
};

export const getRegistrationOpen = () => {
    if (cfg.websrv.open_registration_web_toggle === false) {
        return !!cfg.websrv.open_registration;
    }
    return registration_open;
};
export const setRegistrationOpen = (val) => registration_open = !!val;

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
export const setHashUserIps = (val) => {}; // No-op, strictly config-based

export const getAllowCommentDeletion = () => !!cfg.websrv.allow_comment_deletion;
export const setAllowCommentDeletion = (val) => {}; // No-op, strictly config-based

