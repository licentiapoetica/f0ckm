import db from "../../inc/sql.mjs";
import cfg from "../config.mjs";

const auth = async (req, res, next) => {
  if (!req.session)
    return res.redirect("/login");
  return next();
};

export default (router, tpl) => {
  router.group(/^\/settings/, group => {
    group.get(/$/, auth, async (req, res) => {
      const sessions = await db`
        select *
        from user_sessions
        where user_id = ${+req.session.id}
        order by last_used desc
      `;

      const excluded_tags = await db`
        select t.id, t.tag, t.normalized
        from unnest((select excluded_tags from user_options where user_id = ${+req.session.id})) as et(id)
        join tags t on t.id = et.id
      `;

      // Get custom avatar file and banner file if exists
      const userOptions = (await db`
        select avatar_file, banner_file from user_options where user_id = ${+req.session.id}
      `)[0];

      // Get full user info
      const user = (await db`
        select email, created_at from "user" where id = ${+req.session.id}
      `)[0];

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');



      res.reply({
        body: tpl.render('settings', {
          tmp: null,
          sessions,
          excluded_tags: excluded_tags || [],
          avatar_file: userOptions?.avatar_file || null,
          banner_file: userOptions?.banner_file || null,
          banner_position: userOptions?.banner_position || 'center',
          banner_size: userOptions?.banner_size || 'cover',
          email: user?.email || '',
          joined: user?.created_at || null,
          user_banner_enabled: cfg.websrv.user_banner_enabled !== false,
          enable_swf: cfg.enable_swf,
          enable_data_export: cfg.websrv.enable_data_export,
          enable_user_api_keys: cfg.websrv.enable_user_api_keys !== false,
          enable_user_invites: cfg.websrv.enable_user_invites !== false,
          site_domain: cfg.main.url.domain,
          session: (req.session && req.session.user) ? { ...req.session } : false,
          page_meta: {
            title: 'settings',
            description: 'User settings',
            url: `https://${cfg.main.url.domain}/settings`
          }
        }, req)
      });
    });
    group.get('/export-data', auth, async (req, res) => {
      if (!cfg.websrv.enable_data_export) {
        res.status(403).reply({ body: 'Export disabled' });
        return;
      }
      const uploads = await db`
        select id, dest, mime from items 
        where username = ${req.session.user} and active = true
        order by id desc
      `;
      
      const favorites = await db`
        select i.id, i.dest, i.mime from items i
        join favorites f on f.item_id = i.id
        where f.user_id = ${+req.session.id} and i.active = true
        order by f.item_id desc
      `;

      res.reply({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploads, favorites })
      });
    });
  });

  return router;
};
