import db from "../../inc/sql.mjs";
import lib from "../lib.mjs";
import config from "../config.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";
import fetch from "flumm-fetch";

export default (router, tpl) => {
  router.get(/^\/ranking$/, lib.loggedin, async (req, res) => {
    try {
      const list = await db`
        select
          "user".user, "user".admin,
          coalesce("user_options".avatar, ${await lib.getDefaultAvatar()}) as avatar,
          "user_options".avatar_file,
          "user_options".display_name,
          count(distinct(tag_id, item_id)) as count
        from "tags_assign"
        left join "user" on "user".id = "tags_assign".user_id
        left join "user_options" on "user_options".user_id = "user".id
        group by "user".user, "user_options".avatar, "user_options".avatar_file, "user".admin, "user_options".display_name
        order by count desc
      `;
      const stats = await lib.countf0cks();

      const totalComments = +(await db`
        select count(*) as total
        from comments
        join items on comments.item_id = items.id
        where comments.is_deleted = false and items.active = true
      `)[0].total;

      const totalFavs = +(await db`
        select count(*) as total
        from favorites
        join items on favorites.item_id = items.id
        where items.active = true
      `)[0].total;

      const hoster = await db`
        with t as (
          select
            split_part(substring(src, position('//' in src)+2), '/', 1) part
          from items
        )
        select t.part, count(t.part) as c
        from t
        group by t.part
        order by c desc
        limit 20
      `;

      const favotop = await db`
        select favorites.item_id, count(*) favs
        from favorites
        join items on items.id = favorites.item_id
        where items.active = true
        group by favorites.item_id
        having count(*) > 1
        order by favs desc
        limit 10
      `;
      
      let xdtop = [];
      if (config.websrv.enable_xd_score) {
        const xdRows = await db`
          select id, xd_score
          from items
          where active = true and is_deleted = false and xd_score > 0
          order by xd_score desc
          limit 10
        `;
        xdtop = xdRows.map(item => {
          const meta = f0cklib.xdScoreMeta(item.xd_score);
          return {
            ...item,
            xd_tier: meta.tier,
            xd_label: meta.label
          };
        });
      }

      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');

      res.reply({
        body: tpl.render('ranking', {
          list,
          stats,
          hoster,
          favotop,
          xdtop,
          totalComments,
          totalFavs,
          enable_nsfl: config.enable_nsfl,
          tmp: null,
          session: (req.session && req.session.user) ? { ...req.session } : false,
          page_meta: {
            title: 'ranking',
            description: 'User ranking and site statistics',
            url: `https://${config.main.url.domain}/ranking`
          }
        }, req)
      });
    } catch (err) {
      res.end(JSON.stringify(err.message));
    }
  });

  return router;
};
