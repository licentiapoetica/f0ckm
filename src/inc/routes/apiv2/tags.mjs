import db from '../../sql.mjs';
import lib from '../../lib.mjs';
import audit from "../../audit.mjs";
import queue from "../../queue.mjs";
import cfg from "../../config.mjs";
import fs from "fs";
import path from "path";

export default router => {
  router.group(/^\/api\/v2\/tags\/(?<postid>\d+)/, group => {
    group.get(/$/, lib.loggedin, async (req, res) => {
      // get tags
      if (!req.params.postid) {
        return res.json({
          success: false,
          msg: 'missing postid'
        });
      }

      return res.json({
        success: true,
        tags: await lib.getTags(+req.params.postid)
      });
    });

    group.post(/$/, lib.loggedin, async (req, res) => {
      // assign and/or create tag
      if (!req.params.postid || !req.post.tagname) {
        return res.json({
          success: false,
          msg: 'missing postid or tag'
        });
      }

      const postid = +req.params.postid;
      const tagname = req.post.tagname?.trim();
      const protectedTags = ['sfw', 'nsfw', 'nsfl'];

      if (protectedTags.includes(tagname.toLowerCase())) {
        return res.json({
          success: false,
          msg: `The tag "${tagname}" is reserved for system rating modes.`
        });
      }

      if (tagname.length > 70) {
        return res.json({
          success: false,
          msg: 'tag is too long!'
        });
      }

      try {
        let tagid = (await db`
          select id
          from "tags"
          where normalized = slugify(${tagname})
        `)?.[0]?.id;

        if (!tagid) { // create new tag
          tagid = (await db`
            insert into "tags" ${db({
            tag: tagname
          })
            }
            returning id
          `)[0].id;
        }

        await db`
          insert into "tags_assign" ${db({
          tag_id: +tagid,
          item_id: +postid,
          user_id: +req.session.id
        })
          }
        `;
      } catch (err) {
        const isDuplicate = err.code === '23505' || err.constraint?.includes('tags_assign');
        return res.json({
          success: false,
          msg: isDuplicate ? 'Tag already exists' : 'Failed to add tag',
          tags: await lib.getTags(postid)
        });
      }

      const freshTags = await lib.getTags(postid);
      console.log(`[API] Notifying 'tags' for item ${postid} with ${freshTags.length} tags`);
      await db.notify('tags', JSON.stringify({ item_id: postid, fresh: true, tags: freshTags }));

      return res.json({
        success: true,
        postid: postid,
        tag: tagname,
        tags: freshTags
      });
    });

    group.put(/\/cycle-rating$/, lib.modAuth, async (req, res) => {
      if (!req.params.postid) return res.json({ success: false, msg: 'missing postid' });

      const postid = +req.params.postid;
      const nsflId = cfg.nsfl_tag_id || 3;
      // Cycle: SFW(1) → NSFW(2) → NSFL(nsflId) → SFW(1); untagged items jump straight to SFW
      const cycle = [1, 2, nsflId];
      const currentTags = await lib.getTags(postid);
      const ratingTagId = currentTags.find(t => [1, 2, nsflId].includes(t.id))?.id ?? 0;
      const cycleIdx = cycle.indexOf(ratingTagId); // -1 if untagged → (−1+1)%3 = 0 → SFW
      const nextTagId = cycle[(cycleIdx + 1) % cycle.length];

      try {
        // Remove any existing rating tag
        await db`DELETE FROM tags_assign WHERE item_id = ${postid} AND tag_id = ANY(ARRAY[1, 2, ${nsflId}]::int[])`;
        if (nextTagId > 0) {
          await db`INSERT INTO tags_assign ${db({ tag_id: nextTagId, item_id: postid, user_id: +req.session.id })}`;
        }

        // Automatically generate blurred thumbnail if cycling TO NSFW or NSFL
        if (nextTagId === 2 || nextTagId === nsflId) {
          const blurPath = path.join(cfg.paths.t, `${postid}_blur.webp`);
          try {
            await fs.promises.access(blurPath);
          } catch {
            await queue.genBlurredThumbnail(postid, false);
          }
        }

        const labels = { 1: { label: 'SFW', cls: 'sfw' }, 2: { label: 'NSFW', cls: 'nsfw' }, [nsflId]: { label: 'NSFL', cls: 'nsfl' } };
        const { label, cls } = labels[nextTagId];

        await audit.log(req.session.id, 'cycle_rating', 'item', postid, { from: ratingTagId, to: nextTagId });
        const freshTags = await lib.getTags(postid);
        await db.notify('tags', JSON.stringify({ item_id: postid, fresh: true, tags: freshTags }));

        return res.json({ success: true, rating_tag_id: nextTagId, rating_label: label, rating_class: cls });
      } catch (err) {
        return res.json({ success: false, msg: 'Failed to update rating' });
      }
    });

    group.put(/\/toggle$/, lib.modAuth, async (req, res) => {
      // xD
      if (!req.params.postid) {
        return res.json({
          success: false,
          msg: 'missing postid'
        });
      }

      const postid = +req.params.postid;
      const currentTags = await lib.getTags(postid);
      const hasSFW = currentTags.some(tag => tag.id === 1);
      const hasNSFW = currentTags.some(tag => tag.id === 2);

      let auditDetails = { tag: 'sfw' };

      if (!hasSFW && !hasNSFW) {
        // insert
        await db`
          insert into "tags_assign" ${db({
          item_id: +postid,
          tag_id: 1,
          user_id: +req.session.id
        })
          }
        `;
        auditDetails = { tag: 'sfw', action: 'added' };
      }
      else {
        // update
        await db`
          update "tags_assign"
          set tag_id = (array[2,1])[tag_id]
          where tag_id = any(array[1,2])
          and item_id = ${+postid}
        `;
        if (hasSFW) auditDetails = { tag: 'nsfw', from: 'sfw' };
        if (hasNSFW) auditDetails = { tag: 'sfw', from: 'nsfw' };
      }

      await audit.log(req.session.id, 'toggle_tag', 'item', postid, auditDetails);

      // Generate blurred thumbnail if toggling TO NSFW
      if (hasSFW && !hasNSFW) {
        // Was SFW, now NSFW - check if blur exists and generate if not
        const blurPath = path.join(cfg.paths.t, `${postid}_blur.webp`);
        try {
          await fs.promises.access(blurPath);
        } catch {
          // Doesn't exist - generate it
          await queue.genBlurredThumbnail(postid, false);
        }
      }

      const freshTags = await lib.getTags(postid);
      console.log(`[API] Notifying 'tags' (toggle) for item ${postid}`);
      await db.notify('tags', JSON.stringify({ item_id: postid, fresh: true, tags: freshTags }));

      return res.json({
        success: true,
        tags: freshTags
      });
    });

    group.delete(/\/(?<tagname>.*)/, lib.modAuth, async (req, res) => {
      // delete tag
      if (!req.params.postid || !req.params.tagname) {
        return res.json({
          success: false,
          msg: 'missing postid or tagname'
        });
      }

      const postid = +req.params.postid;
      const tagname = decodeURIComponent(req.params.tagname);

      const tags = await lib.getTags(postid);

      const tagid = tags.filter(t => t.tag === tagname)[0]?.id ?? null;

      if (!tagid) {
        return res.json({
          success: false,
          msg: 'tag is not assigned',
          tags: await lib.getTags(postid)
        });
      }

      let q = await db`
        delete from "tags_assign"
        where tag_id = ${+tagid}
        and item_id = ${+postid}
      `;
      const reply = !!q;

      if (reply) {
        const reason = req.post.reason || req.url.qs.reason || 'No reason provided';
        await audit.log(req.session.id, 'delete_tag', 'item', postid, { tag: tagname, reason });
      }

      const freshTags = await lib.getTags(postid);
      console.log(`[API] Notifying 'tags' (delete) for item ${postid}`);
      await db.notify('tags', JSON.stringify({ item_id: postid, fresh: true, tags: freshTags }));

      return res.json({
        success: reply,
        tagid,
        tags: freshTags
      })
    });

  });

  return router;
};