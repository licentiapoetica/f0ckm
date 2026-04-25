import cfg from "../config.mjs";
import lib from "../lib.mjs";

export default (router, tpl) => {
  router.get(/^\/theme\//, async (req, res) => {
    let theme = req.url.pathname.split('/')[2] ?? cfg.websrv.themes[0];
    if(!cfg.websrv.themes.includes(theme))
      theme = cfg.websrv.themes[0];

    return res.writeHead(301, {
      "Cache-Control": "no-cache, public",
      "Set-Cookie": `theme=${theme}; ${lib.getCookieOptions(null, false)}`,
      "Location": req.headers.referer ?? "/"
    }).end();
  });

  router.get(/^\/tfull\//, async (req, res) => {
    let full = req.session.fullscreen;
    if(full == 1)
      full = 0;
    else
      full = 1;
    
    return res.writeHead(301, {
      "Cache-Control": "no-cache, public",
      "Set-Cookie": `fullscreen=${full}; ${lib.getCookieOptions(null, false)}`,
      "Location": req.headers.referer ?? "/"
    }).end();
  });
  return router;
};
