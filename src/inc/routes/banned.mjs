import cfg from "../config.mjs";

export default (router, tpl) => {
    router.get(/^\/banned\/?$/, async (req, res) => {
        if (!req.session || !req.session.banned) {
            return res.writeHead(302, {
                "Location": "/"
            }).end();
        }

        res.reply({
            body: tpl.render("banned", {
                session: req.session,
                reason: req.session.ban_reason,
                expires: req.session.ban_expires ? new Date(req.session.ban_expires).toLocaleString() : 'Permanent',
                ban_video: cfg.websrv.ban_video,
                hideNavbar: true
            }, req)
        });
    });

    return router;
};
