import JSZip from 'jszip';
import db from './sql.mjs';
import { MAX_NOTES, MAX_HOLD_MS, cleanNotes, cleanTitle, insertMap } from './square_clicker.mjs';

// Beatmap import for Square Clicker: .osz sets (zip: audio, background, one .osu text file per
// difficulty) and loose .osu files, converted to Square Clicker notes { t, x, y, d, p? }.
//
// Standard and catch: circle / fruit -> tap, slider / juice stream -> slider (curve sampled, repeats
// become a path that goes back and forth, duration from length, timing and slider velocity),
// spinner / banana shower -> hold in the middle.
// Taiko: every object sits in the middle of the playfield, so positions are generated: a path that
// flows over the screen (don turns gently, kat turns sharply, distance grows with the time gap).
// Drumroll and denden -> hold.
// Mania: columns become lanes side by side, long notes holds; chords collapse to one note (one cursor).

const PF_W = 512, PF_H = 384; // playfield in osu pixels
// playfield -> viewport fractions, leaving room for the top bar and the edges
const toX = (x) => Math.max(0.02, Math.min(0.98, 0.1 + (x / PF_W) * 0.8));
const toY = (y) => Math.max(0.02, Math.min(0.98, 0.14 + (y / PF_H) * 0.74));
const MAX_OSU_BYTES = 4 * 1024 * 1024;   // one .osu file
const MAX_DIFFS = 40;

// ── .osu text -> sections ─────────────────────────────────────────────────────
export const parseOsu = (text) => {
  const out = { General: {}, Metadata: {}, Difficulty: {}, Events: [], TimingPoints: [], HitObjects: [] };
  let sec = null;
  for (let line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    const m = /^\[(\w+)\]$/.exec(line);
    if (m) { sec = m[1]; continue; }
    if (!sec) continue;
    if (sec === 'General' || sec === 'Metadata' || sec === 'Difficulty') {
      const i = line.indexOf(':');
      if (i > 0) out[sec][line.slice(0, i).trim()] = line.slice(i + 1).trim();
    } else if (Array.isArray(out[sec])) {
      out[sec].push(line);
    }
  }
  return out;
};

// ── curves ────────────────────────────────────────────────────────────────────
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

const bezier = (pts) => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  const n = Math.max(2, Math.min(200, Math.ceil(len / 4)));
  const out = [];
  for (let s = 0; s <= n; s++) {
    let q = pts.slice();
    const t = s / n;
    while (q.length > 1) q = q.slice(1).map((p, i) => lerp(q[i], p, t)); // de Casteljau
    out.push(q[0]);
  }
  return out;
};

const catmull = (pts) => {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    for (let s = 0; s < 16; s++) {
      const t = s / 16, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(k => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
};

// Perfect circle through three points; null when they are (nearly) on a line
const arc = (a, b, c) => {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-3) return null;
  const sq = (p) => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const cy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  let a2 = Math.atan2(c[1] - cy, c[0] - cx);
  // direction: the way that passes through b (sign of the turn a -> b -> c)
  const ccw = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 0;
  if (ccw) { while (a2 < a0) a2 += 2 * Math.PI; } else { while (a2 > a0) a2 -= 2 * Math.PI; }
  // sample well past the end point: the slider length decides where it stops
  const span = (a2 - a0) * 2;
  const n = Math.max(8, Math.min(200, Math.ceil(Math.abs(span) * r / 4)));
  const out = [];
  for (let s = 0; s <= n; s++) { const t = a0 + span * s / n; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;
};

// Slider curve as a polyline (osu pixels), before cutting to the slider length
const curve = (type, pts) => {
  if (type === 'P' && pts.length === 3) {
    const c = arc(pts[0], pts[1], pts[2]);
    if (c) return c;
    return pts;
  }
  if (type === 'L') return pts;
  if (type === 'C') return catmull(pts);
  // Bezier (also the fallback): a repeated point starts a new segment
  const out = [];
  let seg = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] === pts[i - 1][0] && pts[i][1] === pts[i - 1][1]) { out.push(...bezier(seg)); seg = [pts[i]]; }
    else seg.push(pts[i]);
  }
  out.push(...bezier(seg));
  return out;
};

// Cut / extend a polyline to exactly `length`, then resample it to k points evenly along it
const fitLength = (poly, length, k) => {
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + dist(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1];
  const at = (s) => {
    if (poly.length < 2) return poly[0];
    if (s >= total) { // past the end: go on along the last direction
      const a = poly[poly.length - 2], b = poly[poly.length - 1], l = dist(a, b) || 1;
      return [b[0] + (b[0] - a[0]) / l * (s - total), b[1] + (b[1] - a[1]) / l * (s - total)];
    }
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    return lerp(poly[i - 1], poly[i], (s - cum[i - 1]) / seg);
  };
  return Array.from({ length: k }, (_, i) => at(length * i / (k - 1)));
};

// ── timing ────────────────────────────────────────────────────────────────────
// -> sorted [{ time, beatLength, sv }]: the beat length and slider velocity in effect from `time` on
const timingOf = (lines) => {
  const out = [];
  let beat = 500, sv = 1;
  const pts = lines.map(l => l.split(',')).filter(p => p.length >= 2)
    .map(p => ({ time: +p[0], bl: +p[1], unin: p.length > 6 ? p[6] === '1' : +p[1] > 0 }))
    .filter(p => isFinite(p.time) && isFinite(p.bl))
    .sort((a, z) => a.time - z.time || (z.unin - a.unin)); // uninherited first at the same time
  for (const p of pts) {
    if (p.unin && p.bl > 0) { beat = p.bl; sv = 1; }
    else if (!p.unin && p.bl < 0) sv = Math.max(0.1, Math.min(10, -100 / p.bl));
    out.push({ time: p.time, beatLength: beat, sv });
  }
  if (!out.length) out.push({ time: 0, beatLength: 500, sv: 1 });
  return out;
};
const timingAt = (tps, t) => {
  let cur = tps[0];
  for (const p of tps) { if (p.time <= t + 1) cur = p; else break; }
  return cur;
};

// ── generated positions (taiko) ───────────────────────────────────────────────
// A path that wanders over the screen: every note turns it a little (don) or a lot (kat), notes further
// apart in time are further apart on screen, and a spot that would cover a note still on screen (or leave
// the play area) is avoided by turning further until the spot is free
const flowPlace = (list) => {
  const ASPECT = 1.6;               // x/y are fractions of a wide viewport: a y step this much larger is the same distance
  const ON_SCREEN_MS = 1200;        // notes this close in time are visible together
  const FREE_X = 0.065, FREE_Y = 0.12; // about a note and a bit, as viewport fractions
  const inside = (x, y) => x >= 0.15 && x <= 0.85 && y >= 0.2 && y <= 0.82;
  const out = [];
  let x = 0.5, y = 0.5, ang = -Math.PI / 2, prevEnd = null;
  for (const n of list) {
    if (prevEnd !== null) {
      const want = ang + (n.kat ? 2.2 : 0.3);
      const step = Math.max(0.11, Math.min(0.3, (n.t - prevEnd) / 1000 * 0.35));
      const recent = out.filter(o => n.t - o.t < ON_SCREEN_MS);
      const free = (px, py) => inside(px, py) && !recent.some(o => Math.abs(o.x - px) < FREE_X && Math.abs(o.y - py) < FREE_Y);
      let best = null;
      for (let k = 0; k < 24 && !best; k++) { // want, want+0.26, want-0.26, want+0.52, ...
        const a = want + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.26;
        const px = x + Math.cos(a) * step, py = y + Math.sin(a) * step * ASPECT;
        if (free(px, py)) best = [a, px, py];
      }
      if (!best) { // boxed in: the farthest in-bounds spot from the recent notes
        let far = -1;
        for (let k = 0; k < 24; k++) {
          const a = want + k * Math.PI / 12;
          const px = Math.max(0.15, Math.min(0.85, x + Math.cos(a) * step)), py = Math.max(0.2, Math.min(0.82, y + Math.sin(a) * step * ASPECT));
          const dmin = recent.reduce((m, o) => Math.min(m, Math.hypot(o.x - px, (o.y - py) / ASPECT)), Infinity);
          if (dmin > far) { far = dmin; best = [a, px, py]; }
        }
      }
      [ang, x, y] = best;
    }
    prevEnd = n.t + (n.d || 0); // after a hold the gap counts from its end
    out.push({ t: n.t, x: +x.toFixed(4), y: +y.toFixed(4), d: n.d || 0 });
  }
  return out;
};

// ── one difficulty -> notes ───────────────────────────────────────────────────
const MODES = ['standard', 'taiko', 'catch', 'mania'];
// -> { version, creator, notes, mode, error? }
export const convertOsu = (text) => {
  const o = parseOsu(text);
  const mode = parseInt(o.General.Mode || '0', 10) || 0;
  const version = o.Metadata.Version || 'Normal';
  const res = { version, creator: o.Metadata.Creator || '', mode, meta: o.Metadata, audioFile: o.General.AudioFilename || '', notes: [] };
  if (!MODES[mode]) { res.error = 'unknown game mode ' + mode; return res; }
  const tps = timingOf(o.TimingPoints);
  const mult = parseFloat(o.Difficulty.SliderMultiplier) || 1.4;
  const keys = Math.max(1, Math.min(18, Math.round(parseFloat(o.Difficulty.CircleSize) || 4))); // mania columns
  const holdUntil = (t, end) => Math.max(0, Math.min(MAX_HOLD_MS, Math.round(end) - t));
  const sliderMs = (t, p) => {
    const tp = timingAt(tps, t);
    const slides = Math.max(1, Math.min(50, parseInt(p[6], 10) || 1));
    return (Math.max(1, +p[7] || 0) / (mult * 100 * tp.sv) * tp.beatLength) * slides;
  };
  let notes = [];
  const flow = []; // taiko: { t, d, kat } placed afterwards
  for (const line of o.HitObjects) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const x = +p[0], y = +p[1], t = Math.round(+p[2]), type = +p[3];
    if (!isFinite(x) || !isFinite(y) || !isFinite(t) || t < 0) continue;
    if (mode === 1) { // taiko: hitSound whistle (2) or clap (8) = kat
      if (type & 2) flow.push({ t, d: holdUntil(t, t + sliderMs(t, p)) });      // drumroll
      else if (type & 8) flow.push({ t, d: holdUntil(t, +p[5] || t) });        // denden
      else if (type & 1) flow.push({ t, d: 0, kat: !!((+p[4] || 0) & 10) });
      continue;
    }
    if (mode === 3) { // mania: x picks the column; type 128 = long note, end time in the extras
      const col = Math.max(0, Math.min(keys - 1, Math.floor(x * keys / PF_W)));
      const d = type & 128 ? holdUntil(t, parseInt(String(p[5] || '').split(':')[0], 10) || t) : 0;
      notes.push({ t, x: +(0.15 + (col + 0.5) / keys * 0.7).toFixed(4), y: 0.62, d });
      continue;
    }
    if (type & 2) { // slider: x,y,time,type,hitSound,curve,slides,length,...
      const [ctype, ...cps] = String(p[5] || '').split('|');
      const ctrl = [[x, y], ...cps.map(s => s.split(':').map(Number)).filter(q => q.length === 2 && q.every(isFinite))];
      const slides = Math.max(1, Math.min(50, parseInt(p[6], 10) || 1));
      const length = Math.max(1, +p[7] || 0);
      const tp = timingAt(tps, t);
      const perSlide = length / (mult * 100 * tp.sv) * tp.beatLength;
      const d = Math.round(perSlide * slides);
      if (!isFinite(d) || d <= 0 || ctrl.length < 2) { notes.push({ t, x: toX(x), y: toY(y), d: 0 }); continue; }
      const k = Math.max(2, Math.min(Math.ceil(length / 12) + 1, 40, Math.floor(900 / slides)));
      const leg = fitLength(curve(ctype, ctrl), length, k);
      const path = [];
      for (let s = 0; s < slides; s++) {
        const pts = s % 2 ? leg.slice().reverse() : leg;
        pts.forEach((q, i) => {
          if (s > 0 && i === 0) return; // the turn point is already there
          path.push([Math.round(perSlide * (s + i / (k - 1))), +toX(q[0]).toFixed(4), +toY(q[1]).toFixed(4)]);
        });
      }
      notes.push({ t, x: toX(x), y: toY(y), d: Math.min(MAX_HOLD_MS, d), p: path });
    } else if (type & 8) { // spinner: x,y,time,type,hitSound,endTime -> hold in the middle
      const end = Math.round(+p[5] || t);
      notes.push({ t, x: 0.5, y: toY(PF_H / 2), d: Math.max(0, Math.min(MAX_HOLD_MS, end - t)) });
    } else if (type & 1) {
      notes.push({ t, x: toX(x), y: toY(y), d: 0 });
    }
  }
  if (mode === 1) notes = flowPlace(flow.sort((a, z) => a.t - z.t));
  notes.sort((a, z) => a.t - z.t);
  // one cursor: notes at the same moment (mania chords) collapse to the first
  notes = notes.filter((n, i) => i === 0 || n.t - notes[i - 1].t > 1);
  if (!notes.length) res.error = 'no hit objects';
  else if (notes.length > MAX_NOTES) res.error = 'too many notes (' + notes.length + ', max ' + MAX_NOTES + ')';
  res.notes = notes;
  return res;
};

// Title of an imported map: "Insane (mapper)", other modes marked: "ONI (mapper, taiko)"
export const importedTitle = (diff) => {
  const extra = [diff.creator, diff.mode ? MODES[diff.mode] : ''].filter(Boolean).join(', ');
  return diff.version + (extra ? ' (' + extra + ')' : '');
};

// ── .osz -> { meta, audio: { name, data }, background: { name, data } | null, diffs, skipped } ──
// null when the zip has no .osu files (then it is a normal archive)
export const readOsz = async (buffer) => {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (_) { return null; }
  const files = Object.values(zip.files).filter(f => !f.dir);
  const osuFiles = files.filter(f => /\.osu$/i.test(f.name)).slice(0, MAX_DIFFS);
  if (!osuFiles.length) return null;
  const byName = (name) => {
    if (!name) return null;
    const want = name.replace(/\\/g, '/').toLowerCase();
    return files.find(f => f.name.toLowerCase() === want) || files.find(f => f.name.toLowerCase().endsWith('/' + want)) || null;
  };
  const diffs = [], skipped = [];
  let meta = null, audioName = null, bgName = null;
  for (const f of osuFiles) {
    const text = await f.async('string');
    if (text.length > MAX_OSU_BYTES) { skipped.push({ version: f.name, reason: 'file too large' }); continue; }
    const d = convertOsu(text);
    if (d.error) { skipped.push({ version: d.version, reason: d.error }); continue; }
    diffs.push(d);
    if (!meta) meta = d.meta;
    if (!audioName) audioName = d.audioFile;
    if (!bgName) {
      const ev = parseOsu(text).Events.find(l => /^0\s*,\s*0\s*,/.test(l));
      const m = ev && /^0\s*,\s*0\s*,\s*"?([^",]+)"?/.exec(ev);
      if (m) bgName = m[1].trim();
    }
  }
  // audio: the file the difficulties name, or any audio file in the set
  const audioFile = byName(audioName) || files.find(f => /\.(mp3|ogg|wav|flac|m4a)$/i.test(f.name));
  const bgFile = byName(bgName) || files.find(f => /\.(jpe?g|png)$/i.test(f.name));
  diffs.sort((a, z) => a.notes.length - z.notes.length); // easiest first
  return {
    meta: meta || {},
    audio: audioFile ? { name: audioFile.name, data: await audioFile.async('nodebuffer') } : null,
    background: bgFile ? { name: bgFile.name, data: await bgFile.async('nodebuffer') } : null,
    diffs,
    skipped,
  };
};

// "Artist - Title" for the item title
export const setTitle = (meta) => [meta.Artist || meta.ArtistUnicode, meta.Title || meta.TitleUnicode].filter(Boolean).join(' - ');

// Store converted difficulties as maps of an item (or album entry). A difficulty that is already
// there (same title and note count) is skipped, so importing a set twice adds nothing.
// -> { ids, skipped: [{ version, reason }] }
export const saveDiffs = async ({ itemId, albumItemId = null, userId, diffs, durationMs = 0 }) => {
  const ids = [], skipped = [];
  for (const d of diffs) {
    const v = cleanNotes(d.notes, 0);
    if (v.error) { skipped.push({ version: d.version, reason: v.error }); continue; }
    const title = cleanTitle(importedTitle(d));
    const [dupe] = await db`
      SELECT id FROM sqc_maps
      WHERE item_id = ${itemId} AND album_item_id IS NOT DISTINCT FROM ${albumItemId}::int
        AND title = ${title} AND note_count = ${v.notes.length}
      LIMIT 1
    `;
    if (dupe) { skipped.push({ version: d.version, reason: 'already imported' }); continue; }
    const last = v.notes[v.notes.length - 1];
    ids.push(await insertMap({ itemId, albumItemId, userId, title, notes: v.notes, durationMs: durationMs || last.t + last.d + 2000 }));
  }
  return { ids, skipped };
};
