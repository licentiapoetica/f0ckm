import cfg from "../config.mjs";

export default (router, tpl) => {
  router.get(/^\/matrix(\/)?$/, async (req, res) => {
    res.reply({
      body: tpl.render("matrix", {
        session: req.session,
        tmp: null
      }, req)
    });
  });
};
