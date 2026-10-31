import db from "../sql.mjs";
import audit from "../audit.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import { safeDeleteMediaFile } from "../lib_delete.mjs";

import lib from "../lib.mjs";
import { setMotd } from "../motd.mjs";
import { setAboutText, setRulesText, setTermsText } from "../page_texts.mjs";
import { exec } from "child_process";
import { promises as fs } from "fs";
import cfg, { configFilePath, writeConfigFile, reloadConfig } from "../config.mjs";
import security from "../security.mjs";
import crypto from "crypto";
import path from "path";
import YAML from "yaml";
import { getManualApproval, setManualApproval, getMinTags, setMinTags, getRegistrationOpen, setRegistrationOpen, getTrustedUploads, setTrustedUploads, getEnablePdf, setEnablePdf, getLogUserIps, setLogUserIps, getHashUserIps, setHashUserIps, getEnableCleanup, setEnableCleanup, getCleanupStartDate, setCleanupStartDate, getCleanupEndDate, setCleanupEndDate, getCleanupIncludeEngaged, setCleanupIncludeEngaged, getShitpostMode, ensureAllItemsHaveSlugs, getEnableItemSlugs, getBrandImageUrl } from "../settings.mjs";

export default (router, tpl) => {
  router.get(/^\/login(\/)?$/, async (req, res) => {
    if (req.session) {
      return res.writeHead(302, { "Location": "/?already_logged_in=1" }).end();
    }
    res.redirect('/?login=1');
  });

  router.post(/^\/login(\/)?$/, async (req, res) => {
    const ip = security.getRealIP(req);
    const username = req.post.username;
    const password = req.post.password;

    const fail = async (msg) => {
      await security.recordAttempt(ip, username, 'login', false);
      // Artificial delay to prevent timing attacks and slow down brute-force
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      }
      return res.reply({ body: tpl.render("login", { error: msg, theme: req.theme }) });
    };

    if (await security.isRateLimited(ip, null, 'login')) {
      const msg = "Too many attempts.";
      if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      }
      return res.reply({ code: 429, body: msg });
    }

    if (!username || !password) {
      return fail("Invalid username or password.");
    }

    const user = await db`
      select id, password, activated, banned, ban_reason, ban_expires, force_password_change
      from "user"
      where "login" = ${username.toLowerCase()} or lower(email) = lower(${username.trim()})
      limit 1
    `;


    if (user.length === 0)
      return fail("user doesn't exist or wrong password");

    if (!(await lib.verify(req.post.password, user[0].password)))
      return fail("user doesn't exist or wrong password");

    if (!user[0].activated)
      return fail("This account is not activated. Please check your email.");

    if (user[0].banned) {
      const now = new Date();
      if (user[0].ban_expires && new Date(user[0].ban_expires) < now) {
        // Ban expired, lift it
        await db`update "user" set banned = false, ban_reason = null, ban_expires = null where id = ${+user[0].id}`;
        user[0].banned = false;
        user[0].ban_reason = null;
        user[0].ban_expires = null;
      } else {
        const reason = user[0].ban_reason || 'none';
        const expires = user[0].ban_expires ? new Date(user[0].ban_expires).toISOString().replace('T', ' ').substring(0, 16) : 'never';
        if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
          return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            success: false,
            banned: true,
            msg: `You are banned! reason: ${reason} expire: ${expires}`,
            redirect: '/banned'
          }));
        }
        return res.writeHead(302, { Location: '/banned' }).end();
      }
    }

    await security.recordAttempt(ip, username, 'login', true);
    await security.clearAttempts(ip, username);

    const stamp = ~~(Date.now() / 1e3);

    // F-015: Clean up stale non-KMSI sessions unused for 7 days (on login)
    await db`
      delete from user_sessions
      where last_used <= ${stamp - 604800}
      and kmsi = 0
    `;

    const session = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const blah = {
      user_id: user[0].id,
      session: lib.sha256(session),
      csrf_token: csrfToken,
      browser: req.headers["user-agent"],
      created_at: stamp,
      last_used: stamp,
      last_action: "/login",
      kmsi: typeof req.post.kmsi !== 'undefined' ? 1 : 0,
      ip: security.storableIP(ip)
    };

    await db`
      insert into "user_sessions" ${db(blah, 'user_id', 'session', 'csrf_token', 'browser', 'created_at', 'last_used', 'last_action', 'kmsi', 'ip')
      }
    `;
    
    // Log IP for historical data
    await security.logUserIP(user[0].id, ip);

    return res.writeHead(301, {
      "Cache-Control": "no-cache, public",
      "Set-Cookie": `session=${session}; ${lib.getCookieOptions('Fri, 31 Dec 9999 23:59:59 GMT')}`,
      "Location": "/"
    }).end();
  });

  router.get(/^\/logout$/, async (req, res) => {
    if (req.session && req.session.sess_id) {
      await db`
        delete from "user_sessions"
        where id = ${+req.session.sess_id}
      `;
    }
    return res.writeHead(301, {
      "Cache-Control": "no-cache, public",
      "Set-Cookie": `session=; ${lib.getCookieOptions('Thu, 01 Jan 1970 00:00:00 GMT')}`,
      "Location": "/"
    }).end();
  });



  // Forgot Password
  router.get(/^\/forgot-password(\/)?$/, (req, res) => res.redirect('/'));

  router.post(/^\/forgot-password(\/)?$/, async (req, res) => {
    const { email } = req.post;
    const ip = security.getRealIP(req);
    const isAJAX = req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'));

    if (!email) {
      const msg = "Email is required";
      if (isAJAX) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      return res.reply({ body: tpl.render("forgot-password", { error: msg }) });
    }

    // 1. Initial IP-only check (anonymous)
    if (await security.isRateLimited(ip, null, 'password_reset_request')) {
      const msg = "Too many attempts. Please try again later.";
      if (isAJAX) return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      return res.reply({ code: 429, body: tpl.render("forgot-password", { error: msg }) });
    }

    const user = (await db`select id, login, password from "user" where lower(email) = lower(${email.trim()}) limit 1`)[0];
    const targetIdentity = user ? user.login : email;

    // 2. Identity-based check
    if (await security.isRateLimited(ip, targetIdentity, 'password_reset_request')) {
      const msg = "Only one reset request per 24 hours is allowed for this account.";
      if (isAJAX) return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      return res.reply({ code: 429, body: tpl.render("forgot-password", { error: msg }) });
    }
    
    // Record attempt (always success=true for rate limiting purposes if user exists, or false if not, 
    // but the user wants "maximum tries per day is 1", so we record it regardless of email existence)
    await security.recordAttempt(ip, targetIdentity, 'password_reset_request', true);

    // Passkey-only accounts (password '!') can't get a password by mail: same neutral answer, no mail
    if (!user || user.password === '!') {
      const msg = "If an account with that email exists, we have sent a reset link.";
      if (isAJAX) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, msg }));
      return res.reply({ body: tpl.render("forgot-password", { success: msg }) });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await db`update "user" set reset_token = ${token}, reset_expires = ${expires} where id = ${user.id}`;

    const resetLink = `${cfg.main.url.full}/?token=${token}`; // Redirect to home with token
    const mailBody = `Hello,\n\nYou requested a password reset for your account. Please click the link below to set a new password:\n\n${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you did not request this, please ignore this email.`;

    try {
      const { sendMail } = await import("../../lib/smtp.mjs");
      if (cfg.smtp && cfg.smtp.enabled) {
        await sendMail(cfg.smtp, {
          to: email,
          subject: "Password Reset Request",
          body: mailBody
        });
      } else {
        console.log(`[SMTP] No configuration found. Reset link: ${resetLink}`);
      }
    } catch (e) {
      console.error(`[SMTP] Send failed:`, e.message);
    }

    const msg = "If an account with that email exists, we have sent a reset link.";
    if (isAJAX) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, msg }));
    res.reply({
      body: tpl.render("forgot-password", { success: msg })
    });
  });

  // Reset Password
  // Reset Password
  router.get(/^\/reset-password(\/)?$/, (req, res) => {
    const token = req.url.qs?.token;
    if (token) return res.redirect(`/?token=${token}`);
    res.redirect('/');
  });

  router.post(/^\/reset-password(\/)?$/, async (req, res) => {
    const { token, password, password_confirm } = req.post;
    const ip = security.getRealIP(req);
    const isAJAX = req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'));

    if (!token || !password || !password_confirm) {
        if (isAJAX) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Missing data' }));
        return res.redirect('/login');
    }

    if (password !== password_confirm) {
      const msg = "Passwords do not match";
      if (isAJAX) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      return res.reply({
        body: tpl.render("reset-password", { token, error: msg })
      });
    }

    if (password.length < 20) {
      const msg = "Password must be at least 20 characters long";
      if (isAJAX) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      return res.reply({
        body: tpl.render("reset-password", { token, error: msg })
      });
    }

    // Rate limit the actual password reset execution too (prevent brute-forcing tokens or multiple resets)
    if (await security.isRateLimited(ip, null, 'password_reset_execution')) {
       const msg = "Too many reset attempts. Please try again later.";
       if (isAJAX) return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
       return res.reply({ code: 429, body: tpl.render("forgot-password", { error: msg }) });
    }

    const user = (await db`select id from "user" where reset_token = ${token} and reset_expires > now() and password <> '!' limit 1`)[0];
    if (!user) {
      const msg = "Invalid or expired reset token.";
      if (isAJAX) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      return res.reply({
        body: tpl.render("forgot-password", { error: msg })
      });
    }

    const hash = await lib.hash(password);
    await db`update "user" set password = ${hash}, reset_token = NULL, reset_expires = NULL where id = ${user.id}`;

    // Invalidate all sessions for this user after password reset
    await db`delete from "user_sessions" where user_id = ${user.id}`;

    // Record successful reset execution
    await security.recordAttempt(ip, user.login, 'password_reset_execution', true);

    const msg = "Password reset successfully! You can now login with your new password.";
    if (isAJAX) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, msg }));
    res.reply({
      body: tpl.render("reset-password", { success: msg })
    });
  });

  router.get(/^\/admin(\/)?$/, lib.auth, async (req, res) => { // frontpage

    // Dashboard counters (cheap aggregate queries; failures just show 0)
    const dash = { open_reports: 0, users: 0, anon_users: 0, trash: 0, invite_requests: 0 };
    try {
      const [[r], [u], [t], [ir]] = await Promise.all([
        db`SELECT count(*)::int AS n FROM reports WHERE status = 'pending'`,
        db`SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM anon_identities ai WHERE ai.user_id = "user".id))::int AS users,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM anon_identities ai WHERE ai.user_id = "user".id))::int AS anon
           FROM "user"`,
        db`SELECT count(*)::int AS n FROM items WHERE active = false AND is_deleted = true AND is_purged = false`,
        db`SELECT count(*)::int AS n FROM invite_requests WHERE status = 'pending'`
      ]);
      dash.trash = t?.n || 0;
      dash.invite_requests = ir?.n || 0;
      dash.open_reports = r?.n || 0;
      dash.users = u?.users || 0;
      dash.anon_users = u?.anon || 0;
    } catch (e) {
      console.error('[ADMIN] dashboard counters failed:', e.message);
    }

    res.reply({
      body: tpl.render("admin", {
        dash,
        totals: await lib.countf0cks(),
        session: req.session,
        manual_approval: getManualApproval(),
        min_tags: getMinTags(),
        trusted_uploads: getTrustedUploads(),
        registration_open: getRegistrationOpen(),
        registration_web_toggle_enabled: cfg.websrv.open_registration_web_toggle !== false,
        log_user_ips: getLogUserIps(),
        hash_user_ips: getHashUserIps(),
        enable_cleanup: getEnableCleanup(),
        shitpost_mode: getShitpostMode(),
        enable_cleanup_config: cfg.websrv.enable_cleanup !== false,
        current_brand_image: getBrandImageUrl(),
        tmp: null
      }, req)
    });
  });

  router.get(/^\/admin\/sessions(\/)?$/, lib.auth, async (req, res) => {
    const rows = await db`
      select "user_sessions".*, "user".user
      from "user_sessions"
      left join "user" on "user".id = "user_sessions".user_id
      order by "user_sessions".last_used desc
    `;

    const now = ~~(Date.now() / 1e3);
    const activeThreshold = 15 * 60; // 15 minutes
    const activeUsernames = [...new Set(
      rows.filter(r => (now - r.last_used) < activeThreshold).map(r => r.user)
    )];

    res.reply({
      body: tpl.render("admin/sessions", {
        session: req.session,
        sessions: rows,
        activeUsers: activeUsernames.length,
        activeUserList: activeUsernames,
        totals: await lib.countf0cks(),
        log_user_ips: getLogUserIps(),
        tmp: null
      }, req)
    });
  });

  router.get(/^\/admin\/bans(\/)?$/, lib.modAuth, async (req, res) => {
    const bannedFingerprints = await db`
      select bf.*,
             u.login as anon_login, u.user as anon_user,
             admin.user as banned_by_user
      from banned_fingerprints bf
      left join anon_identities ai on ai.fingerprint = bf.fingerprint
      left join "user" u on u.id = ai.user_id
      left join "user" admin on admin.id = bf.banned_by
      order by bf.created_at desc
    `;

    const bannedHardware = await db`
      select bh.*,
             admin.user as banned_by_user
      from banned_hardware_fingerprints bh
      left join "user" admin on admin.id = bh.banned_by
      order by bh.created_at desc
    `;

    const bannedIps = await db`
      select bi.*,
             admin.user as banned_by_user
      from banned_ips bi
      left join "user" admin on admin.id = bi.banned_by
      order by bi.created_at desc
    `;

    const anonIdentities = await db`
      select ai.*,
             u.id as user_id, u.login, u.user, u.banned as is_banned, u.ban_reason,
             bf.id as is_fp_banned,
             bh.id as is_hw_banned
      from anon_identities ai
      left join "user" u on u.id = ai.user_id
      left join banned_fingerprints bf on bf.fingerprint = ai.fingerprint
      left join banned_hardware_fingerprints bh on bh.hw_fingerprint = ai.hw_fingerprint
      order by ai.last_seen desc
      limit 100
    `;

    const recentActivity = await db`
      select al.*,
             u.login, u.user
      from anon_activity_log al
      left join "user" u on u.id = al.user_id
      order by al.created_at desc
      limit 100
    `;

    res.reply({
      body: tpl.render("admin/bans", {
        session: req.session,
        csrf_token: req.session ? req.session.csrf_token : '',
        bannedFingerprints,
        bannedHardware,
        bannedIps,
        anonIdentities,
        recentActivity,
        tmp: null
      }, req)
    });
  });

  router.post(/^\/api\/v2\/admin\/bans\/fingerprint\/ban\/?$/, lib.modAuth, async (req, res) => {
    try {
      const { fingerprint, reason, duration, ban_ips, user_id } = req.post || {};
      if (!fingerprint) throw new Error('Missing fingerprint');

      const expires = duration === 'permanent' || !duration ? null : new Date(Date.now() + parseInt(duration, 10) * 3600000);

      const result = await security.banAnonymousUser({
        userId: user_id ? +user_id : null,
        fingerprint,
        bannedBy: req.session.id,
        reason: reason || 'Banned by moderator',
        expires,
        banIps: ban_ips !== false
      });

      await audit.log(req.session.id, 'ban_fingerprint', 'fingerprint', null, { fingerprint, reason, duration });

      return res.json({ success: true, result });
    } catch (err) {
      return res.json({ success: false, msg: err.message });
    }
  });

  router.post(/^\/api\/v2\/admin\/bans\/fingerprint\/unban\/?$/, lib.modAuth, async (req, res) => {
    try {
      const { fingerprint } = req.post || {};
      if (!fingerprint) throw new Error('Missing fingerprint');

      await db`DELETE FROM banned_fingerprints WHERE fingerprint = ${fingerprint}`;

      // Also unban any shadow user associated with this fingerprint
      const ident = await db`SELECT user_id FROM anon_identities WHERE fingerprint = ${fingerprint}`;
      if (ident.length > 0) {
        await db`UPDATE "user" SET banned = false, ban_reason = null, ban_expires = null WHERE id = ${ident[0].user_id}`;
      }

      await audit.log(req.session.id, 'unban_fingerprint', 'fingerprint', null, { fingerprint });

      return res.json({ success: true });
    } catch (err) {
      return res.json({ success: false, msg: err.message });
    }
  });

  router.post(/^\/api\/v2\/admin\/bans\/ip\/ban\/?$/, lib.modAuth, async (req, res) => {
    try {
      const { ip, reason, duration } = req.post || {};
      if (!ip) throw new Error('Missing IP address');

      const expires = duration === 'permanent' || !duration ? null : new Date(Date.now() + parseInt(duration, 10) * 3600000);
      // Already a stored hash (banned from the IP list) or a raw address typed by the moderator
      const isHash = /^[a-f0-9]{64}$/i.test(ip);
      const ipHash = isHash ? ip.toLowerCase() : security.hashIP(ip);
      // With hashing on, the raw address is never persisted, not even in the ban list
      const ipStored = (isHash || cfg.websrv.hash_user_ips) ? ipHash : ip;

      await db`
        INSERT INTO banned_ips (ip, ip_hash, banned_by, reason, expires_at)
        VALUES (${ipStored}, ${ipHash}, ${req.session.id}, ${reason || 'Banned by moderator'}, ${expires})
        ON CONFLICT (ip) DO UPDATE
        SET reason = EXCLUDED.reason,
            expires_at = EXCLUDED.expires_at,
            banned_by = EXCLUDED.banned_by,
            ip_hash = EXCLUDED.ip_hash
      `;

      await audit.log(req.session.id, 'ban_ip', 'ip', null, { ip, reason, duration });

      // Broadcast ban event via SSE
      await db.notify('bans', JSON.stringify({
        ip,
        ipHash,
        reason: (reason || 'Banned by moderator').substring(0, 300),
        expires
      })).catch(() => {});

      return res.json({ success: true });
    } catch (err) {
      return res.json({ success: false, msg: err.message });
    }
  });

  router.post(/^\/api\/v2\/admin\/bans\/ip\/unban\/?$/, lib.modAuth, async (req, res) => {
    try {
      const { ip } = req.post || {};
      if (!ip) throw new Error('Missing IP');

      await db`DELETE FROM banned_ips WHERE ip = ${ip} OR ip_hash = ${ip}`;

      await audit.log(req.session.id, 'unban_ip', 'ip', null, { ip });

      return res.json({ success: true });
    } catch (err) {
      return res.json({ success: false, msg: err.message });
    }
  });

  router.post(/^\/api\/v2\/admin\/bans\/hardware\/ban\/?$/, lib.modAuth, async (req, res) => {
    try {
      const { hw_fingerprint, reason, duration, ban_ips, user_id } = req.post || {};
      if (!hw_fingerprint) throw new Error('Missing hardware fingerprint');

      const expires = duration === 'permanent' || !duration ? null : new Date(Date.now() + parseInt(duration, 10) * 3600000);

      const result = await security.banAnonymousUser({
        userId: user_id ? +user_id : null,
        hwFingerprint: hw_fingerprint,
        bannedBy: req.session.id,
        reason: reason || 'Banned by moderator',
        expires,
        banIps: ban_ips !== false,
        banHardware: true
      });

      await audit.log(req.session.id, 'ban_hardware', 'hardware', null, { hw_fingerprint, reason, duration });

      return res.json({ success: true, result });
    } catch (err) {
      return res.json({ success: false, msg: err.message });
    }
  });

  router.post(/^\/api\/v2\/admin\/bans\/hardware\/unban\/?$/, lib.modAuth, async (req, res) => {
    try {
      const { hw_fingerprint } = req.post || {};
      if (!hw_fingerprint) throw new Error('Missing hardware fingerprint');

      await db`DELETE FROM banned_hardware_fingerprints WHERE hw_fingerprint = ${hw_fingerprint}`;

      await audit.log(req.session.id, 'unban_hardware', 'hardware', null, { hw_fingerprint });

      return res.json({ success: true });
    } catch (err) {
      return res.json({ success: false, msg: err.message });
    }
  });

  router.get(/^\/admin\/user\/(?<userId>\d+)\/ips(\/)?$/, lib.auth, async (req, res) => {
    const userId = +req.params.userId;
    const user = await db`select "user", login from "user" where id = ${userId} limit 1`;
    if (user.length === 0) return res.reply({ code: 404, body: 'User not found' });

    const rows = await db`
      select * from user_ips
      where user_id = ${userId}
      order by last_seen desc
    `;

    res.reply({
      body: tpl.render("admin/user_ips", {
        session: req.session,
        targetUser: user[0],
        ips: rows,
        page_meta: {
          title: `IP History - ${user[0].user}`
        },
        totals: await lib.countf0cks(),
        tmp: null
      }, req)
    });
  });

  router.post(/^\/api\/v2\/admin\/sessions\/delete\/?$/, lib.auth, async (req, res) => {
    try {
      const { id } = req.post;
      if (!id) throw new Error('Missing session ID');

      // Prevent self-deletion of current session
      if (+id === +req.session.sess_id) {
        throw new Error('Cannot delete your current session');
      }

      await db`delete from "user_sessions" where id = ${+id}`;

      if (res.json) return res.json({ success: true });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
    } catch (err) {
      if (res.json) return res.json({ success: false, msg: err.message });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.get(/^\/admin\/approve\/?/, lib.modAuth, async (req, res) => {
    if (req.url.qs?.id) {
      return res.redirect(`/mod/approve?id=${req.url.qs.id}`);
    }
    return res.redirect("/mod/approve");
  });

  router.get(/^\/admin\/deny\/?/, lib.modAuth, async (req, res) => {
    // Forward ID if present
    if (req.url.qs?.id) {
      return res.redirect(`/mod/deny?id=${req.url.qs.id}`);
    }
    return res.redirect("/mod/approve");
  });

  // Deprecate bulk actions in admin route, suggest mod route
  router.post(/^\/admin\/deny-multi\/?/, lib.auth, async (req, res) => {
    return res.reply({ code: 307, headers: { Location: '/mod/deny-multi' } });
  });

  router.post(/^\/admin\/purge-trash-all\/?/, lib.auth, async (req, res) => {
    return res.reply({ code: 307, headers: { Location: '/mod/purge-trash-all' } });
  });

  // Token Routes
  router.get(/^\/admin\/tokens\/?$/, lib.auth, async (req, res) => {
    res.reply({
      body: tpl.render("admin/tokens", { session: req.session, tmp: null }, req)
    });
  });

  router.get(/^\/api\/v2\/admin\/tokens\/?$/, lib.auth, async (req, res) => {
    const tokens = await db`
        select invite_tokens.*, 
               u_used.user as used_by_name,
               u_created.user as created_by_name
        from invite_tokens
        left join "user" as u_used on u_used.id = invite_tokens.used_by
        left join "user" as u_created on u_created.id = invite_tokens.created_by
        order by created_at desc
    `;
    if (res.json) {
      return res.json({ success: true, tokens });
    }
    // Fallback if res.json is not available
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, tokens }));
  });

  router.post(/^\/api\/v2\/admin\/tokens\/create\/?$/, lib.auth, async (req, res) => {
    try {
      // 128-bit random token — replaces weak 10-char SHA256 slice (~40 bits)
      const token = crypto.randomBytes(16).toString('hex').toUpperCase();
      await db`
            insert into invite_tokens (token, created_at, created_by)
            values (${token}, ${~~(Date.now() / 1e3)}, ${req.session.id})
        `;
      if (res.json) return res.json({ success: true, token });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, token }));
    } catch (err) {
      const msg = lib.logError(err, 'Token creation failed');
      if (res.json) return res.json({ success: false, msg });
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
    }
  });

  router.post(/^\/api\/v2\/admin\/tokens\/delete\/?$/, lib.auth, async (req, res) => {
    if (!req.post.id) {
      if (res.json) return res.json({ success: false });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false }));
    }

    // Revoke any linked invite request and notify the user
    const [linkedRequest] = await db`
      SELECT ir.id, ir.user_id FROM invite_requests ir
      WHERE ir.token_id = ${req.post.id} AND ir.status = 'approved'
    `;
    if (linkedRequest) {
      await db`
        UPDATE invite_requests
        SET status = 'revoked', reviewed_at = NOW(), reviewed_by = ${req.session.id}
        WHERE id = ${linkedRequest.id}
      `;
      if (linkedRequest.user_id) {
        await db`
          INSERT INTO notifications (user_id, type, reference_id, data)
          VALUES (${linkedRequest.user_id}, 'invite_denied', 0, ${db.json({ revoked: true })})
        `;
      }
    }

    await db`delete from invite_tokens where id = ${req.post.id}`;
    if (res.json) return res.json({ success: true });
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
  });

  // ═══════════════════ Invite Requests (admin) ═══════════════════

  // List all invite requests
  router.get(/^\/api\/v2\/admin\/invite-requests\/?$/, lib.auth, async (req, res) => {
    try {
      const requests = await db`
        SELECT ir.*,
               u_reviewer.user as reviewed_by_name,
               u_requester.login as requester_login,
               u_requester.user as requester_name
        FROM invite_requests ir
        LEFT JOIN "user" u_reviewer ON u_reviewer.id = ir.reviewed_by
        LEFT JOIN "user" u_requester ON u_requester.id = ir.user_id
        ORDER BY
          CASE WHEN ir.status = 'pending' THEN 0 ELSE 1 END,
          ir.created_at DESC
        LIMIT 200
      `;
      if (res.json) return res.json({ success: true, requests });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, requests }));
    } catch (err) {
      const msg = lib.logError(err, 'Failed to fetch invite requests');
      if (res.json) return res.json({ success: false, msg });
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
    }
  });

  // Approve an invite request — generates a token and notifies the anon user
  router.post(/^\/api\/v2\/admin\/invite-requests\/approve\/?$/, lib.auth, async (req, res) => {
    try {
      const { id } = req.post;
      if (!id) {
        if (res.json) return res.json({ success: false, msg: 'Missing request id' });
        return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Missing request id' }));
      }

      // Check request exists and is pending
      const [request] = await db`SELECT * FROM invite_requests WHERE id = ${+id} AND status = 'pending'`;
      if (!request) {
        if (res.json) return res.json({ success: false, msg: 'Request not found or already processed' });
        return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Request not found or already processed' }));
      }

      // Generate invite token
      const token = crypto.randomBytes(16).toString('hex').toUpperCase();
      const [tokenRow] = await db`
        INSERT INTO invite_tokens (token, created_at, created_by)
        VALUES (${token}, ${~~(Date.now() / 1e3)}, ${req.session.id})
        RETURNING id
      `;

      // Update request status
      await db`
        UPDATE invite_requests
        SET status = 'approved', token_id = ${tokenRow.id}, reviewed_by = ${req.session.id}, reviewed_at = NOW()
        WHERE id = ${+id}
      `;

      // Find the anon user's real user_id via their fingerprint, and send them a notification
      const anonUser = await db`
        SELECT user_id FROM anon_identities WHERE fingerprint = ${request.fingerprint} LIMIT 1
      `;
      if (anonUser.length > 0) {
        await db`
          INSERT INTO notifications (user_id, type, reference_id, data)
          VALUES (${anonUser[0].user_id}, 'invite_approved', 0, ${db.json({ token, request_id: +id })})
        `;
      }

      console.log(`[INVITE-REQ] Approved request #${id} (fp: ${request.fingerprint.slice(0, 12)}…) → token ${token.slice(0, 8)}…`);

      if (res.json) return res.json({ success: true, token });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, token }));
    } catch (err) {
      const msg = lib.logError(err, 'Failed to approve invite request');
      if (res.json) return res.json({ success: false, msg });
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
    }
  });

  // Deny an invite request
  router.post(/^\/api\/v2\/admin\/invite-requests\/deny\/?$/, lib.auth, async (req, res) => {
    try {
      const { id } = req.post;
      if (!id) {
        if (res.json) return res.json({ success: false, msg: 'Missing request id' });
        return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Missing request id' }));
      }

      const [request] = await db`SELECT * FROM invite_requests WHERE id = ${+id} AND status = 'pending'`;
      if (!request) {
        if (res.json) return res.json({ success: false, msg: 'Request not found or already processed' });
        return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Request not found or already processed' }));
      }

      await db`
        UPDATE invite_requests
        SET status = 'denied', reviewed_by = ${req.session.id}, reviewed_at = NOW()
        WHERE id = ${+id}
      `;

      // Notify the anon user their request was denied
      const anonUser = await db`
        SELECT user_id FROM anon_identities WHERE fingerprint = ${request.fingerprint} LIMIT 1
      `;
      if (anonUser.length > 0) {
        await db`
          INSERT INTO notifications (user_id, type, reference_id, data)
          VALUES (${anonUser[0].user_id}, 'invite_denied', 0, ${db.json({ request_id: +id })})
        `;
      }

      console.log(`[INVITE-REQ] Denied request #${id} (fp: ${request.fingerprint.slice(0, 12)}…)`);

      if (res.json) return res.json({ success: true });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
    } catch (err) {
      const msg = lib.logError(err, 'Failed to deny invite request');
      if (res.json) return res.json({ success: false, msg });
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
    }
  });

  router.post(/^\/api\/v2\/admin\/ban\/?$/, lib.modAuth, async (req, res) => {
    try {
      const { user_id, reason, duration } = req.post;
      // Check if target is an admin or protected account
      const targetUser = await db`select admin, "user", login from "user" where id = ${+user_id} limit 1`;
      if (targetUser.length === 0) {
        throw new Error('User not found');
      }

      if (targetUser[0].login === 'deleted_user') {
        throw new Error('The deleted_user account is a protected system ghost and cannot be modified.');
      }

      if (targetUser[0].admin && !req.session.admin) {
        const errorMsg = 'Moderators cannot ban administrators.';
        if (res.json) return res.json({ success: false, msg: errorMsg }, 403);
        return res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: errorMsg }));
      }

      // Enforce 48h limit for moderators
      if (!req.session.admin) {
        if (duration === 'permanent' || parseInt(duration) > 48) {
          const errorMsg = 'Moderators can only issue bans for up to 48 hours.';
          if (res.json) return res.json({ success: false, msg: errorMsg }, 403);
          return res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: errorMsg }));
        }
      }

      const expires = duration === 'permanent' ? null : new Date(Date.now() + parseInt(duration) * 3600000);

      await db`
        update "user"
        set banned = true,
            ban_reason = ${reason},
            ban_expires = ${expires}
        where id = ${+user_id}
      `;

      // If this is an anonymous identity, cascade the ban to fingerprint and IPs
      const anonIdent = await db`SELECT fingerprint FROM anon_identities WHERE user_id = ${+user_id} LIMIT 1`;
      if (anonIdent.length > 0 || (targetUser[0].login && targetUser[0].login.startsWith('anon_'))) {
        await security.banAnonymousUser({
          userId: +user_id,
          fingerprint: anonIdent[0]?.fingerprint || null,
          bannedBy: req.session.id,
          reason,
          expires,
          banIps: true
        });
      } else {
        // Broadcast ban to registered user's active SSE sessions
        const userIps = await db`SELECT distinct ip FROM user_ips WHERE user_id = ${+user_id}`;
        const ips = userIps.map(r => r.ip).filter(Boolean);
        await db.notify('bans', JSON.stringify({
          userId: +user_id,
          reason: (reason || 'Violation of community rules').substring(0, 300),
          expires,
          ips
        })).catch(() => {});
      }

      // Log it in audit
      await audit.log(req.session.id, 'ban_user', 'user', +user_id, { reason, duration, target_user: targetUser[0].user });

      // Terminate all sessions for this user
      await db`delete from "user_sessions" where user_id = ${+user_id}`;

      if (res.json) return res.json({ success: true });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
    } catch (err) {
      if (res.json) return res.json({ success: false, msg: err.message });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/unban\/?$/, lib.modAuth, async (req, res) => {
    try {
      const { user_id } = req.post;
      if (!user_id) {
        throw new Error('Missing user_id');
      }

      const target = await db`SELECT login FROM "user" WHERE id = ${+user_id} LIMIT 1`;
      if (target.length && target[0].login === 'deleted_user') {
        throw new Error('The deleted_user account is a protected system ghost and cannot be unbanned.');
      }

      await db`
        update "user"
        set banned = false,
            ban_reason = null,
            ban_expires = null,
            last_seen = ${~~(Date.now() / 1e3)}
        where id = ${+user_id}
      `;

      // Clean up any banned fingerprint for this identity
      const anonIdent = await db`SELECT fingerprint FROM anon_identities WHERE user_id = ${+user_id} LIMIT 1`;
      if (anonIdent.length > 0) {
        await db`DELETE FROM banned_fingerprints WHERE fingerprint = ${anonIdent[0].fingerprint}`;
      }

      // Log it in audit
      await audit.log(req.session.id, 'unban_user', 'user', +user_id);

      if (res.json) return res.json({ success: true });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
    } catch (err) {
      if (res.json) return res.json({ success: false, msg: err.message });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/subscribe-user-to-uploads\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id } = req.post;
      if (!user_id) {
        throw new Error('Missing user_id');
      }

      // Fetch user info to ensure we match correctly
      const target = await db`SELECT login, "user" FROM "user" WHERE id = ${+user_id} LIMIT 1`;
      if (!target.length) {
        throw new Error('User not found');
      }

      const { login, user } = target[0];

      // Robust subscription logic: Match items by username (case-insensitive) 
      // using both login and display name for maximum coverage of legacy/renaming accounts.
      await db`
        INSERT INTO comment_subscriptions (user_id, item_id)
        SELECT ${+user_id}, i.id
        FROM items i
        WHERE i.username ILIKE ${login} OR i.username ILIKE ${user}
        ON CONFLICT DO NOTHING
      `;

      const response = { success: true, message: 'User subscribed to all their uploads' };
      if (res.json) return res.json(response);
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    } catch (err) {
      console.error('[ADMIN] Failed to subscribe user to uploads:', err);
      const response = { success: false, msg: err.message };
      if (res.json) return res.json(response);
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    }
  });




  router.get(/^\/admin\/motd\/?$/, lib.auth, async (req, res) => {
    const settings = await db`SELECT value FROM site_settings WHERE key = 'motd' LIMIT 1`;
    const motd = settings.length > 0 ? settings[0].value : '';
    res.reply({
      body: tpl.render("admin/motd", {
        session: req.session,
        motd: motd,
        totals: await lib.countf0cks(),
        tmp: null
      }, req)
    });
  });

  router.post(/^\/admin\/motd\/?$/, lib.auth, async (req, res) => {
    try {
      const motd = req.post?.motd ?? '';
      
      await db`INSERT INTO site_settings (key, value) VALUES ('motd', ${motd}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

      // Update global template variable safely via helper
      setMotd(motd);

      // Log it in audit
      await audit.log(req.session.id, 'update_motd', 'system', 0, { motd });

      // Explicitly notify as a fallback and to ensure immediate broadcast in this process
      try {
        await db`SELECT pg_notify('motd', ${motd ? motd.substring(0, 7000) : ''})`;
      } catch (e) {
        console.error('[ADMIN] MOTD Notify failed:', e.message);
      }

      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: true, motd });
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }

      return res.writeHead(302, { "Location": "/admin/motd" }).end();
    } catch (err) {
      console.error('[ADMIN] MOTD Save failed:', err);
      const msg = 'Failed to save MOTD: ' + err.message;

      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: false, msg });
        return res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }
      
      return res.reply({ code: 500, body: msg });
    }
  });

  // Settings POST (Used by AJAX toggle on admin dashboard)
  router.post(/^\/admin\/settings\/?$/, lib.auth, async (req, res) => {
    const manual_approval = req.post.manual_approval === 'on' ? 'true' : 'false';
    const registration_open = req.post.registration_open === 'on' ? 'true' : 'false';
    const min_tags = isNaN(parseInt(req.post.min_tags)) ? 3 : Math.max(0, parseInt(req.post.min_tags));
    const trusted_uploads = Math.max(0, parseInt(req.post.trusted_uploads) ?? 3);

    await db`INSERT INTO site_settings (key, value) VALUES ('manual_approval', ${manual_approval}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

    if (cfg.websrv.open_registration_web_toggle !== false) {
      await db`INSERT INTO site_settings (key, value) VALUES ('registration_open', ${registration_open}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      setRegistrationOpen(registration_open === 'true');
    }


    await db`INSERT INTO site_settings (key, value) VALUES ('min_tags', ${min_tags.toString()}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await db`INSERT INTO site_settings (key, value) VALUES ('trusted_uploads', ${trusted_uploads.toString()}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

    setManualApproval(manual_approval === 'true');
    setMinTags(min_tags);
    setTrustedUploads(trusted_uploads);

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      res.setHeader('Content-Type', 'application/json');
      return res.reply({
        body: JSON.stringify({ 
          success: true, 
          manual_approval: getManualApproval(), 
          registration_open: getRegistrationOpen(),
          min_tags: getMinTags(),
          trusted_uploads: getTrustedUploads()
        })
      });
    }

    return res.writeHead(302, { "Location": "/admin" }).end();
  });

  // Config Manager API GET
  router.get(/^\/api\/v2\/admin\/config\/?$/, async (req, res) => {
    const origin = req.headers?.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (!req.session || !req.session.admin) {
      return res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Unauthorized' }));
    }

    try {
      const config = YAML.parse(await fs.readFile(configFilePath, "utf-8"));
      if (res.json) return res.json({ success: true, config });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, config }));
    } catch (err) {
      if (res.json) return res.json({ success: false, msg: err.message });
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  // Config Manager API POST
  router.post(/^\/api\/v2\/admin\/config\/?$/, async (req, res) => {
    const origin = req.headers?.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (!req.session || !req.session.admin) {
      return res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Unauthorized' }));
    }

    try {
      let updatedConfig = req.post?.config || req.json?.config || req.post;
      if (typeof updatedConfig === 'string') {
        updatedConfig = JSON.parse(updatedConfig);
      }
      // Saved to config.yaml with its comments kept, then applied to the running config
      writeConfigFile(updatedConfig);
      reloadConfig();

      if (getEnableItemSlugs()) {
        ensureAllItemsHaveSlugs();
      }

      // Audit log entry (if session available)
      if (req.session?.id) {
        await audit.log(req.session.id, 'update_config_file', 'system', 0, { updatedKeys: Object.keys(updatedConfig) });
      }

      const response = { success: true, message: 'Configuration saved to config.yaml' };
      if (res.json) return res.json(response);
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    } catch (err) {
      console.error('[ADMIN] Config Save Error:', err);
      const response = { success: false, msg: err.message };
      if (res.json) return res.json(response, 400);
      return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    }
  });

  router.get(/^\/admin\/cleanup\/?$/, lib.auth, async (req, res) => {
    if (!getEnableCleanup()) {
      return res.redirect("/admin");
    }

    const cleanup_payload = {
      session: req.session,
      enable_cleanup: getEnableCleanup(),
      cleanup_start_date: getCleanupStartDate(),
      cleanup_end_date: getCleanupEndDate(),
      cleanup_include_engaged: getCleanupIncludeEngaged(),
      totals: await lib.countf0cks(),
      tmp: null
    };

    res.reply({
      body: tpl.render("admin/cleanup", cleanup_payload, req)
    });
  });

  router.post(/^\/admin\/cleanup\/?$/, lib.auth, async (req, res) => {
    try {
      const cleanup_start_date = req.post.cleanup_start_date || '';
      const cleanup_end_date = req.post.cleanup_end_date || '';
      const cleanup_include_engaged = req.post.cleanup_include_engaged === 'true' || req.post.cleanup_include_engaged === 'on' || req.post.cleanup_include_engaged === '1';

      await db`INSERT INTO site_settings (key, value) VALUES ('cleanup_start_date', ${cleanup_start_date}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      await db`INSERT INTO site_settings (key, value) VALUES ('cleanup_end_date', ${cleanup_end_date}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      await db`INSERT INTO site_settings (key, value) VALUES ('cleanup_include_engaged', ${cleanup_include_engaged ? 'true' : 'false'}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

      setCleanupStartDate(cleanup_start_date);
      setCleanupEndDate(cleanup_end_date);
      setCleanupIncludeEngaged(cleanup_include_engaged);

      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: true, enable_cleanup: getEnableCleanup(), cleanup_start_date: getCleanupStartDate(), cleanup_end_date: getCleanupEndDate(), cleanup_include_engaged: getCleanupIncludeEngaged() });
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }

      return res.writeHead(302, { "Location": "/admin/cleanup" }).end();
    } catch (err) {
      console.error('[ADMIN] Cleanup Settings Save failed:', err);
      const msg = 'Failed to save Cleanup settings: ' + err.message;
      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: false, msg });
        return res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }
      return res.reply({ code: 500, body: msg });
    }
  });

  router.post(/^\/admin\/cleanup\/run\/?$/, lib.auth, async (req, res) => {
    try {
      // Ensure settings are synced from DB before execution
      const settings = await db`SELECT key, value FROM site_settings WHERE key IN ('enable_cleanup', 'cleanup_start_date', 'cleanup_end_date', 'cleanup_include_engaged')`;
      const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));

      const isEnabled = settingsMap['enable_cleanup'] !== undefined ? settingsMap['enable_cleanup'] === 'true' : getEnableCleanup();
      const startDate = settingsMap['cleanup_start_date'] || '';
      const endDate = settingsMap['cleanup_end_date'] || '';

      const reqEngaged = req.post?.include_engaged;
      const includeEngaged = reqEngaged !== undefined 
        ? (reqEngaged === 'true' || reqEngaged === true || reqEngaged === 'on' || reqEngaged === '1')
        : (settingsMap['cleanup_include_engaged'] === 'true' || getCleanupIncludeEngaged());

      // Update memory state
      setEnableCleanup(isEnabled);
      setCleanupStartDate(startDate);
      setCleanupEndDate(endDate);
      setCleanupIncludeEngaged(includeEngaged);

      if (!isEnabled) {
        throw new Error('Cleanup is disabled in settings.');
      }

      if (!startDate || !endDate) {
        throw new Error('Please select both a Start Date and an End Date.');
      }

      console.log(`[ADMIN] Starting manual cleanup for period ${startDate} to ${endDate} (includeEngaged: ${includeEngaged})...`);
      
      const start_stamp = ~~(new Date(startDate).getTime() / 1000);
      const end_stamp = ~~(new Date(endDate).getTime() / 1000) + 86399; // Include full end day

      // Diagnostics: Count candidates
      const totalCleanable = await db`SELECT count(*) as c FROM items WHERE is_purged = false AND is_pinned = false`;
      const withinRange = await db`SELECT count(*) as c FROM items WHERE is_purged = false AND is_pinned = false AND stamp >= ${start_stamp} AND stamp <= ${end_stamp}`;

      const oldItems = await db`
        SELECT i.id, i.dest, i.mime 
        FROM items i
        WHERE i.is_purged = false
          AND i.is_pinned = false
          AND i.stamp >= ${start_stamp} 
          AND i.stamp <= ${end_stamp}
          ${includeEngaged ? db`` : db`AND (
            -- Case 1: Active posts with no engagement (ignoring automatic subscriptions)
            (i.active = true AND i.is_deleted = false AND NOT EXISTS (SELECT 1 FROM comments WHERE item_id = i.id) AND NOT EXISTS (SELECT 1 FROM favorites WHERE item_id = i.id))
            OR
            -- Case 2: Soft-deleted posts (trash) that are old enough to be purged
            (i.is_deleted = true)
            OR
            -- Case 3: Pending posts (not yet approved) that are old enough
            (i.active = false AND i.is_deleted = false)
          )`}
      `;

      const statsInfo = `(Total items: ${totalCleanable[0].c}, In range: ${withinRange[0].c})`;
      console.log(`[ADMIN] Cleanup diagnostic: found ${oldItems.length} targets. ${statsInfo}`);

      let count = 0;
      if (oldItems.length > 0) {
        for (const item of oldItems) {
          try {
            await safeDeleteMediaFile(item.dest, item.id);
            await fs.unlink(path.join(cfg.paths.t, `${item.id}.webp`)).catch(() => { });
            await fs.unlink(path.join(cfg.paths.t, `${item.id}_blur.webp`)).catch(() => { });
            
            if (item.mime?.startsWith('audio')) {
                await fs.unlink(path.join(cfg.paths.ca, `${item.id}.webp`)).catch(() => { });
            }

            await db`DELETE FROM tags_assign WHERE item_id = ${item.id}`;
            await db`UPDATE items SET is_deleted = true, is_purged = true, active = false WHERE id = ${item.id}`;
            count++;
          } catch (e) {
            console.error(`[CLEANUP] Failed to delete item ${item.id}:`, e.message);
          }
        }

        // Clean up any remaining orphan tag assignments for deleted or inactive items
        await db`DELETE FROM tags_assign WHERE item_id IN (SELECT id FROM items WHERE is_deleted = true OR active = false)`;
      }

      // Log it in audit
      await audit.log(req.session.id, 'run_cleanup_manual', 'system', 0, { count, startDate, endDate });

      const response = { success: true, count, msg: `Successfully cleaned up ${count} posts. ${statsInfo}` };
      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify(response);
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }

      const cleanup_payload = {
        ...response,
        session: req.session,
        enable_cleanup: getEnableCleanup(),
        cleanup_start_date: getCleanupStartDate(),
        cleanup_end_date: getCleanupEndDate(),
        totals: await lib.countf0cks()
      };

      return res.reply({ body: tpl.render("admin/cleanup", cleanup_payload, req) });
    } catch (err) {
      console.error('[ADMIN] Cleanup execution failed:', err);
      const msg = 'Cleanup failed: ' + err.message;
      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: false, msg });
        return res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }
      return res.reply({ code: 500, body: msg });
    }
  });

  // User Management Routes
  router.get(/^\/admin\/users\/?$/, lib.auth, async (req, res) => {
    const rawQ = req.url.qs?.q || '';
    // Exact match mode: strip surrounding double quotes and match exactly
    const exactMatch = rawQ.startsWith('"') && rawQ.endsWith('"') && rawQ.length > 2;
    const q = exactMatch ? rawQ.slice(1, -1) : rawQ;
    const page = Math.max(1, parseInt(req.url.qs?.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const rawStatus = (req.url.qs?.status || req.url.qs?.filter || '').toLowerCase().trim();
    const rawRole = (req.url.qs?.role || '').toLowerCase().trim();

    const onlyLegacy = req.url.qs?.legacy === '1' || req.url.qs?.legacy === 'true' || 
                       req.url.qs?.legacy_only === '1' || req.url.qs?.legacy_only === 'true' ||
                       req.url.qs?.only_legacy === '1' || req.url.qs?.only_legacy === 'true' ||
                       rawStatus === 'legacy';

    const status = onlyLegacy ? '' : rawStatus;
    const role = onlyLegacy ? '' : rawRole;

    let users;
    let total;

    if (onlyLegacy) {
      users = await db`
        WITH ghost_users AS (
            SELECT 
                NULL::int as id, i.username as login, i.username as "user", 'Legacy Account' as email, 
                to_timestamp(MIN(i.stamp)) as created_at, false as banned, false as is_moderator, false as admin, ARRAY[]::text[] as groups, true as activated,
                NULL::text as avatar_file, NULL::varchar as display_name, 0 as force_comment_display_mode, 0 as comment_display_mode, 'Legacy' as reg_method
            FROM items i
            WHERE i.username IS NOT NULL AND i.username != ''
              AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.login = i.username OR u.user = i.username)
            ${q ? (exactMatch
              ? db`AND lower(i.username) = lower(${q})`
              : db`AND (i.username ILIKE ${'%' + lib.escapeLike(q) + '%'})`
            ) : db``}
            GROUP BY i.username
        ),
        paginated_users AS (
            SELECT * FROM ghost_users
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
        )
        SELECT 
            pu.*,
            EXTRACT(DAY FROM (now() - pu.created_at)) as age_days,
            COALESCE(ic.upload_count, 0) as upload_count,
            0::bigint as comment_count,
            0::bigint as failed_attempts
        FROM paginated_users pu
        LEFT JOIN LATERAL (
            SELECT COUNT(*) as upload_count 
            FROM items 
            WHERE (username = pu.login OR username = pu.user) AND is_deleted = false
        ) ic ON true
      `;

      const totalCountGhost = await db`
          SELECT COUNT(DISTINCT i.username) as c
          FROM items i
          WHERE i.username IS NOT NULL AND i.username != ''
            AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.login = i.username OR u.user = i.username)
          ${q ? (exactMatch
            ? db`AND lower(i.username) = lower(${q})`
            : db`AND (i.username ILIKE ${'%' + lib.escapeLike(q) + '%'})`
          ) : db``}
      `;
      total = parseInt(totalCountGhost[0].c);
    } else {
      let qCond = null;
      if (q) {
        if (exactMatch) {
          qCond = db`(lower(u.login) = lower(${q}) OR lower(u.user) = lower(${q}) OR lower(u.email) = lower(${q}))`;
        } else {
          const pattern = '%' + lib.escapeLike(q) + '%';
          qCond = db`(u.login ILIKE ${pattern} OR u.user ILIKE ${pattern} OR u.email ILIKE ${pattern})`;
        }
      }

      let statusCond = null;
      if (status === 'banned') {
        statusCond = db`u.banned = true`;
      } else if (status === 'active') {
        statusCond = db`(u.activated = true AND u.banned = false)`;
      } else if (status === 'pending') {
        statusCond = db`(u.activated = false AND u.banned = false)`;
      }

      let roleCond = null;
      if (role === 'staff' || status === 'staff') {
        roleCond = db`(u.admin = true OR u.is_moderator = true)`;
      } else if (role === 'admin') {
        roleCond = db`u.admin = true`;
      } else if (role === 'mod') {
        roleCond = db`(u.is_moderator = true AND u.admin = false)`;
      } else if (role === 'user') {
        roleCond = db`(u.admin = false AND u.is_moderator = false)`;
      }

      users = await db`
        WITH filtered_users AS (
            SELECT 
                u.id, u.login, u.user, u.email, u.created_at, u.banned, u.is_moderator, u.admin, u.groups, u.activated,
                uo.avatar_file, uo.display_name, uo.force_comment_display_mode, uo.comment_display_mode,
                (SELECT token FROM invite_tokens WHERE used_by = u.id ORDER BY created_at DESC LIMIT 1) as reg_method
            FROM "user" u
            LEFT JOIN user_options uo ON uo.user_id = u.id
            WHERE true
            ${qCond ? db`AND ${qCond}` : db``}
            ${statusCond ? db`AND ${statusCond}` : db``}
            ${roleCond ? db`AND ${roleCond}` : db``}
        ),
        paginated_users AS (
            SELECT * FROM filtered_users
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
        )
        SELECT 
            pu.*,
            EXTRACT(DAY FROM (now() - pu.created_at)) as age_days,
            COALESCE(ic.upload_count, 0) as upload_count,
            COALESCE(cc.comment_count, 0) as comment_count,
            COALESCE(la.failed_attempts, 0) as failed_attempts
        FROM paginated_users pu
        LEFT JOIN LATERAL (
            SELECT COUNT(*) as upload_count 
            FROM items 
            WHERE (username = pu.login OR username = pu.user) AND is_deleted = false
        ) ic ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*) as comment_count 
            FROM comments 
            WHERE user_id = pu.id AND is_deleted = false
        ) cc ON pu.id IS NOT NULL
        LEFT JOIN LATERAL (
            SELECT COUNT(*) as failed_attempts
            FROM login_attempts
            WHERE username = pu.login
            AND success = false
            AND type = 'login'
            AND attempted_at > now() - interval '10 hours'
        ) la ON true
      `;

      const totalCountActual = await db`
          SELECT COUNT(*) as c FROM "user" u
          WHERE true
          ${qCond ? db`AND ${qCond}` : db``}
          ${statusCond ? db`AND ${statusCond}` : db``}
          ${roleCond ? db`AND ${roleCond}` : db``}
      `;
      total = parseInt(totalCountActual[0].c);
    }

    let totalLabel = 'registered members';
    let emptyMsg = 'No users matched your search.';
    if (onlyLegacy) {
      totalLabel = 'legacy accounts';
      emptyMsg = 'No legacy users matched your search.';
    } else if (status === 'banned') {
      totalLabel = 'banned members';
      emptyMsg = 'No banned users found.';
    } else if (status === 'pending') {
      totalLabel = 'pending members';
      emptyMsg = 'No pending users found.';
    } else if (status === 'active') {
      totalLabel = 'active members';
      emptyMsg = 'No active users found.';
    } else if (role === 'staff' || status === 'staff') {
      totalLabel = 'staff members';
      emptyMsg = 'No staff members found.';
    } else if (role === 'admin') {
      totalLabel = 'admin members';
      emptyMsg = 'No admin users found.';
    } else if (role === 'mod') {
      totalLabel = 'moderator members';
      emptyMsg = 'No moderator users found.';
    } else if (role === 'user') {
      totalLabel = 'regular users';
      emptyMsg = 'No regular users found.';
    }

    const data = {
      session: req.session,
      users,
      q,
      page,
      total,
      hasMore: users.length === limit,
      onlyLegacy,
      status,
      role,
      totalLabel,
      emptyMsg,
      totals: await lib.countf0cks(),
      log_user_ips: getLogUserIps(),
      tmp: null
    };

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      res.setHeader('X-Total-Count', total.toString());
      res.setHeader('X-Total-Label', totalLabel);
      res.setHeader('X-Empty-Msg', emptyMsg);
      res.setHeader('X-Has-More', (users.length === limit).toString());
      return res.reply({
        body: tpl.render("admin/users_list", data, req)
      });
    }

    res.reply({
      body: tpl.render("admin/users", data, req)
    });
  });

  router.post(/^\/api\/v2\/admin\/users\/activate\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id } = req.post;
      if (!user_id) throw new Error('Missing user_id');

      const result = await db`
        UPDATE "user" 
        SET activated = true, activation_token = NULL 
        WHERE id = ${+user_id} AND login != 'deleted_user'
        RETURNING login
      `;

      if (!result.length) throw new Error('User not found');

      // Log it in audit
      await audit.log(req.session.id, 'manual_verify_user', 'user', +user_id, { target_login: result[0].login });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: true,
        msg: 'User ' + result[0].login + ' manually verified.'
      }));
    } catch (err) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/users\/set-password\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id, password } = req.post;
      if (!user_id || !password) throw new Error('Missing user_id or password');
      if (password.length < 20) throw new Error('Password must be at least 20 characters');

      const hash = await lib.hash(password);
      const updateResult = await db`UPDATE "user" SET password = ${hash}, force_password_change = true WHERE id = ${+user_id} AND login != 'deleted_user' RETURNING id`;
      
      if (!updateResult.length) throw new Error('User not found or account is protected.');

      // Invalidate existing sessions
      await db`DELETE FROM "user_sessions" WHERE user_id = ${+user_id}`;

      // Log it in audit
      await audit.log(req.session.id, 'admin_reset_password', 'user', +user_id);

      const response = { success: true, msg: 'Password updated and user forced to change on next login.' };
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    } catch (err) {
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/users\/set-role\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id, role } = req.post;
      if (!user_id) throw new Error('Missing user_id');
      if (!['user', 'mod', 'admin'].includes(role)) throw new Error('Invalid role. Must be user, mod, or admin.');

      // Fetch target
      const target = await db`SELECT id, login FROM "user" WHERE id = ${+user_id} LIMIT 1`;
      if (!target.length) throw new Error('User not found.');
      if (target[0].login === 'deleted_user') throw new Error('The deleted_user account is protected.');

      // Prevent self-demotion
      if (+user_id === req.session.id && role !== 'admin') {
        throw new Error('You cannot change your own role away from admin.');
      }

      const isAdmin = role === 'admin';
      const isMod   = role === 'mod';

      await db`
        UPDATE "user"
        SET admin = ${isAdmin}, is_moderator = ${isMod}
        WHERE id = ${+user_id}
      `;

      // Invalidate sessions so permissions refresh on next login
      await db`DELETE FROM user_sessions WHERE user_id = ${+user_id}`;

      await audit.log(req.session.id, 'admin_set_role', 'user', +user_id, {
        target_login: target[0].login,
        role
      });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: true,
        role,
        msg: `Role for "${target[0].login}" set to ${role}.`
      }));
    } catch (err) {
      console.error('[ADMIN] Set role failed:', err);
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/users\/set-groups\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id, groups } = req.post;
      if (!user_id) throw new Error('Missing user_id');
      const target = await db`SELECT id, login FROM "user" WHERE id = ${+user_id} LIMIT 1`;
      if (!target.length) throw new Error('User not found.');

      let groupsArr = [];
      if (Array.isArray(groups)) {
        groupsArr = groups.map(s => String(s).trim().toLowerCase()).filter(Boolean);
      } else if (typeof groups === 'string') {
        groupsArr = groups.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      }

      await db`
        UPDATE "user"
        SET groups = ${groupsArr}
        WHERE id = ${+user_id}
      `;

      // Invalidate target user's session cache and session table so new groups load immediately
      await db`DELETE FROM user_sessions WHERE user_id = ${+user_id}`;

      await audit.log(req.session.id, 'admin_set_groups', 'user', +user_id, {
        target_login: target[0].login,
        groups: groupsArr
      });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: true,
        groups: groupsArr,
        msg: `Groups for "${target[0].login}" updated to: ${groupsArr.join(', ') || 'none'}`
      }));
    } catch (err) {
      console.error('[ADMIN] Set groups failed:', err);
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });


  router.post(/^\/api\/v2\/admin\/users\/lock-layout\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id, mode, lock } = req.post;
      if (!user_id) throw new Error('Missing user_id');


      const isLocked = lock === true || lock === 'true' || lock === 1;
      const targetMode = parseInt(mode, 10);

      const updateData = { force_comment_display_mode: isLocked ? 1 : 0 };
      if (!isNaN(targetMode)) updateData.comment_display_mode = targetMode;

      const result = await db`
        UPDATE user_options 
        SET ${db(updateData)}
        WHERE user_id = ${+user_id}
        RETURNING user_id
      `;

      if (!result.length) throw new Error('User options not found');

      // Log it in audit
      await audit.log(req.session.id, isLocked ? 'lock_user_layout' : 'unlock_user_layout', 'user', +user_id, { mode: targetMode });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: true,
        msg: 'User layout ' + (isLocked ? 'locked' : 'unlocked') + '.',
        force_comment_display_mode: isLocked ? 1 : 0,
        comment_display_mode: targetMode
      }));
    } catch (err) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  // The system ghost that deleted users' content is reassigned to. It can never log in: password '!'
  // matches no hash, it is not activated and it is banned (the unban route refuses to touch it).
  const ensureGhostUser = async () => {
    let ghost = await db`SELECT id FROM "user" WHERE login = 'deleted_user' LIMIT 1`;
    if (ghost.length) return ghost;
    await db`
      INSERT INTO "user" (login, "user", password, admin, is_moderator, activated, banned, ban_reason, created_at)
      VALUES ('deleted_user', 'deleted_user', '!', false, false, false, true, 'System account', now())
      ON CONFLICT (login) DO NOTHING
    `;
    ghost = await db`SELECT id FROM "user" WHERE login = 'deleted_user' LIMIT 1`;
    if (!ghost.length) throw new Error('Could not create the "deleted_user" ghost account.');
    await db`
      INSERT INTO user_options (user_id, mode, theme, fullscreen, avatar, avatar_file, display_name)
      VALUES (${ghost[0].id}, 0, 'amoled', 0, null, 'default.png', 'deleted user')
      ON CONFLICT (user_id) DO NOTHING
    `;
    return ghost;
  };

  router.post(/^\/api\/v2\/admin\/users\/delete\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id } = req.post;
      if (!user_id) throw new Error('Missing user_id');

      // Get target user info
      const target = await db`SELECT id, login, "user" FROM "user" WHERE id = ${+user_id} LIMIT 1`;
      if (!target.length) throw new Error('User not found');
      if (target[0].login === 'deleted_user') throw new Error('The deleted_user account is protected and cannot be deleted.');

      // Get deleted_user info (created on first use, so it never takes an id before the admin)
      const ghost = await ensureGhostUser();

      const targetId = target[0].id;
      const targetLogin = target[0].login;
      const targetUser = target[0].user;
      const ghostId = ghost[0].id;

      // START TRANSACTION
      await db.begin(async sql => {
        // 1. Reassign intellectual content (items, comments, tags)
        await sql`UPDATE items SET username = 'deleted_user' WHERE username ILIKE ${targetLogin} OR username ILIKE ${targetUser}`;
        await sql`UPDATE comments SET user_id = ${ghostId} WHERE user_id = ${targetId}`;
        await sql`UPDATE tags_assign SET user_id = ${ghostId} WHERE user_id = ${targetId}`;

        // 2. Reassign social/admin content (tokens, reports, messages, warnings, logs)
        await sql`UPDATE invite_tokens SET used_by = ${ghostId} WHERE used_by = ${targetId}`;
        await sql`UPDATE invite_tokens SET created_by = ${ghostId} WHERE created_by = ${targetId}`;
        await sql`UPDATE reports SET user_id = ${ghostId} WHERE user_id = ${targetId}`;
        await sql`UPDATE reports SET reporter_id = ${ghostId} WHERE reporter_id = ${targetId}`;
        await sql`UPDATE reports SET resolved_by = ${ghostId} WHERE resolved_by = ${targetId}`;
        await sql`UPDATE private_messages SET sender_id = ${ghostId} WHERE sender_id = ${targetId}`;
        await sql`UPDATE private_messages SET recipient_id = ${ghostId} WHERE recipient_id = ${targetId}`;
        await sql`UPDATE user_warnings SET user_id = ${ghostId} WHERE user_id = ${targetId}`;
        await sql`UPDATE user_warnings SET admin_id = ${ghostId} WHERE admin_id = ${targetId}`;
        
        // Fetch and reassign halls with collision detection
        const userHalls = await sql`SELECT * FROM user_halls WHERE user_id = ${targetId}`;
        const ghostHalls = await sql`SELECT slug FROM user_halls WHERE user_id = ${ghostId}`;
        const ghostSlugs = new Set(ghostHalls.map(h => h.slug));
        const CUSTOM_DIR = path.join(cfg.paths.s, '../hall_custom');

        for (const hall of userHalls) {
          let finalSlug = hall.slug;
          if (ghostSlugs.has(hall.slug)) {
            finalSlug = `${hall.slug}-from-${targetId}`;
            while (ghostSlugs.has(finalSlug)) {
              finalSlug = `${hall.slug}-from-${targetId}-${crypto.randomBytes(2).toString('hex')}`;
            }
          }
          ghostSlugs.add(finalSlug);

          if (hall.custom_image) {
            // F-004 Security: Sanitize slugs before constructing file paths
            const safeSlug = path.basename(hall.slug);
            const safeFinalSlug = path.basename(finalSlug);
            const oldPath = path.join(CUSTOM_DIR, `u_${targetId}_${safeSlug}.webp`);
            const newPath = path.join(CUSTOM_DIR, `u_${ghostId}_${safeFinalSlug}.webp`);
            try {
              await fs.rename(oldPath, newPath);
            } catch (e) {
              console.warn(`[ADMIN_DELETE] Failed to move hall image: ${oldPath} -> ${newPath}`, e.message);
            }
          }
          await sql`UPDATE user_halls SET user_id = ${ghostId}, slug = ${finalSlug} WHERE id = ${hall.id}`;
        }

        await sql`UPDATE halls_assign SET user_id = ${ghostId} WHERE user_id = ${targetId}`;
        await sql`UPDATE user_halls_assign SET user_id = ${ghostId} WHERE user_id = ${targetId}`;
        try { await sql`UPDATE audit_log SET user_id = ${ghostId} WHERE user_id = ${targetId}`; } catch (e) {}

        // 3. Purge personal metadata and ephemeral data (sessions, options, pubkeys, views, subscriptions, favorites, etc)
        await sql`DELETE FROM user_sessions WHERE user_id = ${targetId}`;
        await sql`DELETE FROM user_options WHERE user_id = ${targetId}`;
        await sql`DELETE FROM user_pubkeys WHERE user_id = ${targetId}`;
        await sql`DELETE FROM user_video_views WHERE user_id = ${targetId}`;
        await sql`DELETE FROM comment_subscriptions WHERE user_id = ${targetId}`;
        await sql`DELETE FROM user_conversation_states WHERE user_id = ${targetId} OR other_id = ${targetId}`;
        await sql`DELETE FROM notifications WHERE user_id = ${targetId}`;
        await sql`DELETE FROM favorites WHERE user_id = ${targetId}`;
        await sql`DELETE FROM link_token WHERE user_id = ${targetId}`;
        await sql`DELETE FROM discord_queue WHERE user_id = ${targetId}`;

        // 4. Delete the user record itself
        await sql`DELETE FROM "user" WHERE id = ${targetId}`;
      });

      // Log it in audit
      await audit.log(req.session.id, 'admin_delete_user', 'user', targetId, { target_login: targetLogin });

      const response = { success: true, msg: 'User ' + targetLogin + ' deleted and content reassigned to deleted_user.' };
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    } catch (err) {
      console.error('[ADMIN] Deletion failed:', err);
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/users\/reassign-uploads\/?$/, lib.auth, async (req, res) => {
    try {
      const { source_user_id, source_username, target_username } = req.post;
      if (!source_user_id && !source_username) throw new Error('Missing source_user_id or source_username');
      if (!target_username || !target_username.trim()) throw new Error('Missing target_username');

      // Resolve source user (registered or ghost)
      let sourceLogin, sourceUser;
      if (source_user_id) {
        const source = await db`SELECT id, login, "user" FROM "user" WHERE id = ${+source_user_id} LIMIT 1`;
        if (!source.length) throw new Error('Source user not found');
        if (source[0].login === 'deleted_user') throw new Error('Cannot reassign uploads from the protected deleted_user account.');
        sourceLogin = source[0].login;
        sourceUser = source[0].user;
      } else {
        // Ghost/legacy user — just use the username directly
        sourceLogin = source_username.trim();
        sourceUser = source_username.trim();
      }

      // Resolve target user
      const target = await db`SELECT id, login, "user" FROM "user" WHERE login ILIKE ${target_username.trim()} LIMIT 1`;
      if (!target.length) throw new Error('Target user "' + target_username.trim() + '" not found');

      const targetLogin = target[0].login;
      const targetId = target[0].id;

      if (source_user_id && +source_user_id === targetId) throw new Error('Source and target user are the same.');

      // Reassign all items
      const result = await db`
        UPDATE items
        SET username = ${targetLogin}
        WHERE username ILIKE ${sourceLogin} OR username ILIKE ${sourceUser}
      `;

      // Log in audit
      await audit.log(req.session.id, 'admin_reassign_uploads', 'user', source_user_id ? +source_user_id : null, {
        source_login: sourceLogin,
        target_login: targetLogin,
        target_id: targetId,
        count: result.count
      });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: true,
        count: result.count,
        msg: `Successfully reassigned ${result.count} uploads from ${sourceLogin} to ${targetLogin}.`
      }));
    } catch (err) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/users\/bulk-delete-items\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id, username } = req.post;
      if (!user_id && !username) throw new Error('Missing user_id or username');

      let login, user;
      if (user_id) {
        const target = await db`SELECT login, "user" FROM "user" WHERE id = ${+user_id} LIMIT 1`;
        if (target.length) {
          login = target[0].login;
          user = target[0].user;
        }
      } 
      
      if (!login && username) {
        login = username;
        user = username;
      }

      if (!login) throw new Error('User not found');

      // Mark all items as deleted and inactive
      const result = await db`
        UPDATE items 
        SET is_deleted = true, active = false 
        WHERE username ILIKE ${login} OR username ILIKE ${user}
      `;

      // Log it in audit
      await audit.log(req.session.id, 'admin_bulk_delete_items', 'user', user_id ? +user_id : null, { target_login: login, count: result.count });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ 
        success: true, 
        count: result.count,
        msg: `Successfully marked ${result.count} items as deleted.`
      }));
    } catch (err) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/users\/bulk-delete-comments\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id } = req.post;
      if (!user_id) throw new Error('Missing user_id');

      const result = await db`DELETE FROM comments WHERE user_id = ${+user_id}`;

      // Log it in audit
      await audit.log(req.session.id, 'admin_bulk_delete_comments', 'user', +user_id, { count: result.count });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ 
        success: true, 
        count: result.count,
        msg: `Successfully deleted ${result.count} comments.`
      }));
    } catch (err) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/users\/reset-login-attempts\/?$/, lib.auth, async (req, res) => {
    try {
      const { username } = req.post;
      if (!username) throw new Error('Missing username');

      // Clear attempts for this specific username
      await security.clearAttempts(null, username);

      // Attempt to find ID for audit if possible
      const target = await db`SELECT id FROM "user" WHERE login = ${username} LIMIT 1`;
      await audit.log(req.session.id, 'admin_reset_login_attempts', 'user', target.length ? target[0].id : null, { target_login: username });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ 
        success: true, 
        msg: `Successfully reset login attempts for ${username}.`
      }));
    } catch (err) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/users\/bulk-delete-halls\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id } = req.post;
      if (!user_id) throw new Error('Missing user_id');

      // 1. Get all hall slugs for this user to clean up images
      const halls = await db`SELECT slug FROM user_halls WHERE user_id = ${+user_id}`;
      
      // 2. Perform DB deletion
      const result = await db`DELETE FROM user_halls WHERE user_id = ${+user_id}`;
      // user_halls_assign has no user_id, it is linked via hall_id.
      // cascading deletes should handle the assignments if set up, 
      // but let's be safe and ensure no orphans if linked by user_id elsewhere
      await db`DELETE FROM user_halls_assign WHERE user_id = ${+user_id}`;

      // 3. Clean up custom hall images on disk
      const CUSTOM_DIR = path.join(cfg.paths.s, '../hall_custom');
      for (const h of halls) {
        const imgPath = path.join(CUSTOM_DIR, `u_${+user_id}_${h.slug}.webp`);
        await fs.unlink(imgPath).catch(() => {});
      }

      // Log it in audit
      await audit.log(req.session.id, 'admin_bulk_delete_halls', 'user', +user_id, { count: result.count });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ 
        success: true, 
        count: result.count,
        msg: `Successfully deleted ${result.count} halls and all assignments.`
      }));
    } catch (err) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });


  router.post(/^\/api\/v2\/admin\/users\/rename\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id, new_username } = req.post;
      if (!user_id) throw new Error('Missing user_id');
      if (!new_username || !new_username.trim()) throw new Error('Missing new_username');

      const newName = new_username.trim();

      // Validate format (same rules as registration)
      if (!/^[a-zA-Z0-9._-]+$/.test(newName)) {
        throw new Error('Invalid username. Only A-Z, 0-9, _, -, and . are allowed.');
      }
      if (newName.length < 2 || newName.length > 32) {
        throw new Error('Username must be between 2 and 32 characters.');
      }

      // Get current user info
      const target = await db`SELECT id, login, "user" FROM "user" WHERE id = ${+user_id} LIMIT 1`;
      if (!target.length) throw new Error('User not found');
      if (target[0].login === 'deleted_user') throw new Error('The deleted_user account is protected and cannot be renamed.');

      const oldLogin = target[0].login;
      const oldUser = target[0].user;
      const newLogin = newName.toLowerCase();

      if (newLogin === oldLogin && newName === oldUser) throw new Error('New username is the same as the current one.');

      // Check for conflicts
      const conflict = await db`SELECT id FROM "user" WHERE (lower(login) = ${newLogin} OR lower("user") = lower(${newName})) AND id != ${+user_id} LIMIT 1`;
      if (conflict.length) throw new Error(`Username "${newName}" is already taken.`);

      await db.begin(async sql => {
        // 1. Update the user record
        await sql`UPDATE "user" SET login = ${newLogin}, "user" = ${newName} WHERE id = ${+user_id}`;

        // 2. Update items.username (matches both old login and old display name)
        await sql`UPDATE items SET username = ${newLogin} WHERE username ILIKE ${oldLogin} OR username ILIKE ${oldUser}`;

        // 3. Clear old login_attempts so the new name starts clean
        await sql`DELETE FROM login_attempts WHERE username = ${oldLogin}`;
      });

      // Invalidate all sessions so the user must re-log with the new name
      await db`DELETE FROM user_sessions WHERE user_id = ${+user_id}`;

      // Log it in audit
      await audit.log(req.session.id, 'admin_rename_user', 'user', +user_id, {
        old_login: oldLogin,
        new_login: newLogin,
        old_user: oldUser,
        new_user: newName
      });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: true,
        new_login: newLogin,
        new_user: newName,
        msg: `User renamed from "${oldLogin}" to "${newLogin}". All uploads updated. Sessions invalidated.`
      }));
    } catch (err) {
      console.error('[ADMIN] Rename failed:', err);
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/users\/create\/?$/, lib.auth, async (req, res) => {
    try {
      let { username, email, password, role } = req.post;
      if (!username || !username.trim()) throw new Error('Username is required.');
      username = username.trim();

      if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
        throw new Error('Username contains invalid characters. Only A-Z, 0-9, _, -, and . are allowed.');
      }
      if (username.length < 2 || username.length > 32) {
        throw new Error('Username must be between 2 and 32 characters.');
      }
      if (!password || password.length < 20) {
        throw new Error('Password must be at least 20 characters long.');
      }

      // Check for existing user
      const existing = await db`
        SELECT id FROM "user"
        WHERE lower(login) = lower(${username}) OR lower("user") = lower(${username})
        ${email ? db`OR (email IS NOT NULL AND lower(email) = lower(${email}))` : db``}
        LIMIT 1
      `;
      if (existing.length) throw new Error('Username or email is already taken.');

      const isAdmin = role === 'admin';
      const isMod   = role === 'mod';
      const hash = await lib.hash(password);
      const ts = ~~(Date.now() / 1e3);

      const { getDefaultLayout } = await import('../settings.mjs');

      const newUser = await db`
        INSERT INTO "user" (login, password, "user", created_at, admin, is_moderator, email, activated, activation_token)
        VALUES (
          ${username.toLowerCase()}, ${hash}, ${username},
          to_timestamp(${ts}), ${isAdmin}, ${isMod},
          ${email || null}, true, NULL
        )
        RETURNING id, login
      `;
      const userId = newUser[0].id;

      await db`
        INSERT INTO user_options (user_id, mode, theme, fullscreen, avatar, avatar_file, use_new_layout, disable_autoplay, disable_swiping, use_alternative_infobox)
        VALUES (${userId}, 3, 'amoled', 0, NULL, 'default.png', ${getDefaultLayout() === 'modern'}, ${cfg.websrv.enable_autoplay === false}, ${cfg.websrv.enable_swiping === false}, ${cfg.websrv.user_alternative_infobox !== false})
      `;

      await audit.log(req.session.id, 'admin_create_user', 'user', userId, {
        new_login: username.toLowerCase(),
        role: role || 'user'
      });

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: true,
        user_id: userId,
        username: username.toLowerCase(),
        msg: `User "${username.toLowerCase()}" created successfully.`
      }));
    } catch (err) {
      console.error('[ADMIN] Create user failed:', err);
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  // About page text editor
  router.get(/^\/admin\/about\/?$/, lib.auth, async (req, res) => {
    const settings = await db`SELECT value FROM site_settings WHERE key = 'about_text' LIMIT 1`;
    const about_text = settings.length > 0 ? settings[0].value : '';
    res.reply({
      body: tpl.render("admin/about", {
        session: req.session,
        about_text: about_text,
        totals: await lib.countf0cks(),
        tmp: null
      }, req)
    });
  });

  router.post(/^\/admin\/about\/?$/, lib.auth, async (req, res) => {
    try {
      const about_text = req.post?.about_text ?? '';
      await db`INSERT INTO site_settings (key, value) VALUES ('about_text', ${about_text}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      setAboutText(about_text);

      await audit.log(req.session.id, 'update_about_text', 'system', null);

      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: true });
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }
      return res.writeHead(302, { "Location": "/admin/about" }).end();
    } catch (err) {
      console.error('[ADMIN] About Save failed:', err);
      const msg = 'Failed to save about text: ' + err.message;
      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: false, msg });
        return res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }
      return res.reply({ code: 500, body: msg });
    }
  });

  // Rules page text editor
  router.get(/^\/admin\/rules\/?$/, lib.auth, async (req, res) => {
    const settings = await db`SELECT value FROM site_settings WHERE key = 'rules_text' LIMIT 1`;
    const rules_text = settings.length > 0 ? settings[0].value : '';
    res.reply({
      body: tpl.render("admin/rules", {
        session: req.session,
        rules_text: rules_text,
        totals: await lib.countf0cks(),
        tmp: null
      }, req)
    });
  });

  router.post(/^\/admin\/rules\/?$/, lib.auth, async (req, res) => {
    try {
      const rules_text = req.post?.rules_text ?? '';
      await db`INSERT INTO site_settings (key, value) VALUES ('rules_text', ${rules_text}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      setRulesText(rules_text);

      await audit.log(req.session.id, 'update_rules_text', 'system', null);

      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: true });
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }
      return res.writeHead(302, { "Location": "/admin/rules" }).end();
    } catch (err) {
      console.error('[ADMIN] Rules Save failed:', err);
      const msg = 'Failed to save rules text: ' + err.message;
      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: false, msg });
        return res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }
      return res.reply({ code: 500, body: msg });
    }
  });

  // Terms page text editor
  router.get(/^\/admin\/terms\/?$/, lib.auth, async (req, res) => {
    const settings = await db`SELECT value FROM site_settings WHERE key = 'terms_text' LIMIT 1`;
    const terms_text = settings.length > 0 ? settings[0].value : '';
    res.reply({
      body: tpl.render("admin/terms", {
        session: req.session,
        terms_text: terms_text,
        totals: await lib.countf0cks(),
        tmp: null
      }, req)
    });
  });

  router.post(/^\/admin\/terms\/?$/, lib.auth, async (req, res) => {
    try {
      const terms_text = req.post?.terms_text ?? '';
      await db`INSERT INTO site_settings (key, value) VALUES ('terms_text', ${terms_text}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      setTermsText(terms_text);

      await audit.log(req.session.id, 'update_terms_text', 'system', null);

      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: true });
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }
      return res.writeHead(302, { "Location": "/admin/terms" }).end();
    } catch (err) {
      console.error('[ADMIN] Terms Save failed:', err);
      const msg = 'Failed to save terms text: ' + err.message;
      if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
        const body = JSON.stringify({ success: false, msg });
        return res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
      }
      return res.reply({ code: 500, body: msg });
    }
  });

  // Set display name (stylized nick overlay)
  router.post(/^\/api\/v2\/admin\/users\/set-display-name\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id, display_name } = req.post;
      if (!user_id) throw new Error('Missing user_id');

      const target = await db`SELECT login, "user" FROM "user" WHERE id = ${+user_id} AND login != 'deleted_user' LIMIT 1`;
      if (!target.length) throw new Error('User not found or account is protected.');

      const trimmed = (display_name || '').trim();

      await db`
        INSERT INTO user_options (user_id, display_name, mode, theme, excluded_tags)
        VALUES (${+user_id}, ${trimmed || null}, 0, ${'4d'}, ${[]}::integer[])
        ON CONFLICT (user_id) DO UPDATE SET display_name = ${trimmed || null}
      `;

      await audit.log(req.session.id, 'admin_set_display_name', 'user', +user_id, {
        target_login: target[0].login,
        display_name: trimmed || null
      });

      const response = { success: true, display_name: trimmed || null, msg: trimmed ? `Display name set to "${trimmed}"` : 'Display name cleared.' };

      // Notify the target user's live session so their navbar updates instantly
      db.notify('profile_update', JSON.stringify({
        user_id: +user_id,
        user: target[0].user,
        display_name: trimmed || null
      })).catch(() => {});

      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
    } catch (err) {
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: err.message }));
    }
  });

  // Hall Manager
  router.get(/^\/admin\/halls\/?$/, lib.modAuth, async (req, res) => {
    const hallsList = await f0cklib.getHalls();
    res.reply({
      body: tpl.render('admin/halls', {
        session: req.session,
        hallsList,
        tmp: null
      }, req)
    });
  });

  // Chat Manager
  router.get(/^\/admin\/chat\/?$/, lib.auth, async (req, res) => {
    if (!cfg.websrv.enable_global_chat) {
      return res.redirect("/admin");
    }
    res.reply({
      body: tpl.render('admin/chat', {
        session: req.session,
        totals: await lib.countf0cks(),
        tmp: null
      }, req)
    });
  });

  // Koepfe Manager
  router.get(/^\/admin\/koepfe\/?$/, lib.auth, async (req, res) => {
    res.reply({
      body: tpl.render('admin/koepfe', { session: req.session, tmp: null }, req)
    });
  });

  router.get(/^\/api\/v2\/admin\/koepfe\/?$/, lib.auth, async (req, res) => {
    try {
      const fs = (await import('fs')).promises;
      const path = await import('path');
      const kDir = cfg.paths.koepfe;
      const files = await fs.readdir(kDir).catch(() => []);
      const koepfeFiles = files.filter(f => /\.(png|jpe?g|gif|webp|avif)$/i.test(f)).map(f => ({
          filename: f,
          url: '/s/koepfe/' + f
      }));
      if (res.json) return res.json({ koepfe: koepfeFiles });
      return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({ koepfe: koepfeFiles }));
    } catch (e) {
      if (res.json) return res.json({ success: false, msg: e.message });
      return res.writeHead(500, {'Content-Type': 'application/json'}).end(JSON.stringify({ success: false, msg: e.message }));
    }
  });

  router.post(/^\/api\/v2\/admin\/koepfe\/delete\/?$/, lib.auth, async (req, res) => {
    try {
      const { filename } = req.post || req.body || {};
      if (!filename || filename.includes('..') || filename.includes('/')) throw new Error('Invalid filename');
      const fs = (await import('fs')).promises;
      const path = await import('path');
      await fs.unlink(path.join(cfg.paths.koepfe, filename));
      if (res.json) return res.json({ success: true });
      return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({ success: true }));
    } catch (e) {
      if (res.json) return res.json({ success: false, msg: e.message });
      return res.writeHead(500, {'Content-Type': 'application/json'}).end(JSON.stringify({ success: false, msg: e.message }));
    }
  });

  // ── Admin Bar: User Impersonation ────────────────────────────────────────────

  // GET /api/v2/admin/users/search?q=  — autocomplete for the admin bar "View as" input
  router.get(/^\/api\/v2\/admin\/users\/search\/?$/, lib.adminAuth, async (req, res) => {
    try {
      const q = (req.url.qs?.q || '').trim();
      if (!q || q.length < 1) {
        if (res.json) return res.json([]);
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
      }
      const escaped = lib.escapeLike(q);
      const users = await db`
        SELECT id, login as user
        FROM "user"
        WHERE login ILIKE ${'%' + escaped + '%'}
          AND activated = true
          AND banned = false
        ORDER BY login ASC
        LIMIT 10
      `;
      const result = users.map(u => ({ id: u.id, user: u.user }));
      if (res.json) return res.json(result);
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (e) {
      if (res.json) return res.json({ success: false, msg: e.message });
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: e.message }));
    }
  });

  // POST /api/v2/admin/impersonate  — start impersonating a user
  router.post(/^\/api\/v2\/admin\/impersonate\/?$/, lib.adminAuth, async (req, res) => {
    try {
      const { username } = req.post;
      if (!username) throw new Error('Username required');

      const target = await db`
        SELECT id, login as user
        FROM "user"
        WHERE login = ${username.toLowerCase().trim()}
          AND activated = true
        LIMIT 1
      `;
      if (target.length === 0) throw new Error('User not found');
      if (target[0].id === req.session.id) throw new Error('Cannot impersonate yourself');

      // Build signed payload: base64(JSON) + "." + HMAC
      const crypto = (await import('crypto')).default || await import('crypto');
      const secret = lib.impersonationSecret();
      const payload = Buffer.from(JSON.stringify({
        uid: target[0].id,
        orig: lib.sha256(req.cookies.session),
        ts: Date.now()
      })).toString('base64url');
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const cookieVal = `${payload}.${sig}`;

      const cookieOpts = lib.getCookieOptions('Fri, 31 Dec 9999 23:59:59 GMT');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `impersonate=${cookieVal}; ${cookieOpts}`
      }).end(JSON.stringify({ success: true, username: target[0].user }));
    } catch (e) {
      if (res.json) return res.json({ success: false, msg: e.message });
      return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: e.message }));
    }
  });

  // POST /api/v2/admin/stop-impersonate  — exit impersonation
  router.post(/^\/api\/v2\/admin\/stop-impersonate\/?$/, async (req, res) => {
    // No auth guard needed — just clear the cookie
    const cookieOpts = lib.getCookieOptions('Thu, 01 Jan 1970 00:00:00 GMT');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `impersonate=; ${cookieOpts}`
    }).end(JSON.stringify({ success: true }));
  });

  return router;
}

