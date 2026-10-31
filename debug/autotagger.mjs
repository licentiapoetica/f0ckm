import db from "../src/inc/sql.mjs";
import lib from "../src/inc/lib.mjs";

(async () => {
  const _args = process.argv.slice(2);
  const _from = +_args[0];
  const _to = _from + 500;

  const f0cks = await db`
    select *
    from items
    where
      id not in (select item_id from tags_assign group by item_id) and
      mime like 'image/%' and
      id between ${_from} and ${_to}
  `;

  console.time('blah');
  for(let f of f0cks) {
    const tmp = await lib.detectNSFW(f.dest);

    console.log(
      'https://f0ck.me/' + f.id,
      tmp.isNSFW,
      tmp.score.toFixed(2),
      {
        sexy: tmp.scores.sexy.toFixed(2),
        porn: tmp.scores.porn.toFixed(2),
        hentai: tmp.scores.hentai.toFixed(2),
        neutral: tmp.scores.neutral.toFixed(2)
      }
    );

    await db`
      insert into "tags_assign" ${
        db({
          item_id: f.id,
          tag_id: tmp.nsfw ? 2 : 1,
          user_id: 1
        })
      }
    `;

    if(tmp.hentai >= .7) {
      await db`
        insert into "tags_assign" ${
          db({
            item_id: f.id,
            tag_id: 4, // hentai
            user_id: 1 // autotagger
          })
        }
      `;
    }

  };

  console.timeEnd('blah');
  process.exit();
})();
