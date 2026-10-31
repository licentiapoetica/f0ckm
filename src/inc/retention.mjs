import db from "./sql.mjs";
import cfg from "./config.mjs";
import { getHwFingerprintEnabled } from "./settings.mjs";

/**
 * retention.mjs — automatic deletion of personal data after a configurable period.
 *
 * All periods are in days, configured under websrv.* (0 = keep forever):
 *   retention_ip_days              stored IPs: user_ips rows are deleted; IP columns on sessions, anon identities,
 *                                  uploads, comments, reports and ToS acceptances are set to NULL
 *   retention_activity_log_days    anon_activity_log rows (action, IP, fingerprints) are deleted
 *   retention_login_attempts_days  login_attempts rows (hashed IP + attempted username) are deleted
 *   retention_sessions_days        sessions unused for this long are deleted (logs that device out)
 *   retention_fingerprint_days     hardware fingerprint is cleared from anonymous identities inactive this long
 *
 * Unless websrv.anon_hw_fingerprint is true, every stored device fingerprint (identities and activity log) is
 * cleared on each run, regardless of age.
 *
 * Active bans (banned_ips / banned_fingerprints / banned_hardware_fingerprints) are not touched: they are kept
 * until they expire or are lifted.
 */

const DEFAULTS = {
  ip: 30,
  activity_log: 90,
  login_attempts: 30,
  sessions: 365,
  fingerprint: 365
};

const days = (key) => {
  const v = cfg.websrv?.[`retention_${key}_days`];
  if (v === undefined || v === null || v === '') return DEFAULTS[key];
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const getRetention = () => ({
  ip: days('ip'),
  activity_log: days('activity_log'),
  login_attempts: days('login_attempts'),
  sessions: days('sessions'),
  fingerprint: days('fingerprint')
});

const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly

export const runRetention = async () => {
  const r = getRetention();
  const nowSecs = ~~(Date.now() / 1e3);
  const before = (d) => new Date(Date.now() - d * 86400e3);
  const counts = {};
  const step = async (name, fn) => {
    try {
      const res = await fn();
      if (res?.count) counts[name] = res.count;
    } catch (e) {
      console.error(`[RETENTION] ${name} failed:`, e.message);
    }
  };

  if (r.ip) {
    const cutoff = before(r.ip);
    const cutoffSecs = nowSecs - r.ip * 86400;
    await step('user_ips', () => db`delete from user_ips where last_seen < ${cutoff}`);
    await step('sessions.ip', () => db`update user_sessions set ip = null where ip is not null and last_used < ${cutoffSecs}`);
    await step('anon.created_ip', () => db`update anon_identities set created_ip = null where created_ip is not null and created_at < ${cutoff}`);
    await step('anon.last_ip', () => db`update anon_identities set last_ip = null where last_ip is not null and last_seen < ${cutoff}`);
    await step('items.uploader_ip', () => db`update items set uploader_ip = null where uploader_ip is not null and stamp < ${cutoffSecs}`);
    await step('comments.ip', () => db`update comments set ip = null where ip is not null and created_at < ${cutoff}`);
    await step('reports.reporter_ip', () => db`update reports set reporter_ip = null where reporter_ip is not null and created_at < ${cutoff}`);
    await step('tos.accepted_ip', () => db`update user_tos_acceptance set accepted_ip = null where accepted_ip is not null and accepted_at < ${cutoff}`);
  }

  if (r.activity_log) {
    await step('anon_activity_log', () => db`delete from anon_activity_log where created_at < ${before(r.activity_log)}`);
  }

  if (r.login_attempts) {
    await step('login_attempts', () => db`delete from login_attempts where attempted_at < ${before(r.login_attempts)}`);
  }

  if (r.sessions) {
    await step('user_sessions', () => db`delete from user_sessions where last_used < ${nowSecs - r.sessions * 86400}`);
  }

  if (!getHwFingerprintEnabled()) {
    // Fingerprinting switched off: don't keep any fingerprints collected while it was on
    await step('anon.hw_fingerprint', () => db`update anon_identities set hw_fingerprint = null where hw_fingerprint is not null`);
    await step('activity.hw_fingerprint', () => db`update anon_activity_log set hw_fingerprint = null where hw_fingerprint is not null`);
  } else if (r.fingerprint) {
    await step('anon.hw_fingerprint', () => db`update anon_identities set hw_fingerprint = null where hw_fingerprint is not null and last_seen < ${before(r.fingerprint)}`);
  }

  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ');
  if (summary) console.log(`[RETENTION] Cleaned: ${summary}`);
};

export const startRetention = () => {
  const r = getRetention();
  const fmt = (d) => d ? `${d}d` : 'forever';
  console.log(`[BOOT] Data retention: IPs ${fmt(r.ip)}, activity log ${fmt(r.activity_log)}, login attempts ${fmt(r.login_attempts)}, sessions ${fmt(r.sessions)}, device fingerprints ${getHwFingerprintEnabled() ? fmt(r.fingerprint) : 'disabled (purged)'}`);
  setTimeout(runRetention, 30_000);
  setInterval(runRetention, RUN_INTERVAL_MS);
};
