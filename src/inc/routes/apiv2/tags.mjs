import db from '../../sql.mjs';
import lib from '../../lib.mjs';
import audit from "../../audit.mjs";
import queue from "../../queue.mjs";
import cfg from "../../config.mjs";
import fs from "fs";
import path from "path";
import { logAnonActivity } from "../../anon_auth.mjs";
import { canAnonDo, isAnonSession, getSessionOwnerName } from "../../settings.mjs";

export default router => {
  router.post(/^\/api\/v2\/tags\/bulk\/?$/, lib.loggedin, async (req, res) => {
    const isModOrAdmin = !!(req.session?.admin || req.session?.is_moderator);
    if (!isModOrAdmin) {
      return res.json({ success: false, msg: 'Bulk selection is only available to administrators and moderators' }, 403);
    }

    const action = req.body?.action || req.post?.action || 'add';
    const rawIds = req.body?.item_ids || req.post?.item_ids;
    if (!rawIds || !Array.isArray(rawIds) || rawIds.length === 0) {
      return res.json({ success: false, msg: 'No items selected' }, 400);
    }

    // Sanitize item IDs
    const itemIds = [...new Set(rawIds.map(id => +id).filter(id => Number.isInteger(id) && id > 0))].slice(0, 500);
    if (itemIds.length === 0) {
      return res.json({ success: false, msg: 'Invalid item IDs' }, 400);
    }

    // 1. ADD TAGS
    if (action === 'add') {
      if (isAnonSession(req.session) && !canAnonDo('tag')) {
        return res.json({ success: false, msg: 'Anonymous tagging is disabled' }, 403);
      }

      let rawTags = req.body?.tags || req.post?.tags;
      if (typeof rawTags === 'string') {
        rawTags = rawTags.split(/[\n,]+/).map(t => t.trim()).filter(Boolean);
      }
      if (!Array.isArray(rawTags) || rawTags.length === 0) {
        return res.json({ success: false, msg: 'No tags provided' }, 400);
      }

      const protectedTags = ['sfw', 'nsfw', 'nsfl'];
      const validTags = [...new Set(
        rawTags
          .map(t => (typeof t === 'string' ? t.trim() : ''))
          .filter(t => t.length > 0 && t.length <= 85 && !protectedTags.includes(t.toLowerCase()))
      )];

      if (validTags.length === 0) {
        return res.json({ success: false, msg: 'Tags invalid or contain only reserved names' }, 400);
      }

      try {
        const tagIds = [];
        for (const tagname of validTags) {
          let tagRow = await db`
            SELECT id FROM "tags"
            WHERE normalized = slugify(${tagname})
            LIMIT 1
          `;
          let tagid = tagRow?.[0]?.id;
          if (!tagid) {
            const created = await db`
              INSERT INTO "tags" ${db({ tag: tagname })}
              RETURNING id
            `;
            tagid = created?.[0]?.id;
          }
          if (tagid) tagIds.push({ id: +tagid, name: tagname });
        }

        // Insert assignments
        for (const postid of itemIds) {
          for (const { id: tagid } of tagIds) {
            try {
              await db`
                INSERT INTO "tags_assign" (tag_id, item_id, user_id)
                VALUES (${tagid}, ${postid}, ${+req.session.id})
                ON CONFLICT DO NOTHING
              `;
            } catch (assignErr) {
              // Ignore duplicate errors if table has constraint
              if (assignErr.code !== '23505') {
                console.warn(`[BULK_TAG_ASSIGN_WARN] Item ${postid}, tag ${tagid}:`, assignErr.message);
              }
            }
          }
        }

        await audit.log(req.session.id, 'bulk_add_tags', 'items', null, { item_ids: itemIds, tags: validTags }).catch(() => {});
        if (req.session?.is_anon) {
          await logAnonActivity(req, {
            action: 'bulk_tag',
            targetId: itemIds[0],
            details: { item_ids: itemIds, tags: validTags }
          }).catch(() => {});
        }

        // Notify affected items asynchronously
        (async () => {
          for (const postid of itemIds) {
            try {
              const freshTags = await lib.getTags(postid);
              await db.notify('tags', JSON.stringify({ item_id: postid, fresh: true, tags: freshTags }));
            } catch {}
          }
        })().catch(() => {});

        return res.json({
          success: true,
          count: itemIds.length,
          tags: validTags,
          msg: `Successfully added ${validTags.length} tag(s) to ${itemIds.length} item(s)`
        });
      } catch (err) {
        console.error('[BULK_ADD_TAGS_ERROR]', err);
        return res.json({ success: false, msg: 'Failed to add tags' }, 500);
      }
    }

    // 2. REMOVE TAGS
    if (action === 'remove') {
      const isModOrAdmin = !!(req.session.admin || req.session.is_moderator);

      let rawTags = req.body?.tags || req.post?.tags;
      if (typeof rawTags === 'string') {
        rawTags = rawTags.split(/[\n,]+/).map(t => t.trim()).filter(Boolean);
      }
      if (!Array.isArray(rawTags) || rawTags.length === 0) {
        return res.json({ success: false, msg: 'No tags provided to remove' }, 400);
      }

      try {
        // Resolve tags to remove
        const tagRows = await db`
          SELECT id, tag, normalized FROM "tags"
          WHERE normalized IN ${db(rawTags.map(t => t.trim().toLowerCase()))}
        `;
        if (tagRows.length === 0) {
          return res.json({ success: false, msg: 'Tags not found' }, 404);
        }
        const tagIds = tagRows.map(r => r.id);

        if (isModOrAdmin) {
          await db`
            DELETE FROM "tags_assign"
            WHERE item_id IN ${db(itemIds)}
              AND tag_id IN ${db(tagIds)}
          `;
        } else {
          // Normal user can only remove tags from items they own
          await db`
            DELETE FROM "tags_assign"
            WHERE item_id IN ${db(itemIds)}
              AND tag_id IN ${db(tagIds)}
              AND item_id IN (
                SELECT id FROM items WHERE username = ${getSessionOwnerName(req.session)}
              )
          `;
        }

        await audit.log(req.session.id, 'bulk_remove_tags', 'items', null, { item_ids: itemIds, tags: tagRows.map(r => r.tag) }).catch(() => {});

        // Realtime notifications
        (async () => {
          for (const postid of itemIds) {
            try {
              const freshTags = await lib.getTags(postid);
              await db.notify('tags', JSON.stringify({ item_id: postid, fresh: true, tags: freshTags }));
            } catch {}
          }
        })().catch(() => {});

        return res.json({
          success: true,
          count: itemIds.length,
          msg: `Successfully removed tag(s) from ${itemIds.length} item(s)`
        });
      } catch (err) {
        console.error('[BULK_REMOVE_TAGS_ERROR]', err);
        return res.json({ success: false, msg: 'Failed to remove tags' }, 500);
      }
    }

    // 3. SET RATING (sfw / nsfw / nsfl)
    if (action === 'set_rating') {
      if (isAnonSession(req.session) && !canAnonDo('rate_item')) {
        return res.json({ success: false, msg: 'Anonymous rating is disabled' }, 403);
      }

      const rating = (req.body?.rating || req.post?.rating || '').toLowerCase();
      if (!['sfw', 'nsfw', 'nsfl'].includes(rating)) {
        return res.json({ success: false, msg: 'Invalid rating. Choose sfw, nsfw, or nsfl' }, 400);
      }

      const isModOrAdmin = !!(req.session.admin || req.session.is_moderator);
      const nsflTagRow = await db`SELECT id FROM tags WHERE normalized = 'nsfl' LIMIT 1`;
      const nsflId = nsflTagRow.length > 0 ? nsflTagRow[0].id : (cfg.nsfl_tag_id || 11517);
      const targetTagId = rating === 'sfw' ? 1 : (rating === 'nsfw' ? 2 : nsflId);

      try {
        let eligibleIds = itemIds;
        if (!isModOrAdmin) {
          const ownedItems = await db`
            SELECT id FROM items
            WHERE id IN ${db(itemIds)}
              AND username = ${getSessionOwnerName(req.session)}
              AND active = true AND is_deleted = false
          `;
          eligibleIds = ownedItems.map(r => r.id);
        }

        if (eligibleIds.length === 0) {
          return res.json({ success: false, msg: 'You do not have permission to rate the selected items' }, 403);
        }

        await db.begin(async sql => {
          // Delete existing rating tags
          await sql`
            DELETE FROM tags_assign
            WHERE item_id IN ${sql(eligibleIds)}
              AND (tag_id IN (1, 2, ${nsflId}) OR tag_id IN (SELECT id FROM tags WHERE normalized IN ('sfw', 'nsfw', 'nsfl')))
          `;

          // Insert new rating tags
          for (const id of eligibleIds) {
            await sql`
              INSERT INTO tags_assign (item_id, tag_id, user_id)
              VALUES (${id}, ${targetTagId}, ${+req.session.id})
            `;
          }
        });

        await audit.log(req.session.id, 'bulk_set_rating', 'items', null, { item_ids: eligibleIds, rating }).catch(() => {});

        // Queue blur thumbnail verification where needed
        (async () => {
          for (const id of eligibleIds) {
            try {
              const blurPath = path.join(cfg.paths.t, `${id}_blur.webp`);
              await fs.promises.access(blurPath).catch(() => queue.genBlurredThumbnail(id, false));
              const freshTags = await lib.getTags(id);
              await db.notify('tags', JSON.stringify({ item_id: id, fresh: true, tags: freshTags }));
            } catch {}
          }
        })().catch(() => {});

        return res.json({
          success: true,
          count: eligibleIds.length,
          rating,
          msg: `Successfully set rating to ${rating.toUpperCase()} for ${eligibleIds.length} item(s)`
        });
      } catch (err) {
        console.error('[BULK_SET_RATING_ERROR]', err);
        return res.json({ success: false, msg: 'Failed to update rating' }, 500);
      }
    }

    return res.json({ success: false, msg: 'Unknown bulk action' }, 400);
  });

  router.group(/^\/api\/v2\/tags\/(?<postid>\d+)/, group => {
    group.get(/$/, lib.loggedin, async (req, res) => {
      // get tags
      if (!req.params.postid) {
        return res.json({
          success: false,
          msg: 'missing postid'
        });
      }

      const subf0ck = req.url?.qs?.subf0ck_id || req.url?.qs?.subf0ck || null;
      return res.json({
        success: true,
        tags: await lib.getTags(+req.params.postid, req.session, subf0ck)
      });
    });

    group.post(/$/, lib.loggedin, async (req, res) => {
      // assign and/or create tag
      if (isAnonSession(req.session) && !canAnonDo('tag')) {
        return res.json({ success: false, msg: 'Anonymous tagging is disabled' }, 403);
      }
      const rawTagname = req.post?.tagname || req.body?.tagname;
      if (!req.params.postid || !rawTagname) {
        return res.json({
          success: false,
          msg: 'missing postid or tag'
        });
      }

      const postid = +req.params.postid;
      const tagname = rawTagname.trim();
      const protectedTags = ['sfw', 'nsfw', 'nsfl'];

      if (protectedTags.includes(tagname.toLowerCase())) {
        return res.json({
          success: false,
          msg: `The tag "${tagname}" is reserved for system rating modes.`
        });
      }

      if (tagname.length > 85) {
        return res.json({
          success: false,
          msg: 'tag is too long!'
        });
      }

      const subf0ck = req.post?.subf0ck_id || req.body?.subf0ck_id || req.post?.subf0ck || req.body?.subf0ck || null;
      let albumItemId = null;
      if (subf0ck) {
        if (Number.isInteger(+subf0ck) && +subf0ck > 0) {
          const row = await db`SELECT id FROM album_items WHERE (id = ${+subf0ck} OR (item_id = ${postid} AND order_index = ${+subf0ck})) AND item_id = ${postid} LIMIT 1`;
          albumItemId = row?.[0]?.id || null;
        }
        if (!albumItemId) {
          const row = await db`SELECT id FROM album_items WHERE slug = ${String(subf0ck)} AND item_id = ${postid} LIMIT 1`;
          albumItemId = row?.[0]?.id || null;
        }
      }

      const nsflTagRow = await db`SELECT id FROM tags WHERE normalized = 'nsfl' LIMIT 1`;
      const nsflId = nsflTagRow.length > 0 ? nsflTagRow[0].id : (cfg.nsfl_tag_id || 11517);

      try {
        let tagid = (await db`
          select id
          from "tags"
          where normalized = slugify(${tagname})
        `)?.[0]?.id;

        if (!tagid) { // create new tag
          try {
            tagid = (await db`
              insert into "tags" ${db({
              tag: tagname
            })
              }
              returning id
            `)[0].id;
          } catch (e) {
            tagid = (await db`
              select id
              from "tags"
              where normalized = slugify(${tagname})
            `)?.[0]?.id;
          }
        }

        if (albumItemId) {
          await db`
            INSERT INTO "album_items_tags_assign" (album_item_id, tag_id, user_id)
            VALUES (${+albumItemId}, ${+tagid}, ${+req.session.id})
            ON CONFLICT DO NOTHING
          `;
          await db`
            INSERT INTO "tags_assign" (item_id, tag_id, user_id)
            VALUES (${+postid}, ${+tagid}, ${+req.session.id})
            ON CONFLICT DO NOTHING
          `;

          // Ensure this album item also inherits parent's rating tag if it doesn't have one
          const subRating = await db`
            SELECT tag_id FROM album_items_tags_assign
            WHERE album_item_id = ${+albumItemId} AND tag_id IN (1, 2, ${nsflId})
            LIMIT 1
          `;
          if (subRating.length === 0) {
            const parentRating = await db`
              SELECT tag_id FROM tags_assign
              WHERE item_id = ${+postid} AND tag_id IN (1, 2, ${nsflId})
              LIMIT 1
            `;
            if (parentRating.length > 0) {
              await db`
                INSERT INTO album_items_tags_assign (album_item_id, tag_id, user_id)
                VALUES (${+albumItemId}, ${parentRating[0].tag_id}, ${+req.session.id})
                ON CONFLICT DO NOTHING
              `.catch(() => {});
            }
          }
        } else {
          await db`
            insert into "tags_assign" ${db({
            tag_id: +tagid,
            item_id: +postid,
            user_id: +req.session.id
          })
            }
          `;
        }
      } catch (err) {
        console.error('[ADD_TAG_ERROR]', err);
        const isDuplicate = err.code === '23505' || err.constraint?.includes('tags_assign');
        return res.json({
          success: false,
          msg: isDuplicate ? 'Tag already exists' : 'Failed to add tag',
          tags: await lib.getTags(postid, req.session, subf0ck)
        });
      }

      const freshTags = await lib.getTags(postid, req.session, subf0ck);
      if (req.session?.is_anon) {
        await logAnonActivity(req, {
          action: 'tag',
          targetId: postid,
          details: { tag: tagname, subf0ck_id: subf0ck }
        });
      }
      console.log(`[API] Notifying 'tags' for item ${postid} (subf0ck: ${subf0ck || 'none'}) with ${freshTags.length} tags`);
      await db.notify('tags', JSON.stringify({ item_id: postid, subf0ck_id: subf0ck, fresh: true, tags: freshTags }));

      return res.json({
        success: true,
        postid: postid,
        subf0ck_id: subf0ck,
        tag: tagname,
        tags: freshTags
      });
    });

    group.put(/\/cycle-rating$/, lib.loggedin, async (req, res) => {
      if (isAnonSession(req.session) && !canAnonDo('rate_item')) {
        return res.json({ success: false, msg: 'Anonymous rating is disabled' }, 403);
      }
      if (!req.params.postid) return res.json({ success: false, msg: 'missing postid' });

      const postid = +req.params.postid;
      const item = await db`
        SELECT id, username, active, is_deleted 
        FROM items 
        WHERE id = ${postid} AND active = true AND is_deleted = false
        LIMIT 1
      `;
      if (item.length === 0) {
        return res.json({ success: false, msg: 'Item not found' }, 404);
      }

      const ownerName = getSessionOwnerName(req.session);
      const isOwner = !!(item[0].username && ownerName && item[0].username.toLowerCase() === ownerName.toLowerCase());
      const isAdmin = !!(req.session.admin || req.session.is_moderator);
      if (!isOwner && !isAdmin) {
        return res.json({ success: false, msg: 'Unauthorized' }, 403);
      }

      const nsflTagRow = await db`SELECT id FROM tags WHERE normalized = 'nsfl' LIMIT 1`;
      const nsflId = nsflTagRow.length > 0 ? nsflTagRow[0].id : (cfg.nsfl_tag_id || 11517);
      const cycle = [1, 2, nsflId];
      let nextTagId;
      let ratingTagId = 0;

      const subf0ck = req.body?.subf0ck_id || req.post?.subf0ck_id || req.url?.qs?.subf0ck_id || null;
      let albumItemId = null;
      if (subf0ck) {
        if (Number.isInteger(+subf0ck) && +subf0ck > 0) {
          const row = await db`SELECT id FROM album_items WHERE (id = ${+subf0ck} OR (item_id = ${postid} AND order_index = ${+subf0ck})) AND item_id = ${postid} LIMIT 1`;
          albumItemId = row?.[0]?.id || null;
        }
        if (!albumItemId) {
          const row = await db`SELECT id FROM album_items WHERE slug = ${String(subf0ck)} AND item_id = ${postid} LIMIT 1`;
          albumItemId = row?.[0]?.id || null;
        }
      }

      try {
        await db.begin(async sql => {
          // Lock the item row exclusively
          await sql`SELECT id FROM items WHERE id = ${postid} FOR UPDATE`;

          if (albumItemId) {
            const existingRating = await sql`
              SELECT tag_id FROM album_items_tags_assign 
              WHERE album_item_id = ${albumItemId} 
                AND tag_id IN (1, 2, ${nsflId})
              LIMIT 1
            `;
            ratingTagId = existingRating.length > 0 ? existingRating[0].tag_id : 0;
            const reqRating = req.body?.rating || req.post?.rating || req.url?.qs?.rating;
            if (reqRating === 'sfw') {
              nextTagId = 1;
            } else if (reqRating === 'nsfw') {
              nextTagId = 2;
            } else if (reqRating === 'nsfl') {
              nextTagId = nsflId;
            } else {
              const cycleIdx = cycle.indexOf(ratingTagId);
              nextTagId = cycle[(cycleIdx + 1) % cycle.length];
            }

            await sql`
              DELETE FROM album_items_tags_assign 
              WHERE album_item_id = ${albumItemId} 
                AND tag_id IN (1, 2, ${nsflId})
            `;
            if (nextTagId > 0) {
              await sql`
                INSERT INTO album_items_tags_assign (album_item_id, tag_id, user_id)
                VALUES (${albumItemId}, ${nextTagId}, ${+req.session.id})
              `;
            }
          } else {
            const existingRating = await sql`
              SELECT tag_id FROM tags_assign 
              WHERE item_id = ${postid} 
                AND (tag_id IN (1, 2, ${nsflId}) OR tag_id IN (SELECT id FROM tags WHERE normalized IN ('sfw', 'nsfw', 'nsfl')))
              ORDER BY tag_id DESC
              LIMIT 1
            `;

            ratingTagId = existingRating.length > 0 ? existingRating[0].tag_id : 0;
            const reqRating = req.body?.rating || req.post?.rating || req.url?.qs?.rating;
            if (reqRating === 'sfw') {
              nextTagId = 1;
            } else if (reqRating === 'nsfw') {
              nextTagId = 2;
            } else if (reqRating === 'nsfl') {
              nextTagId = nsflId;
            } else {
              const cycleIdx = cycle.indexOf(ratingTagId); // -1 if untagged → (−1+1)%3 = 0 → SFW
              nextTagId = cycle[(cycleIdx + 1) % cycle.length];
            }

            // Remove ALL existing rating tags for this item atomically
            await sql`
              DELETE FROM tags_assign 
              WHERE item_id = ${postid} 
                AND (tag_id IN (1, 2, ${nsflId}) OR tag_id IN (SELECT id FROM tags WHERE normalized IN ('sfw', 'nsfw', 'nsfl')))
            `;

            if (nextTagId > 0) {
              await sql`
                INSERT INTO tags_assign (item_id, tag_id, user_id)
                VALUES (${postid}, ${nextTagId}, ${+req.session.id})
              `;
            }

            // Propagate rating to all album sub-items if this is an album
            const albumCheck = await sql`SELECT id FROM items WHERE id = ${postid} AND is_album = true LIMIT 1`;
            if (albumCheck.length > 0) {
              const subItems = await sql`SELECT id FROM album_items WHERE item_id = ${postid}`;
              for (const sub of subItems) {
                await sql`
                  DELETE FROM album_items_tags_assign
                  WHERE album_item_id = ${sub.id}
                    AND tag_id IN (1, 2, ${nsflId})
                `;
                if (nextTagId > 0) {
                  await sql`
                    INSERT INTO album_items_tags_assign (album_item_id, tag_id, user_id)
                    VALUES (${sub.id}, ${nextTagId}, ${+req.session.id})
                    ON CONFLICT DO NOTHING
                  `;
                }
              }
            }
          }

          // Automatically generate/verify blurred thumbnail on cycle
          const blurPath = path.join(cfg.paths.t, `${postid}_blur.webp`);
          try {
            await fs.promises.access(blurPath);
          } catch {
            await queue.genBlurredThumbnail(postid, false);
          }
        });

        const labels = { 1: { label: 'SFW', cls: 'sfw' }, 2: { label: 'NSFW', cls: 'nsfw' }, [nsflId]: { label: 'NSFL', cls: 'nsfl' } };
        const { label, cls } = labels[nextTagId] || { label: 'SFW', cls: 'sfw' };

        await audit.log(req.session.id, 'cycle_rating', 'item', postid, { from: ratingTagId, to: nextTagId }).catch(() => {});
        if (req.session?.is_anon) {
          await logAnonActivity(req, {
            action: 'cycle_rating',
            targetId: postid,
            details: { from: ratingTagId, to: nextTagId, rating_label: label }
          });
        }
        const freshTags = await lib.getTags(postid);
        await db.notify('tags', JSON.stringify({ item_id: postid, fresh: true, tags: freshTags })).catch(() => {});

        return res.json({ success: true, rating_tag_id: nextTagId, rating_label: label, rating_class: cls });
      } catch (err) {
        console.error('[CYCLE_RATING_ERROR]', err);
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

      // Ensure blurred thumbnail exists on toggle
      const blurPath = path.join(cfg.paths.t, `${postid}_blur.webp`);
      try {
        await fs.promises.access(blurPath);
      } catch {
        // Doesn't exist - generate it
        await queue.genBlurredThumbnail(postid, false);
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

      const subf0ck = req.post?.subf0ck_id || req.body?.subf0ck_id || req.url?.qs?.subf0ck_id || req.url?.qs?.subf0ck || null;
      let albumItemId = null;
      if (subf0ck) {
        if (Number.isInteger(+subf0ck) && +subf0ck > 0) {
          const row = await db`SELECT id FROM album_items WHERE (id = ${+subf0ck} OR (item_id = ${postid} AND order_index = ${+subf0ck})) AND item_id = ${postid} LIMIT 1`;
          albumItemId = row?.[0]?.id || null;
        }
        if (!albumItemId) {
          const row = await db`SELECT id FROM album_items WHERE slug = ${String(subf0ck)} AND item_id = ${postid} LIMIT 1`;
          albumItemId = row?.[0]?.id || null;
        }
      }

      const tags = await lib.getTags(postid, req.session, subf0ck);

      const tagid = tags.filter(t => t.tag === tagname || t.normalized === tagname.toLowerCase())[0]?.id ?? null;

      if (!tagid) {
        return res.json({
          success: false,
          msg: 'tag is not assigned',
          tags: await lib.getTags(postid, req.session, subf0ck)
        });
      }

      let reply = false;
      if (albumItemId) {
        const q = await db`
          DELETE FROM album_items_tags_assign
          WHERE album_item_id = ${+albumItemId}
            AND tag_id = ${+tagid}
        `;
        reply = !!q;

        const otherUses = await db`
          SELECT 1 FROM album_items_tags_assign aita
          JOIN album_items ai ON ai.id = aita.album_item_id
          WHERE ai.item_id = ${postid} AND aita.tag_id = ${+tagid}
          LIMIT 1
        `;
        if (otherUses.length === 0) {
          await db`
            DELETE FROM tags_assign
            WHERE item_id = ${postid} AND tag_id = ${+tagid}
          `.catch(() => {});
        }
      } else {
        let q = await db`
          delete from "tags_assign"
          where tag_id = ${+tagid}
          and item_id = ${+postid}
        `;
        reply = !!q;
      }

      if (reply) {
        const reason = req.post?.reason || req.url?.qs?.reason || 'No reason provided';
        await audit.log(req.session.id, 'delete_tag', 'item', postid, { tag: tagname, subf0ck_id: subf0ck, reason });
        if (req.session?.is_anon) {
          await logAnonActivity(req, {
            action: 'delete_tag',
            targetId: postid,
            details: { tag: tagname, subf0ck_id: subf0ck, reason }
          });
        }
      }

      const freshTags = await lib.getTags(postid, req.session, subf0ck);
      console.log(`[API] Notifying 'tags' (delete) for item ${postid} (subf0ck: ${subf0ck || 'none'})`);
      await db.notify('tags', JSON.stringify({ item_id: postid, subf0ck_id: subf0ck, fresh: true, tags: freshTags }));

      return res.json({
        success: reply,
        tagid,
        subf0ck_id: subf0ck,
        tags: freshTags
      });
    });

  });

  return router;
};