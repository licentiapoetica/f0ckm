import db from "../sql.mjs";
import lib from "../lib.mjs";
import search from "../routeinc/search.mjs";

const _eps = 20;

export default (router, tpl) => {
  router.get(/^\/search(\/)?$/, lib.loggedin, async (req, res) => {
    let ret;
    let mode = req.url.qs.mode;
    let tag = req.url.qs.tag ?? [];
    let page = req.url.qs.page ?? 1;
    let total = 0;
    let pagination, link;

    if (tag.length > 0) {
      if (tag.startsWith('src:')) {
        total = (await db`
          select count(*) as total
          from "items"
          where src ilike ${'%' + tag.substring(4) + '%'} and active = true
          group by "items".id
        `).length;

        const pages = +Math.ceil(total / _eps);
        const act_page = Math.min(pages, page || 1);
        const offset = Math.max(0, (act_page - 1) * _eps);

        ret = await db`
          select *
          from "items"
          where
            src ilike ${'%' + tag.substring(4) + '%'} and
            active = true
          group by "items".id
          order by "items".id desc
          offset ${offset}
          limit ${_eps}
        `;

        const cheat = [];
        for (let i = Math.max(1, act_page - 3); i <= Math.min(act_page + 3, pages); i++)
          cheat.push(i);

        pagination = {
          start: 1,
          end: pages,
          prev: (act_page > 1) ? act_page - 1 : null,
          next: (act_page < pages) ? act_page + 1 : null,
          page: act_page,
          cheat: cheat,
          uff: false
        };
        link = {
          main: `/search/?tag=${tag}`,
          path: '&page='
        };
      }
      else if (mode === 'strict') {
        const tags = tag.split(',').map(t => t.trim()).filter(t => t.length > 0);

        if (tags.length > 0) {
          const lowerTags = tags.map(t => t.toLowerCase());

          const countResult = await db`
            select count(sub.id) as total from (
              select "items".id
              from "items"
              join "tags_assign" on "tags_assign".item_id = "items".id
              join "tags" on "tags".id = "tags_assign".tag_id
              where lower("tags".tag) in (${db(lowerTags)})
                and "items".active = true
              group by "items".id
              having count(distinct lower("tags".tag)) = ${lowerTags.length}
            ) sub
          `;
          total = countResult.length > 0 ? countResult[0].total : 0;

          const pages = +Math.ceil(total / _eps);
          const act_page = Math.min(pages, page || 1);
          const offset = Math.max(0, (act_page - 1) * _eps);

          const rows = await db`
            select "items".id, "items".username, "items".mime, min("tags".tag) as tag
            from "items"
            join "tags_assign" on "tags_assign".item_id = "items".id
            join "tags" on "tags".id = "tags_assign".tag_id
            where lower("tags".tag) in (${db(lowerTags)})
              and "items".active = true
            group by "items".id
            having count(distinct lower("tags".tag)) = ${lowerTags.length}
            order by "items".id desc
            offset ${offset}
            limit ${_eps}
          `;

          ret = rows.map(r => ({ ...r, score: 1.0 }));

          const cheat = [];
          for (let i = Math.max(1, act_page - 3); i <= Math.min(act_page + 3, pages); i++)
            cheat.push(i);

          pagination = {
            start: 1,
            end: pages,
            prev: (act_page > 1) ? act_page - 1 : null,
            next: (act_page < pages) ? act_page + 1 : null,
            page: act_page,
            cheat: cheat,
            uff: false
          };
          link = {
            main: `/search/?tag=${encodeURIComponent(tag)}&mode=strict`,
            path: '&page='
          };
        } else {
          total = 0;
          ret = [];
        }
      }
      else {
        total = (await db`
          select count(*) as total
          from "tags"
          left join "tags_assign" on "tags_assign".tag_id = "tags".id
          left join "items" on "items".id = "tags_assign".item_id
          where "tags".tag ilike ${'%' + tag + '%'}
          group by "items".id, "tags".tag
        `).length;

        const pages = +Math.ceil(total / _eps);
        const act_page = Math.min(pages, page || 1);
        const offset = Math.max(0, (act_page - 1) * _eps);

        const rows = await db`
          select "items".id, "items".username, "items".mime, "tags".tag
          from "tags"
          left join "tags_assign" on "tags_assign".tag_id = "tags".id
          left join "items" on "items".id = "tags_assign".item_id
          where "tags".tag ilike ${'%' + tag + '%'} and "items".active = true
          group by "items".id, "tags".tag
          offset ${offset}
          limit ${_eps}
        `;
        ret = search(rows, tag);

        const cheat = [];
        for (let i = Math.max(1, act_page - 3); i <= Math.min(act_page + 3, pages); i++)
          cheat.push(i);

        pagination = {
          start: 1,
          end: pages,
          prev: (act_page > 1) ? act_page - 1 : null,
          next: (act_page < pages) ? act_page + 1 : null,
          page: act_page,
          cheat: cheat,
          uff: false
        };
        link = {
          main: `/search/?tag=${encodeURIComponent(tag)}`,
          path: '&page='
        };
      }
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    res.reply({
      body: tpl.render("search", {
        result: ret,
        totals: await lib.countf0cks(),
        searchstring: tag,
        count: total,
        pagination,
        link,
        session: (req.session && req.session.user) ? { ...req.session } : false,
        mode: req.url.qs.mode
      }, req)
    });
  });
};
