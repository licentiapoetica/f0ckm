import cfg from "../../inc/config.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";

export default (router, tpl) => {
  router.get(/^\/random$/, async (req, res) => {
    let referer = req.headers.referer ?? '';
    let opts = {};

    if (referer) {
      try {
        const refUrl = new URL(referer);
        const path = refUrl.pathname;
        const query = refUrl.search;

        console.log("[RANDOM] Parsing referer path:", path);

        // Regex that is less strict about start/end but captures groups
        // Captures: /h/slug, /tag/name, /user/name/(f0cks|favs), /(video|audio|image), /p/N, /ID
        const hallMatch = path.match(/\/h\/(?<hall>[^/]+)/);
        const tagMatch = path.match(/\/tag\/(?<tag>[^/]+)/);
        const userMatch = path.match(/\/user\/(?<user>[^/]+)\/(?<mode>f0cks|favs)/);
        const mimeMatch = path.match(/\/(?<mime>(?:video|audio|image)(?:,(?:video|audio|image))*)/);
        const pageMatch = path.match(/\/p\/(?<page>\d+)/);
        const itemMatch = path.match(/\/(?<itemid>\d+)$/);

        if (hallMatch) opts.hall = hallMatch.groups.hall;
        if (tagMatch) opts.tag = tagMatch.groups.tag;
        if (userMatch) {
          opts.user = userMatch.groups.user;
          opts.mode = userMatch.groups.mode;
        }
        if (mimeMatch) opts.mime = mimeMatch.groups.mime;
        if (pageMatch) opts.page = pageMatch.groups.page;
        if (query.includes('strict=1')) opts.strict = true;

        console.log("[RANDOM] Detected opts:", opts);
      } catch (e) {
        console.error("[RANDOM] Failed to parse referer URL:", referer, e);
      }
    }

    const ratingsRaw = req.cookies.ratings;
    const ratingsArr = ratingsRaw ? decodeURIComponent(ratingsRaw).split(/[|,]/).filter(r => ['sfw','nsfw','nsfl','untagged'].includes(r)) : null;
    console.log('[RANDOM] ratings cookie:', ratingsRaw, '→ parsed:', ratingsArr);

    const cookieMime = req.cookies?.mime !== undefined ? (decodeURIComponent(req.cookies.mime).trim() || null) : null;
    const reqQueryMime = req.url?.searchParams?.get('mime') || req.url?.qs?.mime;
    const effectiveMime = (reqQueryMime !== undefined && reqQueryMime !== null) ? reqQueryMime : (cookieMime || opts.mime || null);

    const data = await f0cklib.getRandom({
      user: opts.user,
      tag: opts.tag,
      hall: opts.hall,
      mime: effectiveMime,
      page: opts.page,
      fav: opts.mode === 'favs',
      mode: req.mode,
      ratings: ratingsArr,
      strict: opts.strict,
      session: req.session
    });

    console.log("data", data);

    if (!data.success) {
      return res.reply({
        code: 404,
        body: tpl.render('error', {
          message: data.message,
          tmp: null,
          session: req.session ? { ...req.session } : false,
          error_filter_hint: null,
          error_filter_hint_link: null,
          error_see_anyways: null
        }, req)
      });
    }

    res.redirect(encodeURI(`${data.link.main}${data.link.path}${data.itemid}${data.link.suffix || ''}`) + '?random=1');
  });

  return router;
};