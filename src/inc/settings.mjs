import cfg from "./config.mjs";

let manual_approval = true;
let min_tags = 3;
let registration_open = false;
let trusted_uploads = 0;
let bypass_duplicate_check = false;
let protect_files = false;
let private_messages = true;
let default_layout = 'modern';

export const getManualApproval = () => manual_approval;
export const setManualApproval = (val) => manual_approval = !!val;

export const getMinTags = () => min_tags;
export const setMinTags = (val) => min_tags = parseInt(val) || 3;

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

export const getDefaultLayout = () => default_layout;
export const setDefaultLayout = (val) => default_layout = (val === 'legacy' ? 'legacy' : 'modern');
