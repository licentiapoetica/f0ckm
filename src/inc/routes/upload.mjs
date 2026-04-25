import lib from "../lib.mjs";
import db from "../sql.mjs";
import cfg from "../config.mjs";
import { getMinTags } from "../settings.mjs";

export default (router, tpl) => {
  router.get(/^\/upload$/, lib.userauth, async (req, res) => {
    let maxfilesize = cfg.main.maxfilesize;
    if (req.session.admin || req.session.is_moderator) {
        maxfilesize = Math.floor(maxfilesize * cfg.main.adminmultiplier);
    }
    const max_file_size = lib.formatSize(maxfilesize);

    // Calculate uploads remaining (admins/mods are exempt)
    let uploads_remaining = null;
    if (!req.session.admin && !req.session.is_moderator) {
        const twelveHoursAgo = ~~(Date.now() / 1000) - (12 * 3600);
        const uploadCount = await db`
            SELECT count(*) as count
            FROM items
            WHERE username = ${req.session.user}
            AND stamp > ${twelveHoursAgo}
            AND is_deleted = false
        `;
        uploads_remaining = Math.max(0, cfg.main.upload_limit - parseInt(uploadCount[0].count));
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    res.reply({
      body: tpl.render('upload', {
        tmp: null,
        session: (req.session && req.session.user) ? { ...req.session } : false,
        max_file_size: max_file_size,
        min_tags: getMinTags(),
        uploads_remaining: uploads_remaining,
        allowed_mimes: Object.keys(cfg.mimes).join(','),
        mimes_json: JSON.stringify(cfg.mimes),
        web_url_upload: !!cfg.websrv.web_url_upload,
        page_meta: {
          title: 'upload',
          description: 'Upload content to w0bm',
          url: `https://${cfg.main.url.domain}/upload`
        }
      }, req)
    });
  });
  return router;
};
