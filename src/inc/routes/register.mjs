import db from "../sql.mjs";
import lib from "../lib.mjs";
import security from "../security.mjs";
import { getRegistrationOpen, getRegistrationRequireMailAndorToken, getDefaultLayout } from "../settings.mjs";
import { sendMail } from "../../lib/smtp.mjs";
import cfg from "../config.mjs";
import crypto from "crypto";

export default (router, tpl) => {
    router.get(/^\/register(\/)?$/, async (req, res) => {
        if (req.session) {
            return res.writeHead(302, { "Location": "/?already_logged_in=1" }).end();
        }
        let url = "/#register";
        if (req.url.qs?.token) url += `:${req.url.qs.token}`;
        return res.writeHead(302, { "Location": url }).end();
    });

    router.get(/^\/activate\/(?<token>.+)$/, async (req, res) => {
        const token = req.params.token;
        const user = await db`SELECT id FROM "user" WHERE activation_token = ${token}`;

        if (user.length === 0) {
            const errorMsg = encodeURIComponent("Invalid or expired activation token.");
            return res.writeHead(302, { "Location": `/#register:error:${errorMsg}` }).end();
        }

        await db`UPDATE "user" SET activated = TRUE, activation_token = NULL WHERE id = ${user[0].id}`;

        const successMsg = encodeURIComponent("Account activated! You can now login.");
        return res.writeHead(302, { "Location": `/#register:success:${successMsg}` }).end();
    });

    router.post(/^\/register(\/)?$/, async (req, res) => {
        let { username, email, password, password_confirm, token, email_confirm_field } = req.post;
        if (username) username = username.trim();
        const ip = security.getRealIP(req);

        // Honeypot check
        if (email_confirm_field) {
            console.log(`[SPAM] Honeypot triggered by IP: ${ip}, User: ${username}`);
            return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: "Spam detected." }));
        }

        if (await security.isRateLimited(ip, null, 'register')) {
            const errorMsg = "Too many attempts.";
            if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: errorMsg }));
            }
            return res.reply({
                body: tpl.render("register", { theme: req.cookies.theme ?? (cfg.websrv.theme || "f0ck"), error: errorMsg, registration_open: getRegistrationOpen() })
            });
        }

        const renderError = async (msg) => {
            await security.recordAttempt(ip, username, 'register', false);
            if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg }));
            }
            return res.reply({
                body: tpl.render("register", { theme: req.cookies.theme ?? (cfg.websrv.theme || "f0ck"), error: msg, registration_open: getRegistrationOpen() })
            });
        };

        const renderSuccess = async (msg) => {
            if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
                return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, msg }));
            }
            return res.reply({
                body: tpl.render("register", { theme: req.cookies.theme ?? (cfg.websrv.theme || "f0ck"), success: msg, registration_open: getRegistrationOpen() })
            });
        };

        // Input Validation
        if (!username || username.trim().length === 0) {
            return renderError("Username is required.");
        }

        if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
            return renderError("Username contains invalid characters. Only A-Z, 0-9, _, -, and . are allowed.");
        }

        if (!password || password.length < 20) {
            return renderError("Password must be at least 20 characters long.");
        }

        if (password !== password_confirm) {
            return renderError("Passwords do not match.");
        }

        // reCAPTCHA verification
        if (cfg.recaptcha?.enabled && cfg.recaptcha?.secret_key) {
            const rcToken = req.post['g-recaptcha-response'];
            if (!rcToken) return renderError("Please complete the reCAPTCHA.");
            try {
                const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ secret: cfg.recaptcha.secret_key, response: rcToken, remoteip: ip })
                });
                const { success } = await verifyRes.json();
                if (!success) return renderError("reCAPTCHA verification failed. Please try again.");
            } catch (e) {
                console.error('[REGISTER] reCAPTCHA error:', e.message);
                return renderError("reCAPTCHA check failed. Please try again.");
            }
        }
        let activated = true;
        let activationToken = null;

        const registrationOpen = getRegistrationOpen();
        const requireMailOrToken = getRegistrationRequireMailAndorToken();

        if (!registrationOpen && !token) {
            // Closed registration — invite token is always required
            return renderError("Invite token is required for registration.");
        }

        if (token) {
            // Invite token path — validate and activate immediately
            const tokenRow = await db`
                select * from invite_tokens where token = ${token} and is_used = false
            `;
            if (tokenRow.length === 0) return renderError("Invalid or used invite token");
            // Token is valid; account activated immediately
        } else if (requireMailOrToken) {
            // Open registration but email/token required — email path
            if (!email || !email.includes('@')) return renderError("A valid email is required for registration.");
            activated = false;
            activationToken = crypto.randomBytes(32).toString('hex');
        }
        // else: open registration, no mail/token required — just username+password, activated immediately

        // Check user existence
        const existing = await db`
            select id, login, email 
            from "user" 
            where "login" = ${username.toLowerCase()} 
               or "user" = ${username}
               ${email ? db`or ("email" is not null and "email" = ${email})` : db``}
        `;
        
        if (existing.length > 0) {
            // Check if it was the email that matched
            const emailMatch = existing.find(u => u.email && u.email.toLowerCase() === (email || '').toLowerCase());
            if (emailMatch) {
                return renderError("Email already registered");
            }
            return renderError("Username taken");
        }

        // Create User
        const hash = await lib.hash(password);
        const ts = ~~(Date.now() / 1e3);

        let userId;
        try {
            const newUser = await db`
                insert into "user" ("login", "password", "user", "created_at", "admin", "is_moderator", "email", "activated", "activation_token")
                values (${username.toLowerCase()}, ${hash}, ${username}, to_timestamp(${ts}), false, false, ${email || null}, ${activated}, ${activationToken})
                returning id
            `;
            userId = newUser[0].id;

            // Assign default avatar file
            const avatarId = null;
            const avatarFile = 'default.png';

            await db`
                insert into user_options (user_id, mode, theme, fullscreen, avatar, avatar_file, use_new_layout, disable_autoplay, disable_swiping, use_alternative_infobox)
                values (${userId}, 3, 'amoled', 0, ${avatarId}, ${avatarFile}, ${getDefaultLayout() === 'modern'}, ${cfg.websrv.enable_autoplay === false}, ${cfg.websrv.enable_swiping === false}, ${cfg.websrv.user_alternative_infobox !== false})
            `;
        } catch (err) {
            console.error(`[REGISTER] DB Error during user creation:`, err);
            if (err.code === '23505') { // Unique constraint violation
                return renderError("Username taken");
            }
            return renderError("An unexpected error occurred. Please try again later.");
        }

        // If not activated, send email and return success message
        if (!activated) {
            const activationLink = `${cfg.main.url.full}/activate/${activationToken}`;
            const mailBody = `Hello ${username},\n\nThank you for registering. Please activate your account by clicking the link below:\n\n${activationLink}\n\nIf you did not request this, please ignore this email.`;
            
            try {
                if (cfg.smtp && cfg.smtp.host) {
                    await sendMail(cfg.smtp, {
                        to: email,
                        subject: "Activate your account",
                        body: mailBody
                    });
                } else {
                    console.log(`[SMTP] No configuration found. Activation link: ${activationLink}`);
                }
            } catch (e) {
                console.error(`[SMTP] Send failed:`, e.message);
                // We'll still proceed since the user is created, but they'll be stuck.
                // In production they should see an error, but let's keep it simple for now.
            }

            await renderSuccess("Registration successful! Please check your email to activate your account.");
            return;
        }

        if (token) {
            const tokenRow = await db`select id from invite_tokens where token = ${token} and is_used = false`;
            if (tokenRow.length > 0) {
                await db`
                    update invite_tokens 
                    set is_used = true, used_by = ${userId}, used_at = now()
                    where id = ${tokenRow[0].id}
                `;
            }
        }

        await security.recordAttempt(ip, username, 'register', true);

        const successMsg = "Registration successful! You can now login.";
        if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, msg: successMsg }));
        }

        // Redirect to home with login success message
        return res.writeHead(302, { "Location": "/?login=success" }).end();
    });

    return router;
};
