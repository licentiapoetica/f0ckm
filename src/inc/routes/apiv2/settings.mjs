import db from '../../sql.mjs';
import lib from '../../lib.mjs';
import cfg from '../../config.mjs';

// Note: Avatar upload/delete is handled by middleware in index.mjs via avatar_handler.mjs
// These routes remain for other settings API endpoints

export default router => {
  router.group(/^\/api\/v2\/settings/, group => {
    group.put(/\/setAvatar/, lib.loggedin, async (req, res) => {
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
    group.put(/\/useCustomAvatar/, lib.loggedin, async (req, res) => {
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
      const tags = await db`
        select t.id, t.tag, t.normalized
        from unnest((select excluded_tags from user_options where user_id = ${+req.session.id})) as et(id)
        join tags t on t.id = et.id
      `;
      return res.json({ success: true, tags }, 200);
    });

    group.post(/\/excluded_tags/, lib.loggedin, async (req, res) => {
      const tagname = req.post.tagname;
      if (!tagname) return res.json({ success: false, msg: 'No tag provided' }, 400);

      const tag = (await db`select id, tag, normalized from tags where normalized = slugify(${tagname})`)[0];

      if (!tag) return res.json({ success: false, msg: 'Tag not found' }, 404);

      await db`
        update user_options 
        set excluded_tags = array_append(excluded_tags, ${tag.id})
        where user_id = ${+req.session.id} and not (${tag.id} = any(excluded_tags))
      `;

      // Return updated list
      const tags = await db`
        select t.id, t.tag, t.normalized
        from unnest((select excluded_tags from user_options where user_id = ${+req.session.id})) as et(id)
        join tags t on t.id = et.id
      `;

      return res.json({ success: true, tags }, 200);
    });

    group.delete(/\/excluded_tags\/(?<tag>.+)/, lib.loggedin, async (req, res) => {
      const tagname = decodeURIComponent(req.params.tag);
      const tag = (await db`select id from tags where normalized = slugify(${tagname})`)[0];

      if (!tag) return res.json({ success: false, msg: 'Tag not found' }, 404);

      await db`
        update user_options 
        set excluded_tags = array_remove(excluded_tags, ${tag.id})
        where user_id = ${+req.session.id}
      `;

      const tags = await db`
        select t.id, t.tag, t.normalized
        from unnest((select excluded_tags from user_options where user_id = ${+req.session.id})) as et(id)
        join tags t on t.id = et.id
      `;

      return res.json({ success: true, tags }, 200);
    });

    // Generic Token Generation (default type=discord if not specified, though frontend should specify)
    group.post(/\/link\/token/, lib.loggedin, async (req, res) => {
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
    group.get(/\/link\/accounts/, lib.loggedin, async (req, res) => {
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
    group.delete(/\/link\/unlink\/(?<type>[a-z]+)\/(?<alias>.+)/, lib.loggedin, async (req, res) => {
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
    group.post(/\/discord\/token/, lib.loggedin, async (req, res) => {
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
    group.get(/\/discord\/linked/, lib.loggedin, async (req, res) => {
      const aliases = await db`SELECT alias FROM user_alias WHERE userid = ${req.session.id} AND type = 'discord'`;
      return res.json({ success: true, aliases: aliases.map(a => ({ alias: a.alias })) }, 200);
    });

    // Unlink Discord account (Legacy)
    group.delete(/\/discord\/unlink\/(?<alias>.+)/, lib.loggedin, async (req, res) => {
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

    // Update Username Color preference
    group.put(/\/username_color/, lib.loggedin, async (req, res) => {
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
        return res.json({ success: true, color }, 200);
      } catch (e) {
        console.error('Update Username Color error:', e);
        return res.json({ success: false, msg: 'Error updating color' }, 500);
      }
    });

    // Update password
    group.put(/\/password/, lib.loggedin, async (req, res) => {
      const { current_password, new_password, new_password_confirm } = req.post;
      
      if (!new_password || !new_password_confirm) {
        return res.json({ success: false, msg: 'New password and confirmation are required' }, 400);
      }

      const user = (await db`select password, force_password_change from "user" where id = ${+req.session.id}`)[0];
      if (!user) return res.json({ success: false, msg: 'User not found' }, 404);

      if (!user.force_password_change) {
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
    group.put(/\/email/, lib.loggedin, async (req, res) => {
      const { email } = req.post;
      if (!email || !email.trim()) return res.json({ success: false, msg: 'Email is required' }, 400);
      if (!email.includes('@')) return res.json({ success: false, msg: 'Invalid email address' }, 400);

      await db`update "user" set email = ${email.trim()} where id = ${+req.session.id}`;
      return res.json({ success: true, msg: 'Email updated successfully' }, 200);
    });

    // Update Display Name
    group.put(/\/display_name/, lib.loggedin, async (req, res) => {
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
        return res.json({ success: true, display_name: cleanDisplayName, msg: 'Display name updated successfully' }, 200);
      } catch (e) {
        console.error('Update Display Name error:', e);
        return res.json({ success: false, msg: 'Error updating display name' }, 500);
      }
    });

    // Update Description
    group.put(/\/description/, lib.loggedin, async (req, res) => {
      if (!cfg.websrv.enable_profile_description) {
        return res.json({ success: false, msg: 'Profile descriptions are disabled' }, 403);
      }
      const { description } = req.post;

      if (description !== undefined && typeof description !== 'string') {
        return res.json({ success: false, msg: 'Invalid description format' }, 400);
      }

      const cleanDescription = description ? description.trim().substring(0, 255) : null;

      try {
        await db`
          update user_options 
          set description = ${cleanDescription}
          where user_id = ${+req.session.id}
        `;
        // Sync session immediately
        if (req.session) req.session.description = cleanDescription;
        return res.json({ success: true, description: cleanDescription }, 200);
      } catch (e) {
        console.error('Update Description error:', e);
        return res.json({ success: false, msg: 'Error updating description' }, 500);
      }
    });

    // Update Font preference
    group.put(/\/font/, lib.loggedin, async (req, res) => {
      const { font } = req.post;

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
      const ruffle_volume = parseFloat(req.post.ruffle_volume);
      const ruffle_background = req.post.ruffle_background === 'true' || req.post.ruffle_background === true;

      if (isNaN(ruffle_volume) || ruffle_volume < 0 || ruffle_volume > 1) {
        return res.json({ success: false, msg: 'Invalid volume: must be 0-1' }, 400);
      }

      try {
        await db`
          update user_options
          set ruffle_volume = ${ruffle_volume},
              ruffle_background = ${ruffle_background}
          where user_id = ${+req.session.id}
        `;
        if (req.session) {
          req.session.ruffle_volume = ruffle_volume;
          req.session.ruffle_background = ruffle_background;
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
        await db`
          update user_options
          set use_alternative_infobox = ${use_alternative_infobox}
          where user_id = ${+req.session.id}
        `;
        if (req.session) req.session.use_alternative_infobox = use_alternative_infobox;
        return res.json({ success: true, use_alternative_infobox }, 200);
      } catch (e) {
        console.error('Update alternative_infobox error:', e);
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

    return group;
  });

  return router;
};
