import cfg from "../config.mjs";
import security from "../security.mjs";

export default (router, tpl) => {
    router.get(/^\/banned\/?$/, async (req, res) => {
        let isBanned = false;
        let reason = 'Violation of community rules';
        let expires = null;

        if (req.session && req.session.banned) {
            isBanned = true;
            reason = req.session.ban_reason || reason;
            expires = req.session.ban_expires;
        }

        const clientIp = security.getRealIP(req);
        const ipBan = await security.isIpBanned(clientIp);
        if (ipBan) {
            isBanned = true;
            reason = ipBan.reason || reason;
            expires = ipBan.expires;
        }

        const fp = req.session?.fingerprint || req.session?.anon_fingerprint;
        if (fp) {
            const fpBan = await security.isFingerprintBanned(fp);
            if (fpBan) {
                isBanned = true;
                reason = fpBan.reason || reason;
                expires = fpBan.expires;
            }
        }

        if (req.cookies && req.cookies.f0ck_banned) {
            try {
                const bData = JSON.parse(decodeURIComponent(req.cookies.f0ck_banned));
                if (bData && (bData.reason || bData.banned)) {
                    isBanned = true;
                    reason = bData.reason || reason;
                    expires = bData.expires || expires;
                }
            } catch (e) {}
        }

        res.reply({
            body: tpl.render("banned", {
                session: req.session,
                reason: reason,
                expires: expires ? new Date(expires).toLocaleString() : 'Permanent',
                isBanned: isBanned,
                clientIp: clientIp,
                page_meta: {
                    title: isBanned ? 'Banned' : 'Ban Status'
                }
            }, req)
        });
    });

    return router;
};
