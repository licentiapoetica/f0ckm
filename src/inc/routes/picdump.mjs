import db from "../../inc/sql.mjs";
import cfg from "../../inc/config.mjs";
import f0cklib from "../routeinc/f0cklib.mjs";

export default (router, tpl) => {
  router.get(/^\/picdump$/, async (req, res) => {
    const dump = await db`
      SELECT *
      FROM items
      WHERE (
        to_timestamp(stamp) >= date_trunc('week', CURRENT_TIMESTAMP - interval '1 week') AND
        to_timestamp(stamp) < date_trunc('week', CURRENT_TIMESTAMP)
      ) AND
      mime LIKE 'image/%'
      ORDER BY stamp DESC
    `;

    res.reply({
      body: tpl.render('picdump', {
        dump,
        tmp: null
      }, req)
    });
  });
  return router;
};
