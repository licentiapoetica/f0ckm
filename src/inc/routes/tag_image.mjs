import crypto from 'crypto';
import db from '../sql.mjs';
import lib from '../lib.mjs';
import cfg from '../config.mjs';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import util from 'util';
import url from 'url';

const execFilePromise = util.promisify(execFile);
const CACHE_DIR = path.join(cfg.paths.s, '../tag_cache');
const CACHE_MAX_AGE = 3600; // 1 hour

// --- Reusable generation function ---
export async function regenerateTagImage(tag, mode) {
  const hash = crypto.createHash('md5').update(tag).digest('hex');
  const cachePath = path.join(CACHE_DIR, `${hash}_${mode}.webp`);

  try {
    let modeFilter = db``;
    if (mode === 0) {
      modeFilter = db`JOIN tags_assign ta_sfw ON ta_sfw.item_id = i.id AND ta_sfw.tag_id = 1`;
    } else if (mode === 1) {
      modeFilter = db`JOIN tags_assign ta_nsfw ON ta_nsfw.item_id = i.id AND ta_nsfw.tag_id = 2`;
    }

    const items = await db`
      SELECT i.id
      FROM items i
      JOIN tags_assign ta ON ta.item_id = i.id
      JOIN tags t ON t.id = ta.tag_id
      ${modeFilter}
      WHERE (t.tag = ${tag} OR t.normalized = ${tag}) AND i.active = true
      ORDER BY RANDOM()
      LIMIT 3
    `;

    if (items.length > 0) {
      const inputs = items.map(item => path.join(cfg.paths.t, `${item.id}.webp`));

      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await execFilePromise('magick', [...inputs, '+append', '-background', 'none', '-resize', '300x150^', '-gravity', 'center', '-extent', '300x150', cachePath]);
      return cachePath;
    }
  } catch (err) {
    console.error(`[TAG_IMAGE] Failed to generate image for tag "${tag}" (mode ${mode}):`, err);
  }
  return null;
}

// --- Background listener: regenerate cache when tags change ---
db.listen('tags', async (payload) => {
  try {
    const data = JSON.parse(payload);
    const itemId = data.item_id;
    if (!itemId) return;

    // Find all tags currently assigned to this item
    const tags = await db`
      SELECT DISTINCT t.tag
      FROM tags t
      JOIN tags_assign ta ON t.id = ta.tag_id
      WHERE ta.item_id = ${itemId}
    `;

    // Also include any tags from the notification payload (covers deletions
    // where the tag may no longer be assigned to the item)
    const payloadTags = (data.tags || []).map(t => t.tag).filter(Boolean);
    const allTagNames = new Set([
      ...tags.map(t => t.tag),
      ...payloadTags
    ]);

    if (allTagNames.size === 0) return;

    console.log(`[TAG_IMAGE] Tag change on item ${itemId}, regenerating cache for ${allTagNames.size} tag(s)`);

    for (const tag of allTagNames) {
      const hash = crypto.createHash('md5').update(tag).digest('hex');

      // Delete existing cache files for this tag (all modes)
      for (const mode of [0, 1, 3]) {
        const cachePath = path.join(CACHE_DIR, `${hash}_${mode}.webp`);
        try {
          await fs.unlink(cachePath);
        } catch {
          // File didn't exist, that's fine
        }
      }

      // Regenerate for all modes (fire-and-forget per tag)
      for (const mode of [0, 1, 3]) {
        regenerateTagImage(tag, mode).catch(err =>
          console.error(`[TAG_IMAGE] Background regen failed for "${tag}" mode ${mode}:`, err)
        );
      }
    }
  } catch (e) {
    console.error('[TAG_IMAGE] Background listener error:', e);
  }
}).catch(err => console.error('[TAG_IMAGE] DB Listen error:', err));

// --- SVG fallback helper ---
function generateFallbackSvg(tag) {
  const hash = crypto.createHash('md5').update(tag).digest('hex');
  const escapeXml = (unsafe) => {
    return unsafe.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
      }
    });
  };
  const displayTag = escapeXml(tag);
  const c1 = '#' + hash.substring(0, 6);
  const c2 = '#' + hash.substring(6, 12);
  const c3 = '#' + hash.substring(12, 18);
  const n1 = parseInt(hash.substring(18, 20), 16);
  const n2 = parseInt(hash.substring(20, 22), 16);

  return `
    <svg width="300" height="150" viewBox="0 0 300 150" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${c1};stop-opacity:1" />
          <stop offset="100%" style="stop-color:${c2};stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="300" height="150" fill="url(#grad)" />
      <circle cx="${n1}%" cy="${n2}%" r="${(n1 + n2) / 4}" fill="${c3}" fill-opacity="0.3" />
      <circle cx="${100 - n1}%" cy="${100 - n2}%" r="${(n1 + n2) / 3}" fill="${c3}" fill-opacity="0.2" />
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#fff" fill-opacity="0.9" font-weight="bold">${displayTag}</text>
    </svg>
  `.trim();
}

export default (router, tpl) => {
  router.get(/^\/tag_image\/(?<tag>.+)$/, async (req, res) => {
    const tag = decodeURIComponent(req.params.tag);

    // Parse query parameters
    let query = {};
    if (typeof req.url === 'string') {
      const parsedUrl = url.parse(req.url, true);
      query = parsedUrl.query;
    } else {
      query = req.url.qs || {};
    }

    const mode = query.m ? parseInt(query.m) : (req.mode ?? 0);
    const hash = crypto.createHash('md5').update(tag).digest('hex');
    const cachePath = path.join(CACHE_DIR, `${hash}_${mode}.webp`);

    // Try to serve cached image first
    try {
      const stats = await fs.stat(cachePath);
      if (stats.size > 0) {
        res.writeHead(200, {
          'Content-Type': 'image/webp',
          'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`
        });
        return res.end(await fs.readFile(cachePath));
      }
    } catch (e) {
      // Cache miss, proceed to generation
    }

    // Generate on-demand
    const generated = await regenerateTagImage(tag, mode);
    if (generated) {
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`
      });
      return res.end(await fs.readFile(generated));
    }

    // Fallback to deterministic SVG
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`
    });
    res.end(generateFallbackSvg(tag));
  });
  
  // --- Admin: Force regeneration routes ---
  router.get('/admin/tag_image/regenerate_all', lib.auth, async (req, res) => {
    try {
      const tags = await db`SELECT DISTINCT tag FROM tags JOIN tags_assign ON tags.id = tags_assign.tag_id`;
      console.log(`[ADMIN] Triggering full tag image regeneration for ${tags.length} tags`);
      
      // Fire-and-forget regeneration in batches to avoid overwhelming the system
      const batchSize = 10;
      (async () => {
        for (let i = 0; i < tags.length; i += batchSize) {
          const batch = tags.slice(i, i + batchSize);
          await Promise.all(batch.map(async (t) => {
             const hash = crypto.createHash('md5').update(t.tag).digest('hex');
             // Delete existing cache files first
             for (const m of [0, 1, 3]) {
               try { await fs.unlink(path.join(CACHE_DIR, `${hash}_${m}.webp`)); } catch {}
               await regenerateTagImage(t.tag, m).catch(e => console.error(`[ADMIN] Failed regen for ${t.tag} (mode ${m}):`, e));
             }
          }));
        }
        console.log(`[ADMIN] Full tag image regeneration completed`);
      })().catch(err => console.error('[ADMIN] Full regen background task failed:', err));

      return res.reply({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: `Started regeneration for ${tags.length} tags in background.` })
      });
    } catch (err) {
      console.error('[ADMIN] Failed to trigger full regeneration:', err);
      return res.reply({ code: 500, body: 'Internal Server Error' });
    }
  });

  router.get(/^\/admin\/tag_image\/regenerate\/(?<tag>.+)$/, lib.auth, async (req, res) => {
    const tag = decodeURIComponent(req.params.tag);
    const hash = crypto.createHash('md5').update(tag).digest('hex');
    
    try {
      console.log(`[ADMIN] Regenerating images for tag: ${tag}`);
      for (const m of [0, 1, 3]) {
        try { await fs.unlink(path.join(CACHE_DIR, `${hash}_${m}.webp`)); } catch {}
        await regenerateTagImage(tag, m);
      }
      return res.reply({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: `Regenerated images for tag "${tag}".` })
      });
    } catch (err) {
      console.error(`[ADMIN] Failed to regenerate tag "${tag}":`, err);
      return res.reply({ code: 500, body: 'Internal Server Error' });
    }
  });
  return router;
};
