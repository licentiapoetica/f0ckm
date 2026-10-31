import db from '../../sql.mjs';
import lib from '../../lib.mjs';
import cfg from '../../config.mjs';
import security from '../../security.mjs';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { canAnonDo, isAnonSession } from '../../settings.mjs';
import {
  generateChallenge, consumeChallenge,
  verifyRegistration, verifyAuthentication,
  buildRegistrationOptions, buildAuthenticationOptions,
  base64url, getRpIdFromHost, aaguidProvider
} from '../../webauthn.mjs';

// Passkey-only accounts store this instead of a hash; lib.verify never matches it
const PASSWORD_DISABLED = '!';
const LAST_PASSKEY_MSG = 'This is your last passkey and password login is disabled. Set a password first, or add another passkey.';
const IN_USE_PASSKEY_MSG = 'This passkey is the one you are signed in with right now and cannot be removed from this session.';
// The passkey the current session was opened with (null: password login or an older session)
const sessionPasskey = async (req) => {
  if (!req.session?.sess_id) return null;
  const [row] = await db`select passkey_credential_id from user_sessions where id = ${+req.session.sess_id}`;
  return row?.passkey_credential_id || null;
};
// True when removing a passkey would leave a passkey-only account with no way to log in
const isLastPasskeyOfPasskeyOnly = async (userId) => {
  const [row] = await db`
    select (u.password = ${PASSWORD_DISABLED}) as disabled,
           (select count(*)::int from passkey_credentials pc where pc.user_id = u.id) as n
    from "user" u where u.id = ${+userId}
  `;
  return !!row && row.disabled && row.n <= 1;
};

// Note: Avatar upload/delete is handled by middleware in index.mjs via avatar_handler.mjs
// These routes remain for other settings API endpoints

export default router => {
  router.group(/^\/api\/v2\/settings/, group => {
    group.put(/\/setAvatar/, lib.registeredUser, async (req, res) => {
      if (!req.post.avatar) {
        return res.json({
          msg: 'no avatar provided',
          debug: req.post
        }, 400); // bad request
      }

      const avatar = +req.post.avatar;

      const itemid = (await db`
        select id
        from "items"
        where id = ${+avatar} and active = true
      `)?.[0]?.id;

      if (!itemid) {
        return res.json({
          msg: 'itemid not found'
        }, 404); // not found
      }

      const q = await db`
        update "user_options" set ${db({
        avatar
      }, 'avatar')
        }
        where user_id = ${+req.session.id}
      `;

      return res.json({
        msg: q
      }, 200);
    });

    // Switch to custom avatar (sets avatar ID to 0 so avatar_file is used)
    group.put(/\/useCustomAvatar/, lib.registeredUser, async (req, res) => {
      // Check if user has a custom avatar file
      const userOpts = (await db`
        select avatar_file from user_options where user_id = ${+req.session.id}
      `)[0];

      if (!userOpts?.avatar_file) {
        return res.json({
          success: false,
          msg: 'No custom avatar uploaded'
        }, 400);
      }

      // Set avatar to 0 so avatar_file takes priority
      await db`
        update user_options 
        set avatar = 0
        where user_id = ${+req.session.id}
      `;

      return res.json({
        success: true,
        avatar_file: userOpts.avatar_file,
        msg: 'Switched to custom avatar'
      }, 200);
    });

    group.get(/\/excluded_tags/, lib.loggedin, async (req, res) => {
      if (isAnonSession(req.session) && !canAnonDo('exclude_tags')) {
        return res.json({ success: false, msg: 'Tag exclusion is disabled for anonymous users' }, 403);
      }
      const tags = await db`
        select t.id, t.tag, t.normalized
        from unnest((select excluded_tags from user_options where user_id = ${+req.session.id})) as et(id)
        join tags t on t.id = et.id
      `;
      return res.json({ success: true, tags }, 200);
    });

    group.post(/\/excluded_tags/, lib.loggedin, async (req, res) => {
      if (isAnonSession(req.session) && !canAnonDo('exclude_tags')) {
        return res.json({ success: false, msg: 'Tag exclusion is disabled for anonymous users' }, 403);
      }
      const tagname = req.post?.tagname || req.body?.tagname;
      const tagId = req.post?.tag_id || req.body?.tag_id;
      if (!tagname && !tagId) return res.json({ success: false, msg: 'No tag provided' }, 400);

      const tag = tagId
        ? (await db`select id, tag, normalized from tags where id = ${+tagId}`)[0]
        : (await db`select id, tag, normalized from tags where normalized = slugify(${tagname}) or tag = ${tagname}`)[0];

      if (!tag) return res.json({ success: false, msg: 'Tag not found' }, 404);

      await db`
        update user_options 
        set excluded_tags = array_append(coalesce(excluded_tags, '{}'), ${tag.id})
        where user_id = ${+req.session.id} and not (${tag.id} = any(coalesce(excluded_tags, '{}')))
      `;

      if (req.session) {
        if (!req.session.excluded_tags) req.session.excluded_tags = [];
        if (!req.session.excluded_tags.includes(tag.id)) {
          req.session.excluded_tags.push(tag.id);
        }
      }

      // Return updated list
      const tags = await db`
        select t.id, t.tag, t.normalized
        from unnest((select excluded_tags from user_options where user_id = ${+req.session.id})) as et(id)
        join tags t on t.id = et.id
      `;

      return res.json({ success: true, tags, tag }, 200);
    });

    group.delete(/\/excluded_tags\/(?<tag>.+)/, lib.loggedin, async (req, res) => {
      if (isAnonSession(req.session) && !canAnonDo('exclude_tags')) {
        return res.json({ success: false, msg: 'Tag exclusion is disabled for anonymous users' }, 403);
      }
      const tagParam = decodeURIComponent(req.params.tag);
      const isNum = /^\d+$/.test(tagParam);
      const tag = isNum
        ? (await db`select id, tag, normalized from tags where id = ${+tagParam}`)[0]
        : (await db`select id, tag, normalized from tags where normalized = slugify(${tagParam}) or tag = ${tagParam}`)[0];

      if (!tag) return res.json({ success: false, msg: 'Tag not found' }, 404);

      await db`
        update user_options 
        set excluded_tags = array_remove(coalesce(excluded_tags, '{}'), ${tag.id})
        where user_id = ${+req.session.id}
      `;

      if (req.session && req.session.excluded_tags) {
        req.session.excluded_tags = req.session.excluded_tags.filter(id => id !== tag.id);
      }

      const tags = await db`
        select t.id, t.tag, t.normalized
        from unnest((select excluded_tags from user_options where user_id = ${+req.session.id})) as et(id)
        join tags t on t.id = et.id
      `;

      return res.json({ success: true, tags, tag }, 200);
    });

    // Generic Token Generation (default type=discord if not specified, though frontend should specify)
    group.post(/\/link\/token/, lib.registeredUser, async (req, res) => {
      // 6-char alphanumeric code
      const token = Math.random().toString(36).substring(2, 8).toUpperCase();
      const type = req.post.type || 'discord'; // Default to discord for backward compatibility if needed

      try {
        await db`
          INSERT INTO link_token (user_id, token) VALUES (${req.session.id}, ${token})
          ON CONFLICT (token) DO UPDATE SET token = EXCLUDED.token
        `;
        return res.json({ success: true, token, type }, 200);
      } catch (e) {
        console.error('Token gen error:', e);
        // Fallback for schema if link_token doesn't have type yet (optional, but good for safety)
        // If migration failed or not applied to link_token... wait, check schema for link_token first.
        // Schema for link_token: user_id, token, created_at. NO TYPE.
        // Ah, I need to add 'type' to link_token too OR just rely on the bot to know which type it is verifying?
        // Actually, the bot trigger knows its type. When !link <token> is sent to Discord bot, it checks token.
        // If I use same table for both, a token generated for Matrix could be used on Discord if not careful.
        // It's safer to add type to link_token OR just rely on who claims it.
        // If I don't add type to link_token, then a token is just "allow linking".
        // If I send !link TOKEN to Matrix bot, it links Matrix account.
        // If I send !link TOKEN to Discord bot, it links Discord account.
        // This seems fine without adding type to link_token, because the USER triggers the action on the specific platform.
        // So I will stick to the existing schema for link_token for now to avoid another migration if possible.
        // BUT, I should check if I really need date restriction or type.
        // Let's keep it simple: Token is just a key. Authenticated user generated it.
        // Whoever consumes it (Discord bot or Matrix bot) links THEIR account to that user_id.
        // So NO CHANGE needed for link_token table schema.

        // Reverting to original simple insert (ignoring type in DB, just returning it for frontend convenience if needed)
        await db`
          INSERT INTO link_token (user_id, token) VALUES (${req.session.id}, ${token})
          ON CONFLICT (token) DO UPDATE SET token = EXCLUDED.token
        `;
        return res.json({ success: true, token, type }, 200);
      }
    });

    // Get linked accounts (Discord & Matrix)
    group.get(/\/link\/accounts/, lib.registeredUser, async (req, res) => {
      try {
        const aliases = await db`
          SELECT alias, type FROM user_alias 
          WHERE userid = ${req.session.id}
          ORDER BY type DESC, alias ASC
        `;
        // Sanitize aliases
        const sanitized = aliases.map(a => ({
          alias: a.alias.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
          type: a.type || 'discord' // Default to discord if null (though migration sets default)
        }));
        return res.json({ success: true, aliases: sanitized }, 200);
      } catch (e) {
        console.error('Get linked error:', e);
        return res.json({ success: false, msg: 'Error fetching linked accounts' }, 500);
      }
    });

    // Unlink account
    group.delete(/\/link\/unlink\/(?<type>[a-z]+)\/(?<alias>.+)/, lib.registeredUser, async (req, res) => {
      try {
        const alias = decodeURIComponent(req.params.alias);
        const type = req.params.type;
        
        const result = await db`
          DELETE FROM user_alias 
          WHERE lower(alias) = lower(${alias}) 
          AND userid = ${req.session.id}
          AND type = ${type}
          RETURNING alias
        `;

        if (result.length > 0) {
          return res.json({ success: true, msg: 'Account unlinked' }, 200);
        } else {
          return res.json({ success: false, msg: 'Account not found' }, 404);
        }
      } catch (e) {
        console.error('Unlink error:', e);
        return res.json({ success: false, msg: 'Error unlinking account' }, 500);
      }
    });

    // Backward compatibility routes for Discord (Deprecated)
    // Discord Token Generation (Redirect to generic)
    group.post(/\/discord\/token/, lib.registeredUser, async (req, res) => {
       // Just call the logic inline
       const token = Math.random().toString(36).substring(2, 8).toUpperCase();
       try {
        await db`
          INSERT INTO link_token (user_id, token) VALUES (${req.session.id}, ${token})
          ON CONFLICT (token) DO UPDATE SET token = EXCLUDED.token
        `;
        return res.json({ success: true, token }, 200);
      } catch (e) { return res.json({ success: false }, 500); }
    });

    // Get linked Discord accounts (Legacy)
    group.get(/\/discord\/linked/, lib.registeredUser, async (req, res) => {
      const aliases = await db`SELECT alias FROM user_alias WHERE userid = ${req.session.id} AND type = 'discord'`;
      return res.json({ success: true, aliases: aliases.map(a => ({ alias: a.alias })) }, 200);
    });

    // Unlink Discord account (Legacy)
    group.delete(/\/discord\/unlink\/(?<alias>.+)/, lib.registeredUser, async (req, res) => {
        const alias = decodeURIComponent(req.params.alias);
        await db`DELETE FROM user_alias WHERE lower(alias) = lower(${alias}) AND userid = ${req.session.id} AND type = 'discord'`;
        return res.json({ success: true, msg: 'Account unlinked' }, 200);
    });

    // Update MOTD visibility preference
    group.put(/\/motd/, lib.loggedin, async (req, res) => {
      const show = req.post.show === true || req.post.show === 'true';

      try {
        await db`
          update user_options 
          set show_motd = ${show}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.show_motd = show;
        return res.json({ success: true, show }, 200);
      } catch (e) {
        console.error('Update MOTD pref error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update Autoplay (on load) preference
    group.put(/\/autoplay/, lib.loggedin, async (req, res) => {
      const disable_autoplay = req.post.disable_autoplay === true || req.post.disable_autoplay === 'true';

      try {
        await db`
          update user_options 
          set disable_autoplay = ${disable_autoplay}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.disable_autoplay = disable_autoplay;
        return res.json({ success: true, disable_autoplay }, 200);
      } catch (e) {
        console.error('Update Autoplay pref error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update Swiping preference
    group.put(/\/swiping/, lib.loggedin, async (req, res) => {
      const disable_swiping = req.post.disable_swiping === true || req.post.disable_swiping === 'true';

      try {
        await db`
          update user_options 
          set disable_swiping = ${disable_swiping}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.disable_swiping = disable_swiping;
        return res.json({ success: true, disable_swiping }, 200);
      } catch (e) {
        console.error('Update Swiping pref error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update New Layout visibility preference
    group.put(/\/layout/, lib.loggedin, async (req, res) => {
      const use_new_layout = req.post.use_new_layout === true || req.post.use_new_layout === 'true';

      try {
        await db`
          update user_options 
          set use_new_layout = ${use_new_layout}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.use_new_layout = use_new_layout;
        return res.json({ success: true, use_new_layout }, 200);
      } catch (e) {
        console.error('Update Layout pref error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update Favorites Privacy preference
    group.put(/\/favorites_private/, lib.loggedin, async (req, res) => {
      const favorites_private = req.post.favorites_private === true || req.post.favorites_private === 'true';

      try {
        await db`
          update user_options 
          set favorites_private = ${favorites_private}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.favorites_private = favorites_private;
        return res.json({ success: true, favorites_private }, 200);
      } catch (e) {
        console.error('Update Favorites Privacy pref error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update Hide Fav Badge preference
    group.put(/\/hide_fav_badge/, lib.loggedin, async (req, res) => {
      const hide_fav_badge = req.post.hide_fav_badge === true || req.post.hide_fav_badge === 'true';

      try {
        await db`
          update user_options 
          set hide_fav_badge = ${hide_fav_badge}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.hide_fav_badge = hide_fav_badge;
        return res.json({ success: true, hide_fav_badge }, 200);
      } catch (e) {
        console.error('Update Hide Fav Badge pref error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update Default Upload Visibility preference
    group.put(/\/default_upload_visibility/, lib.registeredUser, async (req, res) => {
      if (cfg.allow_user_upload_visibility === false || cfg.websrv?.allow_user_upload_visibility === false) {
        return res.json({ success: false, msg: 'Custom upload visibility is disabled by the administrator' }, 403);
      }
      const vis = parseInt(req.post.default_upload_visibility, 10);
      if (isNaN(vis) || ![0, 1, 2].includes(vis)) {
        return res.json({ success: false, msg: 'Invalid visibility option' }, 400);
      }

      try {
        await db`
          update user_options 
          set default_upload_visibility = ${vis}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.default_upload_visibility = vis;
        return res.json({ success: true, default_upload_visibility: vis }, 200);
      } catch (e) {
        console.error('Update Default Upload Visibility pref error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update Username Color preference
    group.put(/\/username_color/, lib.registeredUser, async (req, res) => {
      const { color } = req.post;

      if (!color || !/^#([0-9A-F]{3}){1,2}$/i.test(color)) {
        return res.json({ success: false, msg: 'Invalid color format' }, 400);
      }

      try {
        await db`
          update user_options 
          set username_color = ${color}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.username_color = color;
        
        const payloadStr = JSON.stringify({
            user_id: req.session.id,
            user: req.session.user,
            username_color: color
        });
        await db`select pg_notify('profile_update', ${payloadStr})`;
        
        return res.json({ success: true, color }, 200);
      } catch (e) {
        console.error('Update Username Color error:', e);
        return res.json({ success: false, msg: 'Error updating color' }, 500);
      }
    });

    /**
     * POST /api/v2/settings/password/disable
     * Passkey-only account: switch off password login. Needs the current password (a hijacked session
     * alone can't lock the owner out) and at least one passkey. Setting a new password re-enables it.
     */
    group.post(/\/password\/disable$/, lib.registeredUser, async (req, res) => {
      try {
        const { current_password } = req.post || {};
        const user = (await db`select password from "user" where id = ${+req.session.id}`)[0];
        if (!user) return res.json({ success: false, msg: 'User not found' }, 404);
        if (user.password === PASSWORD_DISABLED) return res.json({ success: false, msg: 'Password login is already disabled' }, 400);
        if (!current_password || !(await lib.verify(current_password, user.password))) {
          return res.json({ success: false, msg: 'Incorrect current password' }, 401);
        }
        const [{ n }] = await db`select count(*)::int as n from passkey_credentials where user_id = ${+req.session.id}`;
        if (n < 1) return res.json({ success: false, msg: 'Add a passkey first, otherwise you could not log in anymore' }, 400);

        await db`update "user" set password = ${PASSWORD_DISABLED}, force_password_change = false where id = ${+req.session.id}`;
        // Sessions elsewhere may have been opened with the password: end them, keep this one
        await db`delete from "user_sessions" where user_id = ${+req.session.id} and id != ${+req.session.sess_id}`;
        await db`delete from login_attempts where username = ${req.session.login}`.catch(() => {});
        return res.json({ success: true, msg: 'Password login disabled. Use your passkey to sign in.' });
      } catch (err) {
        console.error('[SETTINGS] Disable password error:', err);
        return res.json({ success: false, msg: 'Failed to disable password' }, 500);
      }
    });

    // Update password
    group.put(/\/password/, lib.registeredUser, async (req, res) => {
      const { current_password, new_password, new_password_confirm } = req.post;
      
      if (!new_password || !new_password_confirm) {
        return res.json({ success: false, msg: 'New password and confirmation are required' }, 400);
      }

      const user = (await db`select password, force_password_change from "user" where id = ${+req.session.id}`)[0];
      if (!user) return res.json({ success: false, msg: 'User not found' }, 404);

      // Passkey-only accounts have no current password: setting one turns password login back on
      const passwordDisabled = user.password === PASSWORD_DISABLED;
      if (!user.force_password_change && !passwordDisabled) {
        if (!current_password) {
          return res.json({ success: false, msg: 'Current password is required' }, 400);
        }
        const valid = await lib.verify(current_password, user.password);
        if (!valid) {
          return res.json({ success: false, msg: 'Incorrect current password' }, 401);
        }
      }

      if (new_password !== new_password_confirm) {
        return res.json({ success: false, msg: 'New passwords do not match' }, 400);
      }

      if (new_password.length < 20) {
        return res.json({ success: false, msg: 'New password must be at least 20 characters long' }, 400);
      }

      const hash = await lib.hash(new_password);
      await db`update "user" set password = ${hash}, force_password_change = false where id = ${+req.session.id}`;
      
      // Clear flag in session too
      if (req.session) req.session.force_password_change = false;

      // Invalidate all other sessions (Issue 21 fix)
      await db`delete from "user_sessions" where user_id = ${+req.session.id} and id != ${+req.session.sess_id}`;

      return res.json({ success: true, msg: 'Password updated successfully' }, 200);
    });

    // Update email
    group.put(/\/email/, lib.registeredUser, async (req, res) => {
      const { email } = req.post;
      if (!email || !email.trim()) return res.json({ success: false, msg: 'Email is required' }, 400);
      const cleanEmail = email.trim();
      if (!cleanEmail.includes('@')) return res.json({ success: false, msg: 'Invalid email address' }, 400);

      // Check if email is already taken by another user
      const existing = await db`
        select id from "user" 
        where lower(email) = lower(${cleanEmail}) 
        and id != ${+req.session.id}
        limit 1
      `;

      if (existing.length > 0) {
        return res.json({ success: false, msg: 'Email already in use' }, 400);
      }

      await db`update "user" set email = ${cleanEmail} where id = ${+req.session.id}`;
      return res.json({ success: true, msg: 'Email updated successfully' }, 200);
    });

    // Update Display Name
    group.put(/\/display_name/, lib.registeredUser, async (req, res) => {
      const { display_name } = req.post;

      if (display_name !== undefined && typeof display_name !== 'string') {
        return res.json({ success: false, msg: 'Invalid display name format' }, 400);
      }

      const cleanDisplayName = display_name ? display_name.trim().substring(0, 32) : null;

      try {
        await db`
          update user_options 
          set display_name = ${cleanDisplayName}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.display_name = cleanDisplayName;
        
        const payloadStr = JSON.stringify({
            user_id: req.session.id,
            user: req.session.user,
            display_name: cleanDisplayName
        });
        await db`select pg_notify('profile_update', ${payloadStr})`;
        
        return res.json({ success: true, display_name: cleanDisplayName, msg: 'Display name updated successfully' }, 200);
      } catch (e) {
        console.error('Update Display Name error:', e);
        return res.json({ success: false, msg: 'Error updating display name' }, 500);
      }
    });

    // Update Description
    group.put(/\/description/, lib.registeredUser, async (req, res) => {
      if (!cfg.websrv.enable_profile_description) {
        return res.json({ success: false, msg: 'Profile descriptions are disabled' }, 403);
      }
      const { description } = req.post;

      if (description !== undefined && typeof description !== 'string') {
        return res.json({ success: false, msg: 'Invalid description format' }, 400);
      }

      const cleanDescription = description ? description.trim().substring(0, 2000) : null;

      try {
        await db`
          update user_options 
          set description = ${cleanDescription}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.description = cleanDescription;

        const payloadStr = JSON.stringify({
            user_id: req.session.id,
            user: req.session.user,
            description: cleanDescription
        });
        await db`select pg_notify('profile_update', ${payloadStr})`;

        return res.json({ success: true, description: cleanDescription }, 200);
      } catch (e) {
        console.error('Update Description error:', e);
        return res.json({ success: false, msg: 'Error updating description' }, 500);
      }
    });

    // Update Font preference
    group.put(/\/font/, lib.loggedin, async (req, res) => {
      const { font } = req.post;

      // F-023 Security: Validate font against actual files on disk
      // The font value is rendered into CSS url() in header.html, so it must be a real filename
      if (font) {
        const fontsDir = cfg.paths.fonts;
        try {
          const available = (await fs.readdir(fontsDir)).filter(f => /\.(ttf|otf|woff2?)$/i.test(f));
          if (!available.includes(font)) {
            return res.json({ success: false, msg: 'Invalid font selection' }, 400);
          }
        } catch {
          return res.json({ success: false, msg: 'Font directory unavailable' }, 500);
        }
      }

      try {
        await db`
          update user_options 
          set font = ${font || null}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.font = font || null;
        return res.json({ success: true, font: font || null }, 200);
      } catch (e) {
        console.error('Update Font error:', e);
        return res.json({ success: false, msg: 'Error updating font' }, 500);
      }
    });

    // Lightweight "who am I right now" endpoint — reads directly from DB (not session cache)
    // Used by the frontend to sync display_name after it may have been changed by an admin
    group.get(/\/me$/, lib.loggedin, async (req, res) => {
      const row = (await db`
        SELECT u.login, u.user, uo.display_name
        FROM "user" u
        LEFT JOIN user_options uo ON uo.user_id = u.id
        WHERE u.id = ${+req.session.id}
        LIMIT 1
      `)[0];
      if (!row) return res.json({ success: false }, 404);
      return res.json({
        success: true,
        login: row.login,
        user: row.user,
        display_name: row.display_name || null
      }, 200);
    });

    // Update min xD score filter preference
    group.put(/\/min_xd_score/, lib.loggedin, async (req, res) => {
      const raw = req.post.min_xd_score;
      const min_xd_score = parseInt(raw, 10);
      if (isNaN(min_xd_score) || min_xd_score < 0 || min_xd_score > 999) {
        return res.json({ success: false, msg: 'Invalid value: must be 0–999' }, 400);
      }
      try {
        await db`
          update user_options
          set min_xd_score = ${min_xd_score}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.min_xd_score = min_xd_score;
        return res.json({ success: true, min_xd_score }, 200);
      } catch (e) {
        console.error('Update min_xd_score error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update background blur preference
    group.put(/\/background/, lib.loggedin, async (req, res) => {
      const show_background = req.post.show_background === 'true' || req.post.show_background === true;
      try {
        await db`
          update user_options
          set show_background = ${show_background}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.show_background = show_background;
        return res.json({ success: true, show_background }, 200);
      } catch (e) {
        console.error('Update background error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update Ruffle (Flash) preferences
    group.put(/\/ruffle/, lib.loggedin, async (req, res) => {
      const ruffle_background = req.post.ruffle_background === 'true' || req.post.ruffle_background === true;
      const ruffle_volume = req.post.ruffle_volume !== undefined ? parseFloat(req.post.ruffle_volume) : undefined;

      if (ruffle_volume !== undefined && (isNaN(ruffle_volume) || ruffle_volume < 0 || ruffle_volume > 1)) {
        return res.json({ success: false, msg: 'Invalid volume: must be 0-1' }, 400);
      }

      try {
        const updateData = { ruffle_background };
        if (ruffle_volume !== undefined) updateData.ruffle_volume = ruffle_volume;

        await db`
          update user_options
          set ${db(updateData)}
          where user_id = ${+req.session.id}
        `;
        if (req.session) {
          req.session.ruffle_background = ruffle_background;
          if (ruffle_volume !== undefined) req.session.ruffle_volume = ruffle_volume;
        }
        return res.json({ success: true, ruffle_volume, ruffle_background }, 200);
      } catch (e) {
        console.error('Update Ruffle pref error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update quote_emojis preference (render :emoji: inside quote replies)
    group.put(/\/quote_emojis/, lib.loggedin, async (req, res) => {
      const quote_emojis = req.post.quote_emojis === true || req.post.quote_emojis === 'true';
      try {
        await db`
          update user_options
          set quote_emojis = ${quote_emojis}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.quote_emojis = quote_emojis;
        return res.json({ success: true, quote_emojis }, 200);
      } catch (e) {
        console.error('Update quote_emojis error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update embed_youtube_in_comments preference
    group.put(/\/embed_youtube_in_comments/, lib.loggedin, async (req, res) => {
      const embed_youtube_in_comments = req.post.embed_youtube_in_comments === true || req.post.embed_youtube_in_comments === 'true';
      try {
        await db`
          update user_options
          set embed_youtube_in_comments = ${embed_youtube_in_comments}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.embed_youtube_in_comments = embed_youtube_in_comments;
        return res.json({ success: true, embed_youtube_in_comments }, 200);
      } catch (e) {
        console.error('Update embed_youtube_in_comments error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update hide_koepfe preference (hide the Köpfe background images if enabled in config)
    group.put(/\/hide_koepfe/, lib.loggedin, async (req, res) => {
      const hide_koepfe = req.post.hide_koepfe === true || req.post.hide_koepfe === 'true';
      try {
        await db`
          update user_options
          set hide_koepfe = ${hide_koepfe}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.hide_koepfe = hide_koepfe;
        return res.json({ success: true, hide_koepfe }, 200);
      } catch (e) {
        console.error('Update hide_koepfe error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update alternative infobox preference (per-user toggle for the rich author block)
    group.put(/\/alternative_infobox/, lib.loggedin, async (req, res) => {
      const use_alternative_infobox = req.post.use_alternative_infobox === true || req.post.use_alternative_infobox === 'true';
      try {
        const mode = req.session.mode || 0;
        const theme = req.session.theme || cfg.websrv.theme || 'amoled';
        await db`
          insert into user_options (user_id, use_alternative_infobox, mode, theme)
          values (${+req.session.id}, ${use_alternative_infobox}, ${mode}, ${theme})
          on conflict (user_id) do update set
            use_alternative_infobox = excluded.use_alternative_infobox
        `;
        if (req.session) req.session.use_alternative_infobox = use_alternative_infobox;
        return res.json({ success: true, use_alternative_infobox }, 200);
      } catch (e) {
        console.error('Update alternative_infobox error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update alternative steuerung preference (per-user toggle for icon-only nav)
    group.put(/\/alternative_steuerung/, lib.loggedin, async (req, res) => {
      const use_alternative_steuerung = req.post.use_alternative_steuerung === true || req.post.use_alternative_steuerung === 'true';
      try {
        await db`
          update user_options
          set use_alternative_steuerung = ${use_alternative_steuerung}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.use_alternative_steuerung = use_alternative_steuerung;
        return res.json({ success: true, use_alternative_steuerung }, 200);
      } catch (e) {
        console.error('Update alternative_steuerung error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });


    // Update per-user language preference
    group.put(/\/language/, lib.loggedin, async (req, res) => {
      if (cfg.websrv.allow_language_change === false) {
        return res.json({ success: false, msg: 'Language change is disabled by the site administrator' }, 403);
      }
      const { language } = req.post;
      // NULL means "use site default"; only allow known locale codes
      const ALLOWED = ['en', 'de', 'nl', 'zange', null, ''];
      const lang = (language === '' || language === null || language === undefined) ? null : language;
      if (!ALLOWED.includes(lang)) {
        return res.json({ success: false, msg: 'Unsupported language' }, 400);
      }
      try {
        await db`
          update user_options
          set language = ${lang}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.language = lang;
        return res.json({ success: true, language: lang }, 200);
      } catch (e) {
        console.error('Update language error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update comment display mode preference
    group.put(/\/comment_display_mode/, lib.loggedin, async (req, res) => {
      const mode = parseInt(req.post.mode, 10);
      if (isNaN(mode) || (mode !== 0 && mode !== 1)) {
        return res.json({ success: false, msg: 'Invalid mode' }, 400);
      }
      
      // Check if mode is forced
      const forced = (await db`select force_comment_display_mode from user_options where user_id = ${+req.session.id}`)[0]?.force_comment_display_mode;
      if (forced) {
        return res.json({ success: false, msg: 'Comment layout is locked for your account.' }, 403);
      }

      try {
        await db`
          update user_options
          set comment_display_mode = ${mode}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.comment_display_mode = mode;
        return res.json({ success: true, mode }, 200);
      } catch (e) {
        console.error('Update comment_display_mode error:', e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // Update notification preferences (Consolidated Endpoint)
    group.post('/notifications', lib.loggedin, async (req, res) => {
      const { key, value } = req.post;
      const allowedKeys = ['receive_system_notifications', 'receive_user_notifications', 'do_not_disturb'];
      
      if (!allowedKeys.includes(key)) {
        return res.json({ success: false, msg: 'Invalid preference key' }, 400);
      }

      const boolValue = value === true || value === 'true';
      
      try {
        await db`
          update user_options
          set ${db({ [key]: boolValue }, key)}
          where user_id = ${+req.session.id}
        `;
        
        if (req.session) req.session[key] = boolValue;
        
        await db`SELECT pg_notify('profile_update', ${JSON.stringify({ user_id: req.session.id, [key]: boolValue })})`;
        
        return res.json({ success: true, [key]: boolValue }, 200);
      } catch (e) {
        console.error(`Update notification preference (${key}) error:`, e);
        return res.json({ success: false, msg: 'Error updating preference' }, 500);
      }
    });

    // --- Upload API Key Management ---

    // GET /api/v2/settings/api-key
    // Returns whether the user has an API key, when it was created, and the last 8 chars (masked preview).
    group.get(/\/api-key$/, lib.registeredUser, async (req, res) => {
      if (cfg.websrv.enable_user_api_keys === false) {
        return res.json({ success: false, msg: 'API keys are disabled' }, 403);
      }
      try {
        const row = (await db`
          SELECT api_key, created_at
          FROM user_api_keys
          WHERE user_id = ${+req.session.id}
          LIMIT 1
        `)[0];

        if (!row) {
          return res.json({ success: true, has_key: false }, 200);
        }

        return res.json({
          success: true,
          has_key: true,
          preview: `****${row.api_key.slice(-8)}`,
          created_at: row.created_at
        }, 200);
      } catch (e) {
        console.error('[API KEY] GET error:', e);
        return res.json({ success: false, msg: 'Error fetching API key' }, 500);
      }
    });

    // POST /api/v2/settings/api-key/regenerate
    // Generates a new key (or replaces an existing one). Returns the full key — only shown once.
    group.post(/\/api-key\/regenerate$/, lib.registeredUser, async (req, res) => {
      if (cfg.websrv.enable_user_api_keys === false) {
        return res.json({ success: false, msg: 'API keys are disabled' }, 403);
      }
      try {
        const newKey = crypto.randomBytes(32).toString('hex');

        await db`
          INSERT INTO user_api_keys (user_id, api_key, created_at)
          VALUES (${+req.session.id}, ${newKey}, now())
          ON CONFLICT (user_id) DO UPDATE
            SET api_key = EXCLUDED.api_key,
                created_at = now()
        `;

        return res.json({
          success: true,
          api_key: newKey,
          msg: 'API key generated. Copy it now — it will not be shown again in full.'
        }, 200);
      } catch (e) {
        console.error('[API KEY] Regenerate error:', e);
        return res.json({ success: false, msg: 'Error generating API key' }, 500);
      }
    });

    // DELETE /api/v2/settings/api-key
    // Revokes (deletes) the user's API key.
    group.delete(/\/api-key$/, lib.registeredUser, async (req, res) => {
      if (cfg.websrv.enable_user_api_keys === false) {
        return res.json({ success: false, msg: 'API keys are disabled' }, 403);
      }
      try {
        const result = await db`
          DELETE FROM user_api_keys
          WHERE user_id = ${+req.session.id}
          RETURNING user_id
        `;

        if (result.length === 0) {
          return res.json({ success: false, msg: 'No API key to revoke' }, 404);
        }

        return res.json({ success: true, msg: 'API key revoked' }, 200);
      } catch (e) {
        console.error('[API KEY] Delete error:', e);
        return res.json({ success: false, msg: 'Error revoking API key' }, 500);
      }
    });

    // GET /api/v2/settings/api-key/sharex-config
    // Downloads a pre-filled ShareX custom uploader (.sxcu) for the requesting user.
    group.get(/\/api-key\/sharex-config$/, lib.registeredUser, async (req, res) => {
      if (cfg.websrv.enable_user_api_keys === false) {
        return res.status(403).reply({ body: 'API keys are disabled' });
      }
      try {
        const row = (await db`
          SELECT api_key FROM user_api_keys
          WHERE user_id = ${+req.session.id}
          LIMIT 1
        `)[0];

        if (!row) {
          return res.status(404).reply({ body: 'No API key — generate one first in Settings.' });
        }

        // Determine a safe default rating for the ShareX config.
        // In shitpost mode the server accepts uploads without a rating, but
        // we still send 'sfw' so the item gets a rating tag by default.
        const defaultRating = 'sfw';

        const sxcu = {
          Version: '15.0.0',
          Name: cfg.main.url.domain,
          DestinationType: 'ImageUploader, FileUploader',
          RequestMethod: 'POST',
          RequestURL: `${cfg.main.url.full}/api/v2/upload`,
          Headers: {
            'X-Api-Key': row.api_key
          },
          Body: 'MultipartFormData',
          FileFormName: 'file',
          // The server requires a rating field. Without it every upload is rejected.
          // Users can change this value in ShareX's custom uploader settings.
          Parameters: {
            rating: defaultRating
          },
          // {json:file_url} maps to the direct file URL in the success response JSON
          URL: '{json:file_url}',
          ThumbnailURL: '{json:file_url}',
          ErrorMessage: '{response}'
        };

        const filename = `${cfg.main.url.domain}.sxcu`;
        const body = JSON.stringify(sxcu, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': Buffer.byteLength(body)
        }).end(body);
      } catch (e) {
        console.error('[API KEY] ShareX config error:', e);
        return res.status(500).reply({ body: 'Error generating config' });
      }
    });


    // --- User Invite System ---
    // Eligibility: ≥150 uploads, ≥30 days old, ≥66 comments, ≥200 tags
    // Slots: configurable (default 2), refresh 30 days after a token is used.

    const getInviteCriteria = () => {
      const ic = cfg.websrv.invite_criteria || {};
      return {
        uploads:  Number.isFinite(+ic.uploads)  ? +ic.uploads  : 150,
        age_days: Number.isFinite(+ic.age_days) ? +ic.age_days : 30,
        comments: Number.isFinite(+ic.comments) ? +ic.comments : 66,
        tags:     Number.isFinite(+ic.tags)     ? +ic.tags     : 200,
      };
    };

    const getInviteSlots = () => {
      const n = parseInt(cfg.websrv.user_invite_slots);
      return Number.isFinite(n) && n > 0 ? n : 2;
    };

    // GET /api/v2/settings/invites
    // Returns eligibility, criteria breakdown, tokens created by this user, and slot usage.
    group.get(/\/invites$/, lib.registeredUser, async (req, res) => {
      if (cfg.websrv.enable_user_invites === false) {
        return res.json({ success: false, msg: 'Invite system is disabled' }, 403);
      }
      try {
        const userId = +req.session.id;
        const username = req.session.user;
        const totalSlots = getInviteSlots();
        const refreshDays = 30;
        const isAdmin = !!req.session.admin;

        // Always fetch this user's token history
        const tokens = await db`
          SELECT
            it.id,
            it.token,
            it.is_used,
            it.used_at,
            it.created_at,
            u.user AS used_by_name
          FROM invite_tokens it
          LEFT JOIN "user" u ON u.id = it.used_by
          WHERE it.created_by = ${userId}
          ORDER BY it.created_at DESC
        `;

        let eligible, criteria, slotsConsumed, slotsAvailable;

        if (isAdmin) {
          // Admins bypass all criteria and slot limits
          eligible = true;
          criteria = null;
          slotsConsumed = 0;
          slotsAvailable = Infinity;
        } else {
          // Gather eligibility stats in one query
          const [stats] = await db`
            SELECT
              (SELECT COUNT(*) FROM items WHERE username = ${username} AND active = true AND is_deleted = false)::int AS upload_count,
              EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 86400 AS age_days,
              (SELECT COUNT(*) FROM comments WHERE user_id = ${userId} AND is_deleted = false)::int AS comment_count,
              (SELECT COUNT(*) FROM tags_assign WHERE user_id = ${userId})::int AS tag_count
            FROM "user" u
            WHERE u.id = ${userId}
          `;

          const INVITE_CRITERIA = getInviteCriteria();
          criteria = {
            uploads: { current: stats.upload_count, required: INVITE_CRITERIA.uploads, met: stats.upload_count >= INVITE_CRITERIA.uploads },
            age_days: { current: Math.floor(stats.age_days), required: INVITE_CRITERIA.age_days, met: stats.age_days >= INVITE_CRITERIA.age_days },
            comments: { current: stats.comment_count, required: INVITE_CRITERIA.comments, met: stats.comment_count >= INVITE_CRITERIA.comments },
            tags: { current: stats.tag_count, required: INVITE_CRITERIA.tags, met: stats.tag_count >= INVITE_CRITERIA.tags },
          };
          eligible = Object.values(criteria).every(c => c.met);

          // Slots consumed = tokens used within the last 30 days
          const cutoff = new Date(Date.now() - refreshDays * 24 * 60 * 60 * 1000);
          slotsConsumed = tokens.filter(t => t.is_used && t.used_at && new Date(t.used_at) > cutoff).length;
          slotsAvailable = Math.max(0, totalSlots - slotsConsumed);
        }

        return res.json({
          success: true,
          is_admin: isAdmin,
          eligible,
          criteria,
          tokens,
          slots_total: isAdmin ? null : totalSlots,
          slots_consumed: isAdmin ? null : slotsConsumed,
          slots_available: isAdmin ? null : slotsAvailable,
          refresh_days: refreshDays,
        }, 200);
      } catch (e) {
        console.error('[INVITES] GET error:', e);
        return res.json({ success: false, msg: 'Error fetching invite data' }, 500);
      }
    });

    // POST /api/v2/settings/invites/create
    // Generates a new invite token if eligible and slots remain.
    group.post(/\/invites\/create$/, lib.registeredUser, async (req, res) => {
      if (cfg.websrv.enable_user_invites === false) {
        return res.json({ success: false, msg: 'Invite system is disabled' }, 403);
      }
      try {
        const userId = +req.session.id;
        const username = req.session.user;
        const totalSlots = getInviteSlots();
        const refreshDays = 30;

        const isAdmin = !!req.session.admin;

        if (!isAdmin) {
          // Eligibility check
          const [stats] = await db`
            SELECT
              (SELECT COUNT(*) FROM items WHERE username = ${username} AND active = true AND is_deleted = false)::int AS upload_count,
              EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 86400 AS age_days,
              (SELECT COUNT(*) FROM comments WHERE user_id = ${userId} AND is_deleted = false)::int AS comment_count,
              (SELECT COUNT(*) FROM tags_assign WHERE user_id = ${userId})::int AS tag_count
            FROM "user" u WHERE u.id = ${userId}
          `;

          const INVITE_CRITERIA = getInviteCriteria();
          const eligible =
            stats.upload_count >= INVITE_CRITERIA.uploads &&
            stats.age_days >= INVITE_CRITERIA.age_days &&
            stats.comment_count >= INVITE_CRITERIA.comments &&
            stats.tag_count >= INVITE_CRITERIA.tags;

          if (!eligible) {
            return res.json({ success: false, msg: 'You do not meet the eligibility criteria' }, 403);
          }

          // Check available slots (used within last 30 days)
          const cutoff = new Date(Date.now() - refreshDays * 24 * 60 * 60 * 1000);
          const [{ slots_consumed }] = await db`
            SELECT COUNT(*)::int AS slots_consumed
            FROM invite_tokens
            WHERE created_by = ${userId}
              AND is_used = true
              AND used_at > ${cutoff}
          `;

          if (slots_consumed >= totalSlots) {
            return res.json({ success: false, msg: 'No invite slots available. Slots refresh 30 days after use.' }, 403);
          }
        }

        // Generate token
        const token = crypto.randomBytes(16).toString('hex').toUpperCase();
        await db`
          INSERT INTO invite_tokens (token, created_at, created_by)
          VALUES (${token}, ${~~(Date.now() / 1e3)}, ${userId})
        `;

        console.log(`[INVITES] User ${username} (${userId}) generated invite token ${token}`);
        return res.json({ success: true, token }, 200);
      } catch (e) {
        console.error('[INVITES] Create error:', e);
        return res.json({ success: false, msg: 'Error creating invite token' }, 500);
      }
    });

    // POST /api/v2/settings/invites/delete
    // Deletes an unused invite token owned by the calling user.
    group.post(/\/invites\/delete$/, lib.registeredUser, async (req, res) => {
      if (cfg.websrv.enable_user_invites === false) {
        return res.json({ success: false, msg: 'Invite system is disabled' }, 403);
      }
      try {
        const { id } = req.post;
        if (!id) return res.json({ success: false, msg: 'Missing token ID' }, 400);

        const result = await db`
          DELETE FROM invite_tokens
          WHERE id = ${+id}
            AND created_by = ${+req.session.id}
            AND is_used = false
          RETURNING id
        `;

        if (result.length === 0) {
          return res.json({ success: false, msg: 'Token not found or already used' }, 404);
        }

        return res.json({ success: true }, 200);
      } catch (e) {
        console.error('[INVITES] Delete error:', e);
        return res.json({ success: false, msg: 'Error deleting invite token' }, 500);
      }
    });


    // ─── Passkey Management (registered users) ──────────────────────────────

    /**
     * GET /api/v2/settings/passkeys
     * List the current user's registered passkeys.
     */
    group.get(/\/passkeys$/, lib.registeredUser, async (req, res) => {
      try {
        const rows = await db`
          SELECT id, credential_id, name, aaguid, created_at, last_used
          FROM passkey_credentials
          WHERE user_id = ${req.session.id}
          ORDER BY created_at DESC
        `;
        const inUse = await sessionPasskey(req);
        return res.json({
          success: true,
          passkeys: rows.map(r => ({ ...r, provider: aaguidProvider(r.aaguid), current: !!inUse && r.credential_id === inUse }))
        });
      } catch (err) {
        console.error('[PASSKEYS] List error:', err);
        return res.json({ success: false, msg: err.message }, 500);
      }
    });

    /**
     * POST /api/v2/settings/passkeys/register/begin
     * Generate WebAuthn registration options for a logged-in user.
     */
    group.post(/\/passkeys\/register\/begin$/, lib.registeredUser, async (req, res) => {
      try {
        // Get existing credentials to exclude (prevent re-registering same authenticator)
        const existing = await db`
          SELECT credential_id FROM passkey_credentials
          WHERE user_id = ${req.session.id}
        `;
        const excludeCredentials = existing.map(r => ({ id: r.credential_id, type: 'public-key' }));

        const challenge = generateChallenge({ type: 'user-register', userId: req.session.id });

        // User handle: SHA256 of user_id encoded as base64url (stable, opaque)
        const userHandle = base64url(
          crypto.createHash('sha256').update(String(req.session.id)).digest().slice(0, 16)
        );

        const body = req.post || req.body || {};
        const passkeyName = (body.name || '').trim().slice(0, 64) || null;

        const options = buildRegistrationOptions({
          challenge,
          userId: userHandle,
          userName: req.session.login || req.session.user,
          displayName: req.session.display_name || req.session.user,
          excludeCredentials,
          rpId: getRpIdFromHost(req.headers.host)
        });

        // Stash the intended passkey name in challenge metadata
        if (passkeyName) {
          // Re-consume and re-store with name (challenges are stored by their value)
          // Simpler: store name in a temporary Map keyed by challenge
          options._passkeyName = passkeyName;
        }

        return res.json({ success: true, options, passkey_name: passkeyName });
      } catch (err) {
        console.error('[PASSKEYS] register/begin error:', err);
        return res.json({ success: false, msg: err.message }, 500);
      }
    });

    /**
     * POST /api/v2/settings/passkeys/register/finish
     * Verify attestation and store new passkey for the logged-in user.
     */
    group.post(/\/passkeys\/register\/finish$/, lib.registeredUser, async (req, res) => {
      try {
        const body = req.post || req.body || {};
        const { challenge, clientDataJSON, attestationObject, credentialId, name } = body;

        if (!challenge || !clientDataJSON || !attestationObject || !credentialId) {
          return res.json({ success: false, msg: 'Missing required WebAuthn fields' }, 400);
        }

        // Consume and verify challenge
        let challengeMeta;
        try {
          challengeMeta = consumeChallenge(challenge);
        } catch (e) {
          return res.json({ success: false, msg: 'Challenge expired or invalid' }, 400);
        }
        if (challengeMeta.type !== 'user-register' || challengeMeta.userId !== req.session.id) {
          return res.json({ success: false, msg: 'Challenge mismatch' }, 400);
        }

        // Verify attestation
        let regResult;
        try {
          regResult = await verifyRegistration({ challenge, clientDataJSON, attestationObject, credentialId, rpId: getRpIdFromHost(req.headers.host) });
        } catch (e) {
          console.warn('[PASSKEYS] Registration verification failed:', e.message);
          return res.json({ success: false, msg: `Registration failed: ${e.message}` }, 400);
        }

        const passkeyName = ((name || '').trim().slice(0, 64)) || 'Passkey';

        await db`
          INSERT INTO passkey_credentials (user_id, credential_id, public_key_spki, sign_count, aaguid, name)
          VALUES (${req.session.id}, ${credentialId}, ${regResult.spki}, ${regResult.signCount}, ${regResult.aaguid || null}, ${passkeyName})
          ON CONFLICT (credential_id) DO UPDATE
          SET sign_count = ${regResult.signCount}, last_used = NOW(), name = ${passkeyName}
        `;

        return res.json({ success: true, credential_id: credentialId, name: passkeyName });
      } catch (err) {
        console.error('[PASSKEYS] register/finish error:', err);
        return res.json({ success: false, msg: err.message }, 500);
      }
    });

    /**
     * POST /api/v2/settings/passkeys/delete
     * Remove a passkey credential owned by the current user.
     * Uses POST + JSON body to avoid URL-encoding issues with credential IDs.
     */
    group.post(/\/passkeys\/delete$/, lib.registeredUser, async (req, res) => {
      try {
        const body = req.post || req.body || {};
        const credentialId = body.credential_id;
        if (!credentialId) return res.json({ success: false, msg: 'Missing credential_id' }, 400);
        if (credentialId === await sessionPasskey(req)) return res.json({ success: false, msg: IN_USE_PASSKEY_MSG }, 400);
        if (await isLastPasskeyOfPasskeyOnly(req.session.id)) return res.json({ success: false, msg: LAST_PASSKEY_MSG }, 400);
        const result = await db`
          DELETE FROM passkey_credentials
          WHERE credential_id = ${credentialId} AND user_id = ${req.session.id}
          RETURNING id
        `;
        if (result.length === 0) return res.json({ success: false, msg: 'Passkey not found' }, 404);
        return res.json({ success: true });
      } catch (err) {
        console.error('[PASSKEYS] Delete error:', err);
        return res.json({ success: false, msg: err.message }, 500);
      }
    });

    /**
     * DELETE /api/v2/settings/passkeys/:id
     * Legacy path — kept for compatibility.
     */
    group.delete(/\/passkeys\/([^/]+)$/, lib.registeredUser, async (req, res) => {
      try {
        const credentialId = decodeURIComponent(req.url.pathname.split('/').pop());
        if (credentialId === await sessionPasskey(req)) return res.json({ success: false, msg: IN_USE_PASSKEY_MSG }, 400);
        if (await isLastPasskeyOfPasskeyOnly(req.session.id)) return res.json({ success: false, msg: LAST_PASSKEY_MSG }, 400);
        const result = await db`
          DELETE FROM passkey_credentials
          WHERE credential_id = ${credentialId} AND user_id = ${req.session.id}
          RETURNING id
        `;
        if (result.length === 0) return res.json({ success: false, msg: 'Passkey not found' }, 404);
        return res.json({ success: true });
      } catch (err) {
        console.error('[PASSKEYS] Delete error:', err);
        return res.json({ success: false, msg: err.message }, 500);
      }
    });

    /**
     * POST /api/v2/settings/passkeys/login/begin
     * Start a passkey login challenge for a registered user (no session required).
     */
    group.post(/\/passkeys\/login\/begin$/, async (req, res) => {
      try {
        const challenge = generateChallenge({ type: 'user-login' });
        const options = buildAuthenticationOptions({ challenge, allowCredentials: [], rpId: getRpIdFromHost(req.headers.host) });
        return res.json({ success: true, options });
      } catch (err) {
        console.error('[PASSKEYS] login/begin error:', err);
        return res.json({ success: false, msg: err.message }, 500);
      }
    });

    /**
     * POST /api/v2/settings/passkeys/login/finish
     * Verify assertion and create a full registered-user session.
     */
    group.post(/\/passkeys\/login\/finish$/, async (req, res) => {
      try {
        const body = req.post || req.body || {};
        const { challenge, clientDataJSON, authenticatorData, signature, credentialId } = body;

        if (!challenge || !clientDataJSON || !authenticatorData || !signature || !credentialId) {
          return res.json({ success: false, msg: 'Missing required WebAuthn fields' }, 400);
        }

        // Consume challenge
        let challengeMeta;
        try {
          challengeMeta = consumeChallenge(challenge);
        } catch (e) {
          return res.json({ success: false, msg: 'Challenge expired or invalid' }, 400);
        }
        if (challengeMeta.type !== 'user-login') {
          return res.json({ success: false, msg: 'Wrong challenge type' }, 400);
        }

        // Look up credential — must belong to a registered (non-anon) user
        const credRows = await db`
          SELECT pc.user_id, pc.public_key_spki, pc.sign_count,
                 u.login, u.user, u.activated, u.banned, u.ban_reason, u.ban_expires, u.force_password_change
          FROM passkey_credentials pc
          JOIN "user" u ON u.id = pc.user_id
          WHERE pc.credential_id = ${credentialId}
            AND u.login IS NOT NULL
          LIMIT 1
        `;

        if (credRows.length === 0) {
          return res.json({ success: false, msg: 'No registered account found for this passkey.' }, 401);
        }

        const row = credRows[0];

        if (row.banned) {
          return res.json({ success: false, msg: 'Account is banned: ' + (row.ban_reason || '') }, 403);
        }

        if (!row.activated) {
          return res.json({ success: false, msg: 'This account is not activated. Please check your email.' }, 403);
        }

        // Verify the assertion
        try {
          await verifyAuthentication({
            challenge,
            clientDataJSON,
            authenticatorData,
            signature,
            spki: row.public_key_spki,
            storedSignCount: row.sign_count,
            rpId: getRpIdFromHost(req.headers.host)
          });
        } catch (e) {
          console.warn('[PASSKEYS] login/finish verification failed:', e.message);
          return res.json({ success: false, msg: `Authentication failed: ${e.message}` }, 401);
        }

        // Update sign count
        await db`
          UPDATE passkey_credentials SET sign_count = sign_count + 1, last_used = NOW()
          WHERE credential_id = ${credentialId}
        `;

        // Create a full user session (same as normal login)
        const stamp = Math.floor(Date.now() / 1000);
        const ip = security.storableIP(security.getRealIP(req));
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const csrfToken = crypto.randomBytes(32).toString('hex');
        const sessRecord = {
          user_id: row.user_id,
          session: lib.sha256(sessionToken),
          csrf_token: csrfToken,
          browser: req.headers['user-agent'] || '',
          created_at: stamp,
          last_used: stamp,
          last_action: '/passkey-login',
          kmsi: 1,
          ip,
          passkey_credential_id: credentialId
        };
        await db`INSERT INTO "user_sessions" ${db(sessRecord, 'user_id', 'session', 'csrf_token', 'browser', 'created_at', 'last_used', 'last_action', 'kmsi', 'ip', 'passkey_credential_id')}`;

        res.setHeader('Set-Cookie', `session=${sessionToken}; ${lib.getCookieOptions('Fri, 31 Dec 9999 23:59:59 GMT')}`);
        return res.json({ success: true, user: row.user, login: row.login, force_password_change: row.force_password_change || false });
      } catch (err) {
        console.error('[PASSKEYS] login/finish error:', err);
        return res.json({ success: false, msg: err.message }, 500);
      }
    });

    return group;
  });

  // ═══════════════════ Invite Request (anon user) ═══════════════════

  // Submit an invite request (requires a session — anon or registered, but mainly for anon)
  router.post(/^\/api\/v2\/invite-request\/?$/, lib.loggedin, async (req, res) => {
    try {
      if (!req.session.is_anon) {
        return res.json({ success: false, msg: 'You already have a registered account' }, 400);
      }

      const fingerprint = req.session.fingerprint;
      if (!fingerprint) {
        return res.json({ success: false, msg: 'No passkey identity found' }, 400);
      }

      // Check if there's already a pending request for this fingerprint
      const [existing] = await db`
        SELECT id, status FROM invite_requests
        WHERE fingerprint = ${fingerprint} AND status = 'pending'
        LIMIT 1
      `;
      if (existing) {
        return res.json({ success: false, msg: 'You already have a pending invite request' }, 409);
      }

      const reason = (req.post.reason || '').trim().slice(0, 500);
      const ip = security.getRealIP(req);
      const ipHash = ip ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16) : null;

      await db`
        INSERT INTO invite_requests (user_id, fingerprint, ip_hash, reason)
        VALUES (${req.session.id}, ${fingerprint}, ${ipHash}, ${reason})
      `;

      // Notify all admin users
      const anonLogin = req.session.login || req.session.user || 'anonymous';
      const admins = await db`SELECT id FROM "user" WHERE admin = true`;
      if (admins.length > 0) {
        const notifications = admins.map(a => ({
          user_id: a.id,
          type: 'invite_request',
          reference_id: 0,
          data: db.json({ username: anonLogin, reason: reason.slice(0, 100) })
        }));
        await db`INSERT INTO notifications ${db(notifications)}`;
      }

      console.log(`[INVITE-REQ] New request from fp: ${fingerprint.slice(0, 12)}…`);

      return res.json({ success: true, msg: 'Invite request submitted! An admin will review it shortly.' });
    } catch (err) {
      console.error('[INVITE-REQ] Submit error:', err);
      return res.json({ success: false, msg: 'Failed to submit request' }, 500);
    }
  });

  // Check status of current invite request
  router.get(/^\/api\/v2\/invite-request\/status\/?$/, lib.loggedin, async (req, res) => {
    try {
      const fingerprint = req.session.fingerprint;
      if (!fingerprint) {
        return res.json({ success: true, status: null });
      }

      const [request] = await db`
        SELECT ir.id, ir.status, ir.created_at, ir.reviewed_at,
               it.token, it.is_used
        FROM invite_requests ir
        LEFT JOIN invite_tokens it ON it.id = ir.token_id
        WHERE ir.fingerprint = ${fingerprint}
        ORDER BY ir.created_at DESC
        LIMIT 1
      `;

      if (!request) {
        return res.json({ success: true, status: null });
      }

      // Auto-revoke if token was deleted or already used but status still says approved
      let status = request.status;
      if (status === 'approved' && (!request.token || request.is_used)) {
        await db`UPDATE invite_requests SET status = 'revoked' WHERE id = ${request.id}`;
        status = 'revoked';
      }

      return res.json({
        success: true,
        status,
        created_at: request.created_at,
        reviewed_at: request.reviewed_at,
        token: status === 'approved' ? request.token : undefined
      });
    } catch (err) {
      console.error('[INVITE-REQ] Status check error:', err);
      return res.json({ success: false, msg: 'Failed to check status' }, 500);
    }
  });

  return router;
};
