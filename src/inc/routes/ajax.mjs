import f0cklib from "../routeinc/f0cklib.mjs";
import lib from "../lib.mjs";
import url from "url";
import cfg from "../config.mjs";
import { createI18n } from "../i18n.mjs";
import { isAnonymizeSession, canAnonDo, getSessionOwnerName, isOnaraEnabledFor } from "../settings.mjs";

export default (router, tpl) => {
    // ── Merged random + item load: single request instead of two ────────────
    router.get(/^\/ajax\/item\/random/, async (req, res) => {
        const tAjaxStart = Date.now();
        let query = {};
        if (typeof req.url === 'string') {
            const parsedUrl = url.parse(req.url, true);
            query = parsedUrl.query;
        } else {
            query = req.url.qs || {};
        }

        const isPrefetch = !!(
            query.prefetch === '1' ||
            req.url?.qs?.prefetch === '1' ||
            req.headers?.['x-purpose'] === 'prefetch' ||
            req.headers?.['purpose'] === 'prefetch' ||
            req.headers?.['sec-purpose'] === 'prefetch'
        );

        const isGuest = !req.session || !req.session.user;
        const reqMode = isGuest ? 0 : (query.mode !== undefined ? +query.mode : req.mode);
        const ratingsRaw = req.cookies.ratings;
        const ratingsArr = isGuest ? ['sfw'] : ((reqMode === 2 || reqMode === 3) ? null : (ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null));

        const tag = query.tag || null;
        const hall = query.hall || null;
        const user = query.user || null;
        const userHall = query.userHall || null;
        const userHallOwner = query.userHallOwner || null;
        const isFav = query.fav === 'true';
        const isStrict = query.strict === '1';
        const cookieMime = req.cookies?.mime !== undefined ? (decodeURIComponent(req.cookies.mime).trim() || null) : null;
        const mime = (typeof query.mime !== 'undefined') ? (query.mime || null) : (cookieMime || null);

        // Resolve random item ID
        const randomData = await f0cklib.getRandom({
            user, tag, hall, userHall, userHallOwner, mime,
            fav: isFav,
            mode: reqMode,
            ratings: ratingsArr && ratingsArr.length > 0 ? ratingsArr : null,
            strict: isStrict,
            session: req.session,
            exclude: req.session?.excluded_tags || [],
            user_id: req.session?.id,
            is_admin: req.session?.admin
        });
        const tRandom = Date.now();
        if (!randomData || !randomData.itemid) {
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: '', error: true, success: false, message: 'No items found' })
            });
        }

        const itemid = String(randomData.itemid);

        // Build context URL for the resolved item
        let contextUrl = `/${itemid}`;
        if (tag) contextUrl = `/tag/${encodeURIComponent(tag)}/${itemid}`;
        if (hall) contextUrl = `/h/${encodeURIComponent(hall)}/${itemid}`;
        if (userHall && userHallOwner) {
            contextUrl = `/user/${encodeURIComponent(userHallOwner)}/hall/${encodeURIComponent(userHall)}/${itemid}`;
        } else if (user) {
            contextUrl = isFav
                ? `/user/${encodeURIComponent(user)}/favs/${itemid}`
                : `/user/${encodeURIComponent(user)}/${itemid}`;
        } else if (isFav) {
            contextUrl = `/favs/${itemid}`;
        }
        if (mime) {
            contextUrl = contextUrl.replace(new RegExp(`/${itemid}$`), `/${mime}/${itemid}`);
        }

        if (cfg.main.development) console.log(`[${new Date().toISOString()}] [AJAX-RANDOM] Resolved random item ${itemid} in ${Date.now() - tAjaxStart}ms`);

        // Now run the full item load pipeline (same as /ajax/item/:id)
        const bypassFilter = !!(query.bypass === '1');
        const data = await f0cklib.getf0ck({
            itemid: itemid,
            mode: reqMode,
            ratings: ratingsArr,
            bypass_filter: bypassFilter,
            session: req.session,
            url: contextUrl,
            user: user,
            tag: tag,
            hall: hall,
            userHall: userHall,
            userHallOwner: userHallOwner,
            mime: mime,
            fav: isFav,
            ids: null,
            random: true,
            strict: isStrict || req.session?.strict_mode,
            explicitStrict: isStrict,
            exclude: req.session ? (req.session.excluded_tags || []) : [],
            user_id: req.session?.id,
            subf0ck: query.subf0ck || null
        });
        const tAjaxFetch = Date.now();

        if (!data.success) {
            const { t: tErr } = createI18n(req.session?.language || req.lang || 'en');
            const modeLabels = { 0: 'SFW', 1: 'NSFW', 2: 'Unrated', 4: 'NSFL' };
            const errorModeLabel = reqMode !== 3 ? (modeLabels[reqMode] || 'SFW') : null;
            const errorHtml = tpl.render('error-partial', {
                message: tErr('error.post_not_visible'),
                tmp: null,
                session: req.session ? { ...req.session } : false,
                item_id: data.item?.id || itemid,
                item_slug: data.item?.slug || null,
                error_mode_label: errorModeLabel,
                error_filter_hint: errorModeLabel ? tErr('error.filter_hint', { mode: `<strong>${errorModeLabel}</strong>` }) : null,
                error_filter_hint_link: tErr('error.filter_hint_link'),
                error_see_anyways: tErr('error.see_anyways')
            }, req);
            return res.reply({
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: errorHtml, pagination: '', error: true })
            });
        }

        // xD Score + comments — parallelize subscription + comments fetch
        if (req.session || !cfg.main.hide_comments_from_public) {
            if (req.session?.id && !isPrefetch) {
                f0cklib.markNotificationsRead(req.session.id, itemid).catch(() => {});
            }
            const [sub, commentsForScore] = await Promise.all([
                req.session ? f0cklib.getSubscriptionStatus(req.session.id, itemid) : false,
                f0cklib.getComments(itemid, 'old', false)
            ]);
            data.isSubscribed = sub;
            const xdScore = f0cklib.computeXdScore(commentsForScore);
            const xdMeta  = f0cklib.xdScoreMeta(xdScore);
            data.item.xd_score = xdScore;
            data.item.xd_tier  = xdMeta.tier;
            data.item.xd_label = xdMeta.label;
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

        // Session + template vars
        data.session = req.session ? { ...req.session } : false;
        data.url = { pathname: contextUrl };
        data.fullscreen = req.cookies.fullscreen || 0;
        data.hidePagination = true;

        // Precompute hall display data
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

        // Precomputed template booleans
        if (data.item) {
            const session = data.session;
            const item = data.item;
            // Keep the real uploader for permission checks — anonymization below overwrites item.username
            const _realUsername = item.username;
            if (isAnonymizeSession(req.session)) {
                if (item.src) item.src = null;
                item.username = 'anonymous';
                item.author_banner_file = null;
                item.author_banner_position = null;
                item.author_banner_size = null;
                item.author_avatar = null;
                item.author_avatar_file = null;
                item.author_color = null;
                item.author_description = null;
                item.author_display_name = null;
                item.author_id = null;
                if (data.uploader) {
                    data.uploader.name = 'anonymous';
                    data.uploader.id = null;
                    data.uploader.color = null;
                }
                if (Array.isArray(item.favorites)) {
                    item.favorites = item.favorites.map(f => {
                        const isSelf = session && session.id && f.user_id && Number(f.user_id) === Number(session.id);
                        if (isSelf) return f;
                        return { user_id: null, user: 'anonymous', login: 'anonymous', display_name: 'Anonymous', avatar: null, avatar_file: null, username_color: null, hide_fav_badge: f.hide_fav_badge, is_anon: true };
                    });
                }
            }
            const isAnon = !!(session && (session.is_anon || (session.user && (session.user === 'anonymous' || session.user.startsWith('anon_')))));
            data.is_mod_or_admin = !!(session && (session.admin || session.is_moderator));
            data.can_manage_item = !isAnon && !!(session && (session.admin || session.is_moderator || (session.user && item.username && session.user.toLowerCase() === item.username.toLowerCase())));
            // Rating may also be changed by an anonymous uploader on their own item
            const _ownerName = getSessionOwnerName(session);
            data.can_rate_item = data.can_manage_item || (isAnon && canAnonDo('rate_item') && !!(_ownerName && _realUsername && _ownerName.toLowerCase() === _realUsername.toLowerCase()));
            data.can_extract_meta = !!(item.mime && item.mime.indexOf('flash') === -1 && !(item.mime.startsWith('application/') && cfg.mimes[item.mime] && !['swf', 'pdf'].includes(cfg.mimes[item.mime])));
            data.user_has_favorited = lib.userHasFavorited(session, item.favorites);
            data.halls_slugs = Array.isArray(item.halls) ? item.halls.map(h => h.slug).join(',') : '';
            data.user_halls_slugs = Array.isArray(item.user_halls) ? item.user_halls.map(h => h.slug).join(',') : '';
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

        // Render
        const itemHtml = tpl.render('ajax-item', data, req);
        const paginationHtml = tpl.render('snippets/pagination', data, req);
        const tAjaxRender = Date.now();

        // Detailed timing breakdown
        console.log(`[AJAX-RANDOM] ${itemid} total=${tAjaxRender - tAjaxStart}ms | getRandom=${tRandom - tAjaxStart}ms | getf0ck=${tAjaxFetch - tRandom}ms | aux=${tAjaxAux - tAjaxFetch}ms | render=${tAjaxRender - tAjaxAux}ms`);

        let itemPage = null;
        const effectiveOnara = isOnaraEnabledFor(req, query.onara === '1');
        if (effectiveOnara) {
            try {
                itemPage = await f0cklib.getItemPage({
                    targetItemId: data.item?.id || itemid,
                    targetItemPinned: data.item?.is_pinned,
                    user, tag, hall, userHall, userHallOwner, mime,
                    fav: isFav,
                    mode: reqMode,
                    ratings: ratingsArr && ratingsArr.length > 0 ? ratingsArr : null,
                    strict: isStrict,
                    session: req.session,
                    exclude: req.session ? (req.session.excluded_tags || []) : [],
                    user_id: req.session?.id,
                    is_admin: req.session?.admin,
                    minXdScore: req.url.qs?.min_xd !== undefined ? +req.url.qs.min_xd : (req.session?.min_xd_score || 0),
                    tagger: query.tagger || null
                });
            } catch (_) {}
        }

        const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
        const itemNumericId = data.item?.id ? String(data.item.id) : itemid;
        const itemMode = data.item?.is_nsfl ? 'nsfl' : (data.item?.is_nsfw ? 'nsfw' : (data.item?.is_sfw ? 'sfw' : 'null'));
        const itemTagId = data.item?.tag_id || (data.item?.is_nsfl ? nsflId : (data.item?.is_nsfw ? 2 : (data.item?.is_sfw ? 1 : null)));
        const itemThumb = data.item?.thumb || data.item?.thumbnail || (itemNumericId ? `/t/${itemNumericId}.webp` : null);
        const isAnon = !!(data.is_anonymized || isAnonymizeSession(req.session));
        const itemUser = isAnon
            ? 'anonymous'
            : (data.item?.author_display_name || data.item?.display_name || data.item?.username || 'anonymous');
        const itemUsername = isAnon
            ? 'anonymous'
            : (data.item?.username || 'anonymous');
        const itemMime = data.item?.matching_sub_mime || data.item?.mime || null;
        const itemDest = data.item?.matching_sub_dest || data.item?.dest || null;

        res.reply({
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                html: itemHtml,
                pagination: paginationHtml,
                title: data.title,
                id: itemid,
                numeric_id: itemNumericId,
                slug: data.item?.slug || null,
                page: itemPage,
                thumb: itemThumb,
                mode: itemMode,
                tag_id: itemTagId,
                mime: itemMime,
                user: itemUser,
                username: itemUsername,
                dest: itemDest,
                is_random: true
            })
        });
    });

    router.get(/^\/ajax\/item\/(?<itemid>[a-zA-Z0-9_-]{11}|\d+)/, async (req, res) => {
        const tAjaxStart = Date.now();
        let query = {};
        if (typeof req.url === 'string') {
            const parsedUrl = url.parse(req.url, true);
            query = parsedUrl.query;
        } else {
            // flummpress uses req.url.qs for query string parameters
            query = req.url.qs || {};
        }

        const isPrefetch = !!(
            query.prefetch === '1' ||
            req.url?.qs?.prefetch === '1' ||
            req.headers?.['x-purpose'] === 'prefetch' ||
            req.headers?.['purpose'] === 'prefetch' ||
            req.headers?.['sec-purpose'] === 'prefetch'
        );

        let contextUrl = `/${req.params.itemid}`;
        if (query.tag) contextUrl = `/tag/${encodeURIComponent(query.tag)}/${req.params.itemid}`;
        if (query.hall) contextUrl = `/h/${encodeURIComponent(query.hall)}/${req.params.itemid}`;
        if (query.userHall && query.userHallOwner) {
            contextUrl = `/user/${encodeURIComponent(query.userHallOwner)}/hall/${encodeURIComponent(query.userHall)}/${req.params.itemid}`;
        } else if (query.user) {
            contextUrl = query.fav === 'true'
                ? `/user/${encodeURIComponent(query.user)}/favs/${req.params.itemid}`
                : `/user/${encodeURIComponent(query.user)}/${req.params.itemid}`;
        } else if (query.fav === 'true') {
            contextUrl = `/favs/${req.params.itemid}`;
        }
        if (query.mime) {
            contextUrl = contextUrl.replace(new RegExp(`/${req.params.itemid}$`), `/${query.mime}/${req.params.itemid}`);
        }

        if (cfg.main.development) console.log(`[${new Date().toISOString()}] [AJAX] Starting item load for ${req.params.itemid}`);

        const isGuest = !req.session || !req.session.user;
        const isRandom = query.random === '1' || req.cookies.random_mode === '1';
        const reqMode = isGuest ? 0 : (query.mode !== undefined ? +query.mode : req.mode);
        const ratingsRaw = req.cookies.ratings;
        const ratingsArr = isGuest ? ['sfw'] : ((reqMode === 2 || reqMode === 3) ? null : (ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null));

        const itemid = req.params.itemid || req.url.pathname.match(/\/ajax\/item\/([a-zA-Z0-9_-]{11}|\d+)/)?.[1];
        const bypassFilter = !!(query.force === '1' || query.force === 'true' || query.allow === '1' || query.allow === 'true' || query.bypass === '1' || query.bypass === 'true' || query.see_anyways === '1');
        const data = await f0cklib.getf0ck({
            itemid: itemid,
            mode: reqMode,
            ratings: ratingsArr,
            bypass_filter: bypassFilter,
            session: req.session,
            url: contextUrl,
            user: query.user,
            tag: query.tag,
            hall: query.hall,
            userHall: query.userHall || null,
            userHallOwner: query.userHallOwner || null,
            mime: query.mime || (req.cookies.mime || null),
            fav: query.fav === 'true',
            ids: query.ids || null,
            random: isRandom,
            strict: query.strict === '1' || query.strict === 'true' || req.session?.strict_mode,
            explicitStrict: query.strict === '1' || query.strict === 'true',
            exclude: req.session ? (req.session.excluded_tags || []) : [],
            user_id: req.session?.id,
            subf0ck: query.subf0ck || null
        });
        const tAjaxFetch = Date.now();

        if (!data.success) {
            const reqMode = (query.mode !== undefined ? +query.mode : req.mode) ?? 0;
            const modeLabels = { 0: 'SFW', 1: 'NSFW', 2: 'Unrated', 4: 'NSFL' };
            const errorModeLabel = reqMode !== 3 ? (modeLabels[reqMode] || 'SFW') : null;
            const { t: tErr } = createI18n(req.session?.language || req.lang || 'en');
            const errorHtml = tpl.render('error-partial', {
                message: tErr('error.post_not_visible'),
                tmp: null,
                session: req.session ? { ...req.session } : false,
                item_id: data.item?.id || itemid,
                item_slug: data.item?.slug || (typeof itemid === 'string' ? itemid : null),
                error_mode_label: errorModeLabel,
                error_filter_hint: errorModeLabel ? tErr('error.filter_hint', { mode: `<strong>${errorModeLabel}</strong>` }) : null,
                error_filter_hint_link: tErr('error.filter_hint_link'),
                error_see_anyways: tErr('error.see_anyways')
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
            // Mark notifications as read (only when actually viewed, not on prefetch)
            if (req.session?.id && !isPrefetch) {
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
            // Keep the real uploader for permission checks — anonymization below overwrites item.username
            const _realUsername = item.username;
            // When guest or anon anonymization is active, suppress uploader identity, banner, avatar, and source URL
            if (isAnonymizeSession(req.session)) {
                if (item.src) item.src = null;
                item.username = 'anonymous';
                item.author_banner_file = null;
                item.author_banner_position = null;
                item.author_banner_size = null;
                item.author_avatar = null;
                item.author_avatar_file = null;
                item.author_color = null;
                item.author_description = null;
                item.author_display_name = null;
                item.author_id = null;
                if (data.uploader) {
                    data.uploader.name = 'anonymous';
                    data.uploader.id = null;
                    data.uploader.color = null;
                }
                if (Array.isArray(item.favorites)) {
                    item.favorites = item.favorites.map(f => {
                        const isSelf = session && session.id && f.user_id && Number(f.user_id) === Number(session.id);
                        if (isSelf) return f;
                        return {
                            user_id: null,
                            user: 'anonymous',
                            login: 'anonymous',
                            display_name: 'Anonymous',
                            avatar: null,
                            avatar_file: null,
                            username_color: null,
                            hide_fav_badge: f.hide_fav_badge,
                            is_anon: true
                        };
                    });
                }
            }
            const isAnon = !!(session && (session.is_anon || (session.user && (session.user === 'anonymous' || session.user.startsWith('anon_')))));
            data.is_mod_or_admin = !!(session && (session.admin || session.is_moderator));
            data.can_manage_item = !isAnon && !!(session && (session.admin || session.is_moderator || (session.user && item.username && session.user.toLowerCase() === item.username.toLowerCase())));
            // Rating may also be changed by an anonymous uploader on their own item
            const _ownerName = getSessionOwnerName(session);
            data.can_rate_item = data.can_manage_item || (isAnon && canAnonDo('rate_item') && !!(_ownerName && _realUsername && _ownerName.toLowerCase() === _realUsername.toLowerCase()));
            data.can_extract_meta = !!(item.mime && item.mime.indexOf('flash') === -1 && !(item.mime.startsWith('application/') && cfg.mimes[item.mime] && !['swf', 'pdf'].includes(cfg.mimes[item.mime])));
            data.user_has_favorited = lib.userHasFavorited(session, item.favorites);
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

        let itemPage = null;
        const effectiveOnara = isOnaraEnabledFor(req, query.onara === '1');
        if (effectiveOnara || query.get_page === '1') {
            try {
                itemPage = await f0cklib.getItemPage({
                    targetItemId: data.item?.id || itemid,
                    targetItemPinned: data.item?.is_pinned,
                    user: query.user,
                    tag: query.tag,
                    hall: query.hall,
                    userHall: query.userHall,
                    userHallOwner: query.userHallOwner,
                    mime: query.mime || (req.cookies.mime || null),
                    fav: query.fav === 'true',
                    mode: reqMode,
                    ratings: ratingsArr,
                    strict: query.strict === '1' || query.strict === 'true' || req.session?.strict_mode,
                    session: req.session,
                    exclude: req.session ? (req.session.excluded_tags || []) : [],
                    user_id: req.session?.id,
                    is_admin: req.session?.admin,
                    minXdScore: req.session?.min_xd_score || 0,
                    tagger: query.tagger || null
                });
            } catch (_) {}
        }

        const nsflId = parseInt(cfg.nsfl_tag_id, 10) || 3;
        const itemNumericId = data.item?.id ? String(data.item.id) : (/^\d+$/.test(itemid) ? itemid : null);
        const itemMode = data.item?.is_nsfl ? 'nsfl' : (data.item?.is_nsfw ? 'nsfw' : (data.item?.is_sfw ? 'sfw' : 'null'));
        const itemTagId = data.item?.tag_id || (data.item?.is_nsfl ? nsflId : (data.item?.is_nsfw ? 2 : (data.item?.is_sfw ? 1 : null)));
        const itemThumb = data.item?.thumb || data.item?.thumbnail || (itemNumericId ? `/t/${itemNumericId}.webp` : null);
        const isAnon = !!(data.is_anonymized || isAnonymizeSession(req.session));
        const itemUser = isAnon
            ? 'anonymous'
            : (data.item?.author_display_name || data.item?.display_name || data.item?.username || 'anonymous');
        const itemUsername = isAnon
            ? 'anonymous'
            : (data.item?.username || 'anonymous');
        const itemMime = data.item?.matching_sub_mime || data.item?.mime || null;
        const itemDest = data.item?.matching_sub_dest || data.item?.dest || null;

        res.reply({
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                html: itemHtml,
                pagination: paginationHtml,
                title: data.title,
                id: itemid,
                numeric_id: itemNumericId,
                slug: data.item?.slug || null,
                page: itemPage,
                thumb: itemThumb,
                mode: itemMode,
                tag_id: itemTagId,
                mime: itemMime,
                user: itemUser,
                username: itemUsername,
                dest: itemDest
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
    router.get(/^\/ajax\/items/, async (req, res) => {
        let query = {};
        if (typeof req.url === 'string') {
            const parsedUrl = url.parse(req.url, true);
            query = parsedUrl.query;
        } else {
            query = req.url.qs || {};
        }

        const isGuest = !req.session || !req.session.user;
        const page = parseInt(query.page) || 1;
        const isRandom = query.random === '1' || req.cookies.random_mode === '1';
        const ratingsRaw = req.cookies.ratings;
        const ratingsArr = isGuest ? ['sfw'] : (ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null);

        const data = await f0cklib.getf0cks({
            page: page,
            tag: query.tag || null,
            hall: query.hall || null,
            user: query.user || null,
            userHall: query.userHall || null,
            userHallOwner: query.userHallOwner || null,
            mime: query.mime || (req.cookies.mime || null),
            mode: isGuest ? 0 : (query.mode !== undefined ? +query.mode : req.mode),
            ratings: ratingsArr,
            session: req.session,
            user_id: req.session?.id,
            is_admin: req.session?.admin,
            exclude: req.session ? (req.session.excluded_tags || []) : [],
            fav: query.fav === 'true',
            ids: query.ids || null,
            total: query.total ? parseInt(query.total, 10) : undefined,
            random: isRandom,
            strict: query.strict === '1' || query.strict === 'true' || req.session?.strict_mode,
            explicitStrict: query.strict === '1' || query.strict === 'true',
            newer: query.newer || null,
            minXdScore: req.session?.min_xd_score || 0,
            tagger: query.tagger || null
        });

        if (!data.success) {
            if (data.is_private) {
                const { t: tErr } = createI18n(req.session?.language || req.lang || 'en');
                const privateHtml = `<div class="private-favs-msg" style="padding: 30px; text-align: center; color: var(--text-muted); font-size: 1.1em;">${tErr('profile.private_favorites')}</div>`;
                return res.reply({
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        success: false,
                        is_private: true,
                        html: privateHtml,
                        hasMore: false
                    })
                });
            }
        }

        // An empty first page is still a valid grid: keep the page-1 pagination
        // and show the empty-state message (matches the full-page index route).
        // Later pages and "newer" polls keep failing so infinite scroll just stops.
        if (!data.success && page === 1 && !query.newer) {
            data.items = [];
            data.pagination = { start: 1, end: 1, current: 1, page: 1, cheat: [1], prev: null, next: null };
            data.total = 0;
            data.success = true;
            if (!data.link) {
                if (query.hall) data.link = { main: '/h/' + encodeURIComponent(query.hall) + '/', path: 'p/', suffix: '' };
                else if (query.tag) data.link = { main: '/tag/' + encodeURIComponent(query.tag) + '/', path: 'p/', suffix: '' };
                else data.link = { main: '/', path: 'p/', suffix: '' };
            }
        }

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
        const itemsHtml = data.items.length
            ? tpl.render('snippets/items-grid', { items: data.items, link: data.link }, req)
            : '<div class="no-results">No f0cks found :(</div>';

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
                'Cache-Control': 'no-cache, must-revalidate, proxy-revalidate',
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
