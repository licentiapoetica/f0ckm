import f0cklib from "../routeinc/f0cklib.mjs";
import url from "url";
import cfg from "../config.mjs";

export default (router, tpl) => {
    router.get(/\/ajax\/item\/(?<itemid>\d+)/, async (req, res) => {
        const tAjaxStart = Date.now();
        let query = {};
        if (typeof req.url === 'string') {
            const parsedUrl = url.parse(req.url, true);
            query = parsedUrl.query;
        } else {
            // flummpress uses req.url.qs for query string parameters
            query = req.url.qs || {};
        }

        let contextUrl = `/${req.params.itemid}`;
        if (query.tag) contextUrl = `/tag/${encodeURIComponent(query.tag)}/${req.params.itemid}`;
        if (query.hall) contextUrl = `/h/${encodeURIComponent(query.hall)}/${req.params.itemid}`;
        if (query.userHall && query.userHallOwner) {
            contextUrl = `/user/${encodeURIComponent(query.userHallOwner)}/hall/${encodeURIComponent(query.userHall)}/${req.params.itemid}`;
        } else if (query.user) {
            contextUrl = query.fav === 'true'
                ? `/user/${encodeURIComponent(query.user)}/favs/${req.params.itemid}`
                : `/user/${encodeURIComponent(query.user)}/${req.params.itemid}`;
        }
        if (query.mime) {
            contextUrl = contextUrl.replace(new RegExp(`/${req.params.itemid}$`), `/${query.mime}/${req.params.itemid}`);
        }

        if (cfg.main.development) console.log(`[${new Date().toISOString()}] [AJAX] Starting item load for ${req.params.itemid}`);

        const isRandom = query.random === '1' || req.cookies.random_mode === '1';
        const ratingsRaw = req.cookies.ratings;
        const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;

        const itemid = req.params.itemid || req.url.pathname.match(/\/ajax\/item\/(\d+)/)?.[1];
        const data = await f0cklib.getf0ck({
            itemid: itemid,
            mode: query.mode !== undefined ? +query.mode : req.mode,
            ratings: ratingsArr,
            session: !!req.session,
            url: contextUrl,
            user: query.user,
            tag: query.tag,
            hall: query.hall,
            userHall: query.userHall || null,
            userHallOwner: query.userHallOwner || null,
            mime: query.mime || (req.cookies.mime || null),
            fav: query.fav === 'true',
            random: isRandom,
            strict: query.strict === '1' || query.strict === 'true' || req.session?.strict_mode,
            explicitStrict: query.strict === '1' || query.strict === 'true',
            exclude: req.session ? (req.session.excluded_tags || []) : [],
            user_id: req.session?.id
        });
        const tAjaxFetch = Date.now();

        if (!data.success) {
            const errorHtml = tpl.render('error-partial', {
                message: data.message || '404 - Not f0cked',
                tmp: null
            }, req);
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: errorHtml, pagination: '', error: true })
            });
        }

        // Load xD score server-side (needed for badge), but do NOT embed comments into the response.
        // Comments are always loaded async by the client via /api/comments/:id to avoid
        // blocking the browser's main thread on posts with huge comment payloads.
        if (req.session || !cfg.main.hide_comments_from_public) {
            // Mark notifications as read
            if (req.session?.id) {
                f0cklib.markNotificationsRead(req.session.id, itemid).catch(() => {});
            }
            const sub = req.session ? await f0cklib.getSubscriptionStatus(req.session.id, req.params.itemid) : false;
            data.isSubscribed = sub;
            // xD Score for item view badge
            const commentsForScore = await f0cklib.getComments(req.params.itemid, 'old', false);
            const xdScore = f0cklib.computeXdScore(commentsForScore);
            const xdMeta  = f0cklib.xdScoreMeta(xdScore);
            data.item.xd_score = xdScore;
            data.item.xd_tier  = xdMeta.tier;
            data.item.xd_label = xdMeta.label;
            // Do NOT set commentsJSON — client will fetch async
            data.commentsJSON = null;
            data.comments = [];
        } else {
            data.isSubscribed = false;
            data.commentsJSON = null;
            data.comments = [];
            data.item.xd_score = 0;
            data.item.xd_tier  = 0;
            data.item.xd_label = '';
        }
        const tAjaxAux = Date.now();

        // Inject session into data for the template
        if (req.session) {
            data.session = { ...req.session };
        } else {
            data.session = false;
        }

        // Inject missing variables normally provided by req or middleware
        data.url = { pathname: contextUrl }; // Template expects url.pathname
        data.fullscreen = req.cookies.fullscreen || 0; // Index.mjs uses req.cookies.fullscreen
        data.hidePagination = true;

        // Precompute hall display data for the template
        if (data.item && data.item.halls && data.item.halls.length) {
            const currentHallSlug = data.tmp && data.tmp.hall
                ? (typeof data.tmp.hall === 'object' ? data.tmp.hall.slug : data.tmp.hall)
                : null;
            data.item.primaryHall = data.item.halls.find(h => h.slug === currentHallSlug) || data.item.halls[0];
            data.item.otherHalls = data.item.halls.filter(h => h.slug !== data.item.primaryHall.slug);
        } else if (data.item) {
            data.item.primaryHall = null;
            data.item.otherHalls = [];
        }

        // Precompute boolean helpers for template @if() — flummpress uses non-greedy regex
        // that stops at the first ')' inside @if(...), so any method call with parens
        // (indexOf, .some, etc.) must be precomputed here as plain booleans.
        if (data.item) {
            const session = data.session;
            const item = data.item;
            data.is_mod_or_admin = !!(session && (session.admin || session.is_moderator));
            data.can_manage_item = !!(session && (session.admin || session.is_moderator || session.user === item.username));
            data.can_extract_meta = !!(item.mime && item.mime.indexOf('flash') === -1 && !(item.mime.startsWith('application/') && cfg.mimes[item.mime] && !['swf', 'pdf'].includes(cfg.mimes[item.mime])));
            data.user_has_favorited = !!(session && Array.isArray(item.favorites) && item.favorites.some(f => f.user === session.user));
            data.halls_slugs = Array.isArray(item.halls) ? item.halls.map(h => h.slug).join(',') : '';
            data.user_halls_slugs = Array.isArray(item.user_halls) ? item.user_halls.map(h => h.slug).join(',') : '';
            // Precomputed for template engine compatibility (avoids nested { } inside {{ }})
            data.item_rating_class = item.is_nsfl ? 'is-nsfl' : (item.is_nsfw ? 'is-nsfw' : (item.is_sfw ? 'is-sfw' : 'is-untagged'));
            data.item_rating_label = item.is_nsfl ? 'NSFL' : (item.is_nsfw ? 'NSFW' : (item.is_sfw ? 'SFW' : '?'));
            data.item_username_lower = (item.username || '').toLowerCase();
            data.is_flash_item = !!(item.mime && (item.mime.indexOf('flash') !== -1 || item.mime.indexOf('shockwave') !== -1));
            data.is_archive_item = !!(item.mime && item.mime.startsWith('application/') && cfg.mimes[item.mime] && !['swf', 'pdf'].includes(cfg.mimes[item.mime]));
            data.current_hall_slug = (data.tmp && data.tmp.hall && typeof data.tmp.hall === 'object') ? data.tmp.hall.slug : (data.tmp && data.tmp.hall ? data.tmp.hall : '');
            data.current_user_hall_slug = (data.tmp && data.tmp.userHall && typeof data.tmp.userHall === 'object') ? data.tmp.userHall.slug : (data.tmp && data.tmp.userHall ? data.tmp.userHall : '');
            data.current_user_hall_owner = (data.tmp && data.tmp.userHallOwner) ? data.tmp.userHallOwner : '';
            data.item_has_dimensions = !!(item.width && item.height);
        }

        // Render both the item content and the pagination
        const itemHtml = tpl.render('ajax-item', data, req);
        const paginationHtml = tpl.render('snippets/pagination', data, req);
        const tAjaxRender = Date.now();

        if (cfg.main.development) console.log(`[${new Date().toISOString()}] [AJAX] Complete request for ${req.params.itemid} in ${tAjaxRender - tAjaxStart}ms
        - getf0ck: ${tAjaxFetch - tAjaxStart}ms
        - Comments/Sub: ${tAjaxAux - tAjaxFetch}ms
        - Render: ${tAjaxRender - tAjaxAux}ms`);

        res.reply({
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                html: itemHtml,
                pagination: paginationHtml,
                title: data.title,
                id: itemid
            })
        });
    });

    router.get('/ajax/halls', async (req, res) => {
        try {
            const halls = await f0cklib.getHalls();
            res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(halls)
            });
        } catch (err) {
            res.reply({
                code: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: true, msg: 'Failed to fetch halls' })
            });
        }
    });



    // Infinite scroll endpoint for index thumbnails
    router.get(/\/ajax\/items/, async (req, res) => {
        let query = {};
        if (typeof req.url === 'string') {
            const parsedUrl = url.parse(req.url, true);
            query = parsedUrl.query;
        } else {
            query = req.url.qs || {};
        }

        const page = parseInt(query.page) || 1;
        const isRandom = query.random === '1' || req.cookies.random_mode === '1';
        const ratingsRaw = req.cookies.ratings;
        const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;

        const data = await f0cklib.getf0cks({
            page: page,
            tag: query.tag || null,
            hall: query.hall || null,
            user: query.user || null,
            userHall: query.userHall || null,
            userHallOwner: query.userHallOwner || null,
            mime: query.mime || (req.cookies.mime || null),
            mode: query.mode !== undefined ? +query.mode : req.mode,
            ratings: ratingsArr,
            session: !!req.session,
            exclude: req.session ? (req.session.excluded_tags || []) : [],
            user_id: req.session?.id,
            fav: query.fav === 'true',
            random: isRandom,
            strict: query.strict === '1' || query.strict === 'true' || req.session?.strict_mode,
            explicitStrict: query.strict === '1' || query.strict === 'true',
            newer: query.newer || null,
            minXdScore: req.session?.min_xd_score || 0
        });

        if (!data.success) {
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: false,
                    html: '',
                    hasMore: false
                })
            });
        }

        // Render just the thumbnail items
        const itemsHtml = tpl.render('snippets/items-grid', {
            items: data.items,
            link: data.link
        }, req);

        // Render pagination
        const paginationHtml = tpl.render('snippets/pagination', {
            pagination: data.pagination,
            link: data.link
        }, req);

        // Render title/header (for tags/users)
        const titleHtml = tpl.render('snippets/page-title', {
            tmp: {
                user: query.user ? String(query.user).toLowerCase() : null,
                tag: query.tag ? String(query.tag).toLowerCase() : null,
                hall: query.hall ? String(query.hall).toLowerCase() : null,
                mime: query.mime ? String(query.mime).toLowerCase() : null,
                mode: query.mode,
                view_mode: query.fav === 'true' ? 'favs' : 'f0cks'
            },
            total: data.total || 0,
            session: (req.session && req.session.user) ? { ...req.session } : false
        }, req);

        const hasMore = data.pagination.next !== null;

        return res.reply({
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            body: JSON.stringify({
                success: true,
                html: itemsHtml,
                titleHtml: titleHtml,
                pagination: paginationHtml,
                hasMore: hasMore,
                nextPage: data.pagination.next,
                currentPage: data.pagination.page
            })
        });
    });

    return router;
};
