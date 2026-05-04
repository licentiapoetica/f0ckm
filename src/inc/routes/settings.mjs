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

      // Get custom avatar file if exists
      const userOptions = (await db`
        select avatar_file from user_options where user_id = ${+req.session.id}
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
          email: user?.email || '',
          joined: user?.created_at || null,
          enable_swf: cfg.enable_swf,
          session: (req.session && req.session.user) ? { ...req.session } : false,
          page_meta: {
            title: 'settings',
            description: 'User settings',
            url: `https://${cfg.main.url.domain}/settings`
          }
        }, req)
      });
    });
  });

  return router;
};
