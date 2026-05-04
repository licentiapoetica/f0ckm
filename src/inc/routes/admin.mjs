import db from "../sql.mjs";
import audit from "../audit.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";

import lib from "../lib.mjs";
import { setMotd } from "../motd.mjs";
import { setAboutText, setRulesText, setTermsText } from "../page_texts.mjs";
import { exec } from "child_process";
import { promises as fs } from "fs";
import cfg from "../config.mjs";
import security from "../security.mjs";
import crypto from "crypto";
import path from "path";
import { getManualApproval, setManualApproval, getMinTags, setMinTags, getRegistrationOpen, setRegistrationOpen, getTrustedUploads, setTrustedUploads, getEnablePdf, setEnablePdf } from "../settings.mjs";

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

    if (!password || password.length < 20) {
      return fail("Invalid username or password.");
    }

    if (await security.isRateLimited(ip, username, 'login')) {
      const msg = "Too many attempts.";
      if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      }
      return res.reply({ code: 429, body: msg });
    }

    const user = await db`
      select id, password, activated, banned, ban_reason, ban_expires, force_password_change
      from "user"
      where "login" = ${username.toLowerCase()} or lower(email) = lower(${username.trim()})
      limit 1
    `;

    const fail = async (msg) => {
      await security.recordAttempt(ip, username, 'login', false);
      // Artificial delay to prevent timing attacks and slow down brute-force
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
      }
      return res.reply({ body: tpl.render("login", { error: msg, theme: req.theme }) });
    };

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
        return fail(`You are banned! reason: ${reason} expire: ${expires}`);
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
      kmsi: typeof req.post.kmsi !== 'undefined' ? 1 : 0
    };

    await db`
      insert into "user_sessions" ${db(blah, 'user_id', 'session', 'csrf_token', 'browser', 'created_at', 'last_used', 'last_action', 'kmsi')
      }
    `;

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

    const user = (await db`select id, login from "user" where lower(email) = lower(${email.trim()}) limit 1`)[0];
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

    if (!user) {
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

    const user = (await db`select id from "user" where reset_token = ${token} and reset_expires > now() limit 1`)[0];
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

    res.reply({
      body: tpl.render("admin", {
        totals: await lib.countf0cks(),
        session: req.session,
        manual_approval: getManualApproval(),
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
    await db`delete from invite_tokens where id = ${req.post.id}`;
    if (res.json) return res.json({ success: true });
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
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
            ban_expires = null
        where id = ${+user_id}
      `;

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

  // User Management Routes
  router.get(/^\/admin\/users\/?$/, lib.auth, async (req, res) => {
    const q = req.url.qs?.q || '';
const page = Math.max(1, parseInt(req.url.qs?.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const users = await db`
      WITH filtered_users AS (
          SELECT 
              u.id, u.login, u.user, u.email, u.created_at, u.banned, u.is_moderator, u.admin, u.activated,
              uo.avatar_file, uo.display_name, uo.force_comment_display_mode, uo.comment_display_mode,
              (SELECT token FROM invite_tokens WHERE used_by = u.id ORDER BY created_at DESC LIMIT 1) as reg_method
          FROM "user" u
          LEFT JOIN user_options uo ON uo.user_id = u.id
          ${q ? db`WHERE u.login ILIKE ${'%' + lib.escapeLike(q) + '%'} OR u.user ILIKE ${'%' + lib.escapeLike(q) + '%'} OR u.email ILIKE ${'%' + lib.escapeLike(q) + '%'}` : db``}
      ),
      ghost_users AS (
          SELECT 
              NULL::int as id, i.username as login, i.username as "user", 'Legacy Account' as email, 
              to_timestamp(MIN(i.stamp)) as created_at, false as banned, false as is_moderator, false as admin, true as activated,
              NULL::text as avatar_file, NULL::varchar as display_name, 0 as force_comment_display_mode, 0 as comment_display_mode, 'Legacy' as reg_method
          FROM items i
          WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.login = i.username OR u.user = i.username)
          ${q ? db`AND (i.username ILIKE ${'%' + lib.escapeLike(q) + '%'})` : db``}
          GROUP BY i.username
      ),
      all_users AS (
          SELECT * FROM filtered_users
          UNION ALL
          SELECT * FROM ghost_users
      ),
      paginated_users AS (
          SELECT * FROM all_users
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
        ${q ? db`WHERE u.login ILIKE ${'%' + lib.escapeLike(q) + '%'} OR u.user ILIKE ${'%' + lib.escapeLike(q) + '%'} OR u.email ILIKE ${'%' + lib.escapeLike(q) + '%'}` : db``}
    `;
    const totalCountGhost = await db`
        SELECT COUNT(DISTINCT i.username) as c
        FROM items i
        WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.login = i.username OR u.user = i.username)
        ${q ? db`AND (i.username ILIKE ${'%' + lib.escapeLike(q) + '%'})` : db``}
    `;
    const total = parseInt(totalCountActual[0].c) + parseInt(totalCountGhost[0].c);

    const data = {
      session: req.session,
      users,
      q,
      page,
      total,
      hasMore: users.length === limit,
      totals: await lib.countf0cks(),
      tmp: null
    };

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      res.setHeader('X-Total-Count', total.toString());
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

  router.post(/^\/api\/v2\/admin\/users\/delete\/?$/, lib.auth, async (req, res) => {
    try {
      const { user_id } = req.post;
      if (!user_id) throw new Error('Missing user_id');

      // Get target user info
      const target = await db`SELECT id, login, "user" FROM "user" WHERE id = ${+user_id} LIMIT 1`;
      if (!target.length) throw new Error('User not found');
      if (target[0].login === 'deleted_user') throw new Error('The deleted_user account is protected and cannot be deleted.');

      // Get deleted_user info
      const ghost = await db`SELECT id FROM "user" WHERE login = 'deleted_user' LIMIT 1`;
      if (!ghost.length) throw new Error('Ghost account "deleted_user" not found. Please run migration.');

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
    res.reply({
      body: tpl.render('admin/chat', {
        session: req.session,
        totals: await lib.countf0cks(),
        tmp: null
      }, req)
    });
  });

  return router;
}
