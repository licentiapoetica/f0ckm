import crypto from "crypto";
import db from "./sql.mjs";
import cfg from "./config.mjs";

const RATE_LIMIT_WINDOW_MINUTES = 600; // 10 hours
const MAX_ATTEMPTS = 5;

export default new class {
    /**
     * Anonymize IP address using Hmac-SHA256 with a secret salt.
     * @param {string} ip 
     * @returns {string}
     */
    hashIP(ip) {
        if (!ip) return "unknown";
        const secret = cfg.main.invite_secret;
        if (!secret) {
            throw new Error('[FATAL] invite_secret is not configured. Set it in config.json to enable IP hashing. Refusing to use a predictable fallback salt.');
        }
        return crypto.createHmac("sha256", secret).update(ip).digest("hex");
    }

    /**
     * Get real IP from request headers or socket.
     * @param {object} req 
     * @returns {string}
     */
    getRealIP(req) {
        let ip = req.headers['x-real-ip'] ||
            (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
            req.socket.remoteAddress;

        if (!ip) return "unknown";

        // Handle IPv6 loopback and mapped IPv4
        if (ip === "::1") ip = "127.0.0.1";
        if (ip.startsWith("::ffff:")) ip = ip.substring(7);

        // Basic IPv6 normalization (ensure consistent case and representation if possible)
        // Note: Simple hex strings for IP are fine for hashing as long as Nginx is consistent.
        if (ip.includes(":")) ip = ip.toLowerCase();

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
        console.log(`[SECURITY] Recording ${type} attempt: user=${username}, success=${success}, ip_hash=${ip_hash}`);
        await db`
            insert into login_attempts (ip_hash, username, type, success)
            values (${ip_hash}, ${username?.toLowerCase() || null}, ${type}, ${success})
        `.catch(err => console.error(`[SECURITY] Failed to record ${type} attempt:`, err));
    }

    /**
     * Clear failed attempts for a given IP and/or username.
     * @param {string} ip 
     * @param {string} username 
     */
    async clearAttempts(ip, username) {
        const ip_hash = this.hashIP(ip);
        console.log(`[SECURITY] Clearing attempts for user=${username}, ip_hash=${ip_hash}`);
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

        console.log(`[SECURITY] Checking rate limit for ${type}: user=${username}, ip_hash=${ip_hash}`);

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
        if (ipCount >= maxAttempts) return true;

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
            if (userCount >= maxAttempts) return true;
        }

        return false;
    }
};
