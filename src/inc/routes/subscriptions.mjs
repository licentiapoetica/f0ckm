import db from "../sql.mjs";
import cfg from "../config.mjs";
import url from "url";

export default (router, tpl) => {

    // Subscriptions Overview
    router.get('/subscriptions', async (req, res) => {
        if (!req.session) return res.redirect('/login');

        let query = {};
        if (typeof req.url === 'string') {
            const parsedUrl = url.parse(req.url, true);
            query = parsedUrl.query;
        } else {
            query = req.url.qs || {};
        }

        const page = parseInt(query.page) || 1;
        const eps = cfg.websrv.eps || 300;
        const offset = (page - 1) * eps;

        try {
            if (cfg.main.development) console.log('[DEBUG SUB] Fetching subscriptions for user', req.session.id, 'page', page);

            const countRes = await db`
                SELECT count(*) as total
                FROM comment_subscriptions
                WHERE user_id = ${req.session.id} AND is_subscribed = true
            `;
            const total = parseInt(countRes[0].total);
            const pages = Math.ceil(total / eps);

            const subs = await db`
                SELECT 
                    s.created_at as sub_date,
                    i.id, i.slug, i.dest, i.mime, i.username as uploader_name
                FROM comment_subscriptions s
                JOIN items i ON s.item_id = i.id
                WHERE s.user_id = ${req.session.id} AND s.is_subscribed = true
                ORDER BY s.created_at DESC
                LIMIT ${eps} OFFSET ${offset}
            `;
            if (cfg.main.development) console.log('[DEBUG SUB] Found', subs.length, 'subscriptions out of', total);

            const items = subs.map(i => ({
                id: i.id,
                slug: i.slug || null,
                user: i.uploader_name || 'System',
                sub_created: new Date(i.sub_date).toLocaleString(),
                thumb: `/t/${i.id}.webp`
            }));

            const pagination = {
                start: 1,
                end: pages,
                prev: (page > 1) ? page - 1 : null,
                next: (page < pages) ? page + 1 : null,
                page: page
            };

            const link = { main: '/subscriptions', path: '?page=' };

            return res.reply({
                body: tpl.render('subscriptions', {
                    items,
                    pagination,
                    link,
                    totalCount: total,
                    hidePagination: true,
                    page_meta: {
                        title: 'subscriptions',
                        description: 'Your comment subscriptions',
                        url: `https://${cfg.main.url.domain}/subscriptions`
                    }
                }, req)
            });
        } catch (e) {
            console.error('[DEBUG SUB ERROR]', e);
            return res.reply({ code: 500, body: 'Database Error' });
        }
    });

    // AJAX Subscriptions for infinite scroll
    router.get('/ajax/subscriptions', async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });

        let query = {};
        if (typeof req.url === 'string') {
            const parsedUrl = url.parse(req.url, true);
            query = parsedUrl.query;
        } else {
            query = req.url.qs || {};
        }

        const page = parseInt(query.page) || 1;
        const eps = cfg.websrv.eps || 300;
        const offset = (page - 1) * eps;

        try {
            const countRes = await db`
                SELECT count(*) as total
                FROM comment_subscriptions
                WHERE user_id = ${req.session.id} AND is_subscribed = true
            `;
            const total = parseInt(countRes[0].total);
            const pages = Math.ceil(total / eps);

            const subs = await db`
                SELECT 
                    s.created_at as sub_date,
                    i.id, i.slug, i.dest, i.mime, i.username as uploader_name
                FROM comment_subscriptions s
                JOIN items i ON s.item_id = i.id
                WHERE s.user_id = ${req.session.id} AND s.is_subscribed = true
                ORDER BY s.created_at DESC
                LIMIT ${eps} OFFSET ${offset}
            `;

            const items = subs.map(i => ({
                id: i.id,
                slug: i.slug || null,
                user: i.uploader_name || 'System',
                sub_created: new Date(i.sub_date).toLocaleString(),
                thumb: `/t/${i.id}.webp`
            }));

            const pagination = {
                start: 1,
                end: pages,
                prev: (page > 1) ? page - 1 : null,
                next: (page < pages) ? page + 1 : null,
                page: page
            };

            const link = { main: '/subscriptions', path: '?page=' };

            const html = tpl.render('snippets/subscriptions-grid', { items }, req);
            const pagHtml = tpl.render('snippets/pagination', { pagination, link }, req);

            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    html: html,
                    pagination: pagHtml,
                    hasMore: page < pages,
                    currentPage: page
                })
            });
        } catch (e) {
            console.error('[DEBUG AJAX SUB ERROR]', e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    // Unsubscribe
    router.post(/\/api\/subscriptions\/(?<itemid>\d+)\/delete/, async (req, res) => {
        if (!req.session) return res.reply({ code: 401, body: JSON.stringify({ success: false }) });

        const itemId = req.params.itemid;

        try {
            await db`UPDATE comment_subscriptions SET is_subscribed = false WHERE user_id = ${req.session.id} AND item_id = ${itemId}`;
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true })
            });
        } catch (e) {
            console.error(e);
            return res.reply({ code: 500, body: JSON.stringify({ success: false }) });
        }
    });

    return router;
};
