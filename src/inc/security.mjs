import crypto from "crypto";
import db from "./sql.mjs";
import cfg from "./config.mjs";

const RATE_LIMIT_WINDOW_MINUTES = 600; // 10 hours
const MAX_ATTEMPTS = 5;

/**
 * IP hash secrets.
 *   current: IP_HASH_SECRET env var > main.ip_hash_secret > main.invite_secret (legacy fallback).
 *            Kept out of config.yaml / DB dumps when set via the environment, so a leaked dump can't be reversed.
 *   legacy:  secrets used before a rotation. Only used to *match* old hashes (bans), never to write new ones.
 *            main.ip_hash_legacy_secrets (array); the invite_secret is added automatically when a dedicated
 *            secret is set, so bans hashed with it keep working until they expire.
 */
const ipHashSecrets = (() => {
    const env = process.env.IP_HASH_SECRET || '';
    const dedicated = env || cfg.main.ip_hash_secret || '';
    const current = dedicated || cfg.main.invite_secret || '';
    const legacy = new Set([].concat(cfg.main.ip_hash_legacy_secrets || []).filter(Boolean));
    if (dedicated && cfg.main.invite_secret) legacy.add(cfg.main.invite_secret);
    legacy.delete(current);
    const source = env ? 'env IP_HASH_SECRET' : (cfg.main.ip_hash_secret ? 'config main.ip_hash_secret' : 'config main.invite_secret (shared, set IP_HASH_SECRET)');
    return { current, legacy: [...legacy], source };
})();

export const getIpHashSource = () => ipHashSecrets.source;

export default new class {
    /**
     * Anonymize IP address using Hmac-SHA256 with the current IP hash secret.
     * @param {string} ip 
     * @returns {string}
     */
    hashIP(ip, secret = ipHashSecrets.current) {
        if (!ip) return "unknown";
        if (!secret) {
            throw new Error('[FATAL] No IP hash secret configured. Set IP_HASH_SECRET (env) or main.ip_hash_secret. Refusing to use a predictable fallback salt.');
        }
        return crypto.createHmac("sha256", secret).update(ip).digest("hex");
    }

    /**
     * Hashes of an IP under the current and all legacy secrets (for matching data written before a rotation).
     * @param {string} ip
     * @returns {string[]}
     */
    hashIPCandidates(ip) {
        if (!ip) return [];
        return [ipHashSecrets.current, ...ipHashSecrets.legacy].filter(Boolean).map(sec => this.hashIP(ip, sec));
    }

    /**
     * Get real IP from request headers or socket.
     * @param {object} req 
     * @returns {string}
     */
    getRealIP(req) {
        let rawIp = req.headers['cf-connecting-ip'] ||
            req.headers['true-client-ip'] ||
            req.headers['x-client-ip'] ||
            req.headers['x-real-ip'] ||
            req.headers['x-forwarded-for'] ||
            req.socket?.remoteAddress;

        if (!rawIp) return "unknown";

        // If the header contains a comma-separated proxy chain (e.g. "IP1, IP2"), extract the client IP (first element)
        let ip = String(rawIp).split(',')[0].trim();

        // Handle IPv6 loopback and mapped IPv4
        if (ip === "::1") ip = "127.0.0.1";
        if (ip && ip.startsWith("::ffff:")) ip = ip.substring(7);

        // Basic IPv6 normalization (ensure consistent case and representation if possible)
        if (ip && ip.includes(":")) ip = ip.toLowerCase();

        if (cfg.main.development && ip === "127.0.0.1" && req.headers) {
            console.debug('[SECURITY] Local IP detected. Headers:', req.headers);
        }

        return ip;
    }

    /**
     * Record an attempt in the database.
     * @param {string} ip 
     * @param {string} username 
     * @param {string} type 'login' | 'register'
     * @param {boolean} success 
     */
    async recordAttempt(ip, username, type, success) {
        const ip_hash = this.hashIP(ip);
        
        await db`
            insert into login_attempts (ip_hash, username, type, success)
            values (${ip_hash}, ${username?.toLowerCase() || null}, ${type}, ${success})
        `.catch(err => console.error(`[SECURITY] Failed to record ${type} attempt:`, err));

        if (!success) {
            let windowMinutes = RATE_LIMIT_WINDOW_MINUTES;
            let maxAttempts = MAX_ATTEMPTS;
            let onlyFailures = true;

            if (type === 'password_reset_request') {
                windowMinutes = 1440;
                maxAttempts = 1;
                onlyFailures = false;
            } else if (type === 'password_reset_execution') {
                windowMinutes = 60;
                maxAttempts = 5;
                onlyFailures = false;
            }

            const windowStart = new Date(Date.now() - windowMinutes * 60000);

            const ipAttempts = await db`
                select count(*) as count
                from login_attempts
                where ip_hash = ${ip_hash}
                and type = ${type}
                ${onlyFailures ? db`and success = false` : db``}
                and attempted_at > ${windowStart}
            `.catch(() => [{ count: 0 }]);

            const count = +ipAttempts[0].count;
            const isBanned = count >= maxAttempts;

            console.warn(`[SECURITY] Failed ${type} attempt: user=${username}, ip_hash=${ip_hash}, ip_banned=${isBanned} (${count}/${maxAttempts})`);
        } else if (cfg.main.development) {
            console.log(`[SECURITY] Recording ${type} attempt: user=${username}, success=${success}, ip_hash=${ip_hash}`);
        }
    }

    /**
     * Clear failed attempts for a given IP and/or username.
     * @param {string} ip 
     * @param {string} username 
     */
    async clearAttempts(ip, username) {
        const ip_hash = this.hashIP(ip);
        if (cfg.main.development) console.log(`[SECURITY] Clearing attempts for user=${username}, ip_hash=${ip_hash}`);
        await db`
            delete from login_attempts
            where (ip_hash = ${ip_hash} OR username = ${username?.toLowerCase() || ''})
        `.catch(err => console.error(`[SECURITY] Failed to clear attempts:`, err));
    }

    async isRateLimited(ip, username, type) {
        const ip_hash = this.hashIP(ip);
        
        let windowMinutes = RATE_LIMIT_WINDOW_MINUTES;
        let maxAttempts = MAX_ATTEMPTS;
        let onlyFailures = true;

        if (type === 'password_reset_request') {
            windowMinutes = 1440; // 24 hours
            maxAttempts = 1;
            onlyFailures = false; // Count all attempts to prevent spam
        } else if (type === 'password_reset_execution') {
            windowMinutes = 60; // 1 hour
            maxAttempts = 5;
            onlyFailures = false; // Count all efforts
        }

        const windowStart = new Date(Date.now() - windowMinutes * 60000);

        if (cfg.main.development) console.log(`[SECURITY] Checking rate limit for ${type}: user=${username}, ip_hash=${ip_hash}`);

        // Check attempts by IP
        const ipAttempts = await db`
            select count(*) as count
            from login_attempts
            where ip_hash = ${ip_hash}
            and type = ${type}
            ${onlyFailures ? db`and success = false` : db``}
            and attempted_at > ${windowStart}
        `;

        const ipCount = +ipAttempts[0].count;
        if (ipCount >= maxAttempts) {
            console.warn(`[SECURITY] Rate limit hit for ${type}: ip_hash=${ip_hash}, attempts=${ipCount}/${maxAttempts}`);
            return true;
        }

        // Check attempts by username (if provided)
        if (username) {
            const userAttempts = await db`
                select count(*) as count
                from login_attempts
                where username = ${username.toLowerCase()}
                and type = ${type}
                ${onlyFailures ? db`and success = false` : db``}
                and attempted_at > ${windowStart}
            `;
            const userCount = +userAttempts[0].count;
            if (userCount >= maxAttempts) {
                console.warn(`[SECURITY] Rate limit hit for ${type}: user=${username}, attempts=${userCount}/${maxAttempts}`);
                return true;
            }
        }

        return false;
    }

    /**
     * Log user IP for historical tracking if enabled.
     * @param {number} userId 
     * @param {string} ip 
     */
    /**
     * The form in which an IP may be written to the database, following the config:
     * null when websrv.log_user_ips is off, HMAC-SHA256 when websrv.hash_user_ips is on, raw otherwise.
     * Every stored IP (sessions, activity, uploads, comments, reports) goes through here so /privacy stays true.
     */
    storableIP(ip) {
        if (!cfg.websrv.log_user_ips || !ip || ip === 'unknown') return null;
        return cfg.websrv.hash_user_ips ? this.hashIP(ip) : ip;
    }

    async logUserIP(userId, ip) {
        const finalIp = this.storableIP(ip);
        if (!userId || !finalIp) return;

        await db`
            insert into user_ips (user_id, ip)
            values (${userId}, ${finalIp})
            on conflict (user_id, ip) do update set last_seen = now()
        `.catch(err => console.error(`[SECURITY] Failed to log user IP:`, err));
    }

    /**
     * Check if an IP is banned in banned_ips.
     * Checks both raw IP and hashed IP.
     * @param {string} ip
     * @returns {Promise<{ id: number, ip_address: string, reason: string, expires: Date|null }|null>}
     */
    async isIpBanned(ip) {
        if (!ip || ip === "unknown") return null;
        if (cfg.main.development && ip === "127.0.0.1" && !cfg.test_ban_localhost) return null;
        try {
            const hashes = this.hashIPCandidates(ip);
            const rows = await db`
                select id, ip, ip_hash, reason, expires_at as expires
                from banned_ips
                where (ip = ${ip} or ip = any(${hashes}) or ip_hash = any(${hashes}) or ip_hash = ${ip})
                  and (expires_at is null or expires_at > now())
                limit 1
            `;
            return rows.length > 0 ? rows[0] : null;
        } catch (err) {
            console.error('[SECURITY] Error checking isIpBanned:', err);
            return null;
        }
    }

    /**
     * Check if an OpenSSH fingerprint is banned in banned_fingerprints.
     * @param {string} fingerprint
     * @returns {Promise<{ id: number, fingerprint: string, reason: string, expires: Date|null, banned_by: number|null }|null>}
     */
    async isFingerprintBanned(fingerprint) {
        if (!fingerprint) return null;
        try {
            const rows = await db`
                select id, fingerprint, reason, expires_at as expires, banned_by
                from banned_fingerprints
                where fingerprint = ${fingerprint}
                  and (expires_at is null or expires_at > now())
                limit 1
            `;
            return rows.length > 0 ? rows[0] : null;
        } catch (err) {
            console.error('[SECURITY] Error checking isFingerprintBanned:', err);
            return null;
        }
    }

    /**
     * Check if a hardware fingerprint is banned in banned_hardware_fingerprints.
     * @param {string} hwFingerprint
     * @returns {Promise<{ id: number, hw_fingerprint: string, reason: string, expires: Date|null, banned_by: number|null }|null>}
     */
    async isHardwareBanned(hwFingerprint) {
        if (!hwFingerprint) return null;
        try {
            const rows = await db`
                select id, hw_fingerprint, reason, expires_at as expires, banned_by
                from banned_hardware_fingerprints
                where hw_fingerprint = ${hwFingerprint}
                  and (expires_at is null or expires_at > now())
                limit 1
            `;
            return rows.length > 0 ? rows[0] : null;
        } catch (err) {
            console.error('[SECURITY] Error checking isHardwareBanned:', err);
            return null;
        }
    }

    /**
     * Comprehensive anonymous user ban:
     * - Marks the shadow user in "user" table as banned
     * - Records fingerprint in banned_fingerprints
     * - Records hardware fingerprint in banned_hardware_fingerprints
     * - Discovers all associated IPs (from anon_activity_log, user_ips, anon_identities, comments) and inserts into banned_ips
     * - Destroys active sessions
     */
    async banAnonymousUser({ userId = null, fingerprint = null, hwFingerprint = null, bannedBy = null, reason = 'Banned anonymous identity', expires = null, banIps = true, banHardware = true } = {}) {
        let targetFingerprint = fingerprint;
        let targetHwFingerprint = hwFingerprint;

        if (userId && !targetFingerprint) {
            const row = (await db`select fingerprint from anon_identities where user_id = ${userId} limit 1`)[0];
            if (row) targetFingerprint = row.fingerprint;
        }

        if (userId && !targetHwFingerprint) {
            const row = (await db`select hw_fingerprint from anon_identities where user_id = ${userId} and hw_fingerprint is not null limit 1`)[0];
            if (row) targetHwFingerprint = row.hw_fingerprint;
        }

        if (targetFingerprint && !userId) {
            const row = (await db`select user_id from anon_identities where fingerprint = ${targetFingerprint} limit 1`)[0];
            if (row) userId = row.user_id;
        }

        if (targetFingerprint && !targetHwFingerprint) {
            const row = (await db`select hw_fingerprint from anon_identities where fingerprint = ${targetFingerprint} and hw_fingerprint is not null limit 1`)[0];
            if (row) targetHwFingerprint = row.hw_fingerprint;
        }

        // 1. Ban the user account
        if (userId) {
            await db`
                update "user"
                set banned = true,
                    ban_reason = ${reason},
                    ban_expires = ${expires}
                where id = ${userId}
            `;
            await db`delete from "user_sessions" where user_id = ${userId}`;
        }

        // 2. Ban the fingerprint
        if (targetFingerprint) {
            await db`
                insert into banned_fingerprints (fingerprint, banned_by, reason, expires_at)
                values (${targetFingerprint}, ${bannedBy}, ${reason}, ${expires})
                on conflict (fingerprint) do update
                set reason = excluded.reason,
                    expires_at = excluded.expires_at,
                    banned_by = excluded.banned_by
            `;
        }

        // 3. Ban the hardware fingerprint
        const associatedHws = new Set();
        if (banHardware) {
            if (targetHwFingerprint) associatedHws.add(targetHwFingerprint);

            if (userId) {
                const actHws = await db`select distinct hw_fingerprint from anon_activity_log where user_id = ${userId} and hw_fingerprint is not null`;
                for (const r of actHws) if (r.hw_fingerprint) associatedHws.add(r.hw_fingerprint);

                const identHws = await db`select hw_fingerprint from anon_identities where user_id = ${userId} and hw_fingerprint is not null`;
                for (const r of identHws) if (r.hw_fingerprint) associatedHws.add(r.hw_fingerprint);
            }

            if (targetFingerprint) {
                const actHws = await db`select distinct hw_fingerprint from anon_activity_log where fingerprint = ${targetFingerprint} and hw_fingerprint is not null`;
                for (const r of actHws) if (r.hw_fingerprint) associatedHws.add(r.hw_fingerprint);
            }

            for (const hw of associatedHws) {
                if (!hw) continue;
                await db`
                    insert into banned_hardware_fingerprints (hw_fingerprint, banned_by, reason, expires_at)
                    values (${hw}, ${bannedBy}, ${reason}, ${expires})
                    on conflict (hw_fingerprint) do update
                    set reason = excluded.reason,
                        expires_at = excluded.expires_at,
                        banned_by = excluded.banned_by
                `.catch(err => console.error('[SECURITY] Error inserting banned hardware fingerprint:', err));
            }
        }

        // 4. Cascade to associated IPs
        const associatedIps = new Set();
        if (banIps) {
            if (userId) {
                const actIps = await db`select distinct ip from anon_activity_log where user_id = ${userId}`;
                for (const r of actIps) if (r.ip) associatedIps.add(r.ip);

                const uIps = await db`select distinct ip from user_ips where user_id = ${userId}`;
                for (const r of uIps) if (r.ip) associatedIps.add(r.ip);

                const cIps = await db`select distinct ip from comments where user_id = ${userId} and ip is not null`;
                for (const r of cIps) if (r.ip) associatedIps.add(r.ip);
            }

            if (targetFingerprint) {
                const actIps = await db`select distinct ip from anon_activity_log where fingerprint = ${targetFingerprint}`;
                for (const r of actIps) if (r.ip) associatedIps.add(r.ip);

                const identIps = await db`select created_ip, last_ip from anon_identities where fingerprint = ${targetFingerprint}`;
                for (const r of identIps) {
                    if (r.created_ip) associatedIps.add(r.created_ip);
                    if (r.last_ip) associatedIps.add(r.last_ip);
                }
            }

            if (targetHwFingerprint) {
                const actIps = await db`select distinct ip from anon_activity_log where hw_fingerprint = ${targetHwFingerprint}`;
                for (const r of actIps) if (r.ip) associatedIps.add(r.ip);
            }

            for (const ip of associatedIps) {
                if (!ip || ip === 'unknown') continue;
                const isAlreadyHash = /^[a-f0-9]{64}$/i.test(ip);
                const ipVal = ip;
                const ipHash = isAlreadyHash ? ip : this.hashIP(ip);
                await db`
                    insert into banned_ips (ip, ip_hash, banned_by, reason, expires_at)
                    values (${ipVal}, ${ipHash}, ${bannedBy}, ${reason}, ${expires})
                    on conflict (ip) do update
                    set reason = excluded.reason,
                        expires_at = excluded.expires_at,
                        banned_by = excluded.banned_by,
                        ip_hash = excluded.ip_hash
                `.catch(err => console.error('[SECURITY] Error inserting banned IP:', err));
            }
        }

        // 5. Broadcast ban immediately via Postgres notify
        try {
            const hwList = Array.from(associatedHws).slice(0, 50);
            const ipList = Array.from(associatedIps).slice(0, 50);
            await db.notify('bans', JSON.stringify({
                userId,
                fingerprint: targetFingerprint,
                hwFingerprints: hwList,
                ips: ipList,
                reason: (reason || 'Banned anonymous identity').substring(0, 300),
                expires
            }));
        } catch (e) {
            console.error('[SECURITY] Error notifying bans channel:', e);
        }

        return { success: true, userId, fingerprint: targetFingerprint, hwFingerprint: targetHwFingerprint };
    }
};
