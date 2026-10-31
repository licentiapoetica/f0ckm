/**
 * Square Clicker: audio / video items become playable rhythm-game maps. For everyone, unless
 * websrv.square_clicker_enabled is false (src/inc/square_clicker.mjs).
 *
 * On an audio or video item an "Square Clicker" button appears next to the other item actions (hotkey o).
 * - Edit: your own maps (any map for staff) open in an editor (timeline, move / add / delete / nudge).
 * - Create: the song restarts and the whole page is the play area. Every click places a note at that
 *   spot and time, holding the button makes a hold note. Esc or the song's end finishes the map.
 * - Play: notes (squares, this site has no round corners) appear with a closing approach frame; hit
 *   them with a click or Z / X at the right time, keep hold notes held until their bar fills.
 *   300 / 100 / 50 / miss, combo, accuracy, grade; scores go to a per-map top 10.
 * Maps and scores live on the server (/api/v2/sqc/*). One canvas, drawn only while a session runs.
 */
(() => {
  if (window.__f0ckSqc) return;
  window.__f0ckSqc = true;

  const WIN_300 = 50, WIN_100 = 100, WIN_50 = 150; // hit windows (± ms)
  const HOLD_MIN_MS = 220;     // a press longer than this records a hold note
  const HOLD_SLACK_MS = 120;   // letting go this close to the end still counts as held
  const SLIDER_MIN_MOVE = 20;  // a hold that moved at least this far (px) becomes a slider
  const SLIDER_MAX_POINTS = 400;
  const FOLLOW_GRACE_MS = 250; // outside the follow zone longer than this breaks the slider

  // ── player settings (sidebar tuner "Square Clicker" tab), saved per device ────────────────
  const SETTINGS_KEY = 'f0ck_sqc_settings';
  const CUSTOM_SOUND_KEY = 'f0ck_sqc_custom_sound';
  const CUSTOM_SOUND_MAX = 700 * 1024; // bytes of the uploaded file
  const NOTE_IMAGE_KEY = 'f0ck_sqc_note_image'; // note image / GIF (tuner: note shape "Image"), data URL
  const NOTE_IMAGE_MAX = 2 * 1024 * 1024;
  const DEFAULT_HIT_SOUND = '/s/sfx/hitsound.mp3';
  const LAST_SETTING_KEY = 'f0ck_sqc_last_setting'; // tuner row changed last (the pause menu's tuner jumps there)
  let noteImg = null, noteImgFor = null; // loaded note image (see loadNoteImage)
  const SQC_DEFAULTS = {
    hitSound: 'default', volume: 0.35, missSound: 1, countdownTicks: 1,
    approachMs: 900, noteSize: 70, noteShape: 'square', noteNumbers: 0, followMul: 1.6, leadInMs: 1500, offsetMs: 0,
    dimColor: '#000000', dimAudio: 0.35, dimVideo: 0.15,
    autoPreset: 'balanced', autoDifficulty: 'normal',
    bpmMode: 'auto', bpm: 120, beatOffsetMs: 0, beatsPerBar: 4,
    metronomeRecord: 1, metronomePlay: 0, metronomeVolume: 0.5, snapRecord: 0,
    // "Custom" auto map preset (advanced tuner)
    autoAdvanced: 0, autoMethod: 'flux',
    autoB1Lo: 30, autoB1Hi: 11000, autoB1W: 1, autoB2Lo: 30, autoB2Hi: 250, autoB2W: 0.5, autoB3Lo: 1000, autoB3Hi: 4000, autoB3W: 0,
    autoK: 1.4, autoGapMs: 280, autoWindowMs: 230, autoFloor: 0.04, autoSnap: 0, autoGridDiv: 2,
    autoJump: 1, autoSliderChance: 0.45, autoSliderGapMs: 750,
  };
  const O = Object.assign({}, SQC_DEFAULTS);
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    // settings saved before the hitsound.mp3 default: the old default 'tick' becomes the new default
    if (stored && !stored.v && stored.hitSound === 'tick') stored.hitSound = 'default';
    Object.assign(O, stored, { v: 2 });
  } catch (_) {}
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(O)); } catch (_) {} };

  // Values derived from the settings (updated by applySettings)
  let APPROACH_MS, NOTE, LEAD_IN_MS, FOLLOW;
  const applySettings = () => {
    APPROACH_MS = Math.max(300, +O.approachMs || 900);  // how early a note appears
    NOTE = Math.max(30, +O.noteSize || 70);             // note size, px
    LEAD_IN_MS = Math.max(0, +O.leadInMs || 0);         // countdown before the song starts
    if (typeof loadNoteImage === 'function') loadNoteImage();
    FOLLOW = NOTE * Math.max(0.8, +O.followMul || 1.6); // half-size of the slider follow zone
  };
  applySettings();

  // Input for record and play: left AND right mouse button and every key (except Esc = quit) act like
  // a click. Each new press is a hit attempt (alternate keys, like rhythm games do); a hold / slider stays held while
  // ANY of them is still down. Ctrl/Alt/Meta combos and F-keys keep their browser function.
  // perKey (recording): onPress / onRelease get the input id for every press and release, so a new press
  // can end the hold another key started and each release only ends its own note.
  const bindInputs = (s, onPress, onRelease, perKey) => {
    const held = new Set();
    const down = (id, x, y) => {
      if (held.has(id)) return;
      held.add(id);
      if (S && (S.paused || S.resumeUntil)) return; // paused / getting ready: no hits
      onPress(x, y, id);
    };
    const up = (id) => {
      if (!held.delete(id)) return;
      if (perKey) onRelease(id);
      else if (!held.size) onRelease();
    };
    s.view.ov.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      e.preventDefault();
      down('mouse' + e.button, e.clientX, e.clientY);
    });
    s.view.ov.addEventListener('pointerup', (e) => up('mouse' + e.button));
    s.view.ov.addEventListener('contextmenu', (e) => e.preventDefault());
    s.onKey = (e) => {
      if (!S) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) (S.paused ? resume() : pause(true)); return; }
      if (e.ctrlKey || e.altKey || e.metaKey || /^F\d{1,2}$/.test(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat) down('key:' + e.code, S.mouse.x, S.mouse.y);
    };
    s.onKeyUp = (e) => up('key:' + e.code);
    // Losing focus (alt-tab) counts as letting go of everything
    s.onBlur = () => { if (held.size) { held.clear(); onRelease(); } pause(); };
    s.clearHeld = () => held.clear();
    window.addEventListener('blur', s.onBlur);
    // Keys reach s.onKey / s.onKeyUp through the permanent key guard below
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  };

  // Key guard: registered once, now, in the capture phase on window, the first point every key event
  // passes (before all site shortcut listeners on document, and before scripts loaded after this one).
  // While a game session runs, EVERY key event belongs to the game: it is handed to the session and
  // stopped (stopImmediatePropagation), so no site shortcut (player keys, theme, comments, navigation,
  // Esc closing Onara...) reacts. Ctrl/Alt/Meta combos and F-keys keep their browser default (the
  // session's handler doesn't preventDefault them), the site just never sees them.
  const keyGuard = (e) => {
    if (!S || !S.onKey) return;
    e.stopImmediatePropagation();
    // Typing into a field of our own overlay (editor title): let the field have the key
    const tg = e.target;
    if (tg && tg.closest && tg.closest('.sqc-overlay') && /^(INPUT|TEXTAREA)$/.test(tg.tagName)) {
      if (e.type === 'keydown' && (e.key === 'Enter' || e.key === 'Escape')) tg.blur();
      return;
    }
    // Settings open: keys for the tuner's controls (sliders, selects) do their normal thing; Esc resumes
    if (S.settings && tg && tg.closest && tg.closest(SIDEBAR_SEL) && e.key !== 'Escape') return;
    if (e.type === 'keydown') S.onKey(e);
    else if (e.type === 'keyup') { if (S.onKeyUp) S.onKeyUp(e); }
    else if (!(e.ctrlKey || e.altKey || e.metaKey)) e.preventDefault(); // keypress
  };
  window.addEventListener('keydown', keyGuard, true);
  window.addEventListener('keyup', keyGuard, true);
  window.addEventListener('keypress', keyGuard, true);

  // Stacking (for play): a note on the same spot as a note still on screen, or on the end of a slider that
  // was just played, would be hidden under it, so you could only guess it is there. Such notes move a
  // bit down-right, one step more per note in the stack, and are hit where they are drawn. Sliders move
  // with their whole path. Imported beatmaps rely on this: back-to-back notes there share one position.
  const stackNotes = (notes) => {
    const W = innerWidth, H = innerHeight;
    const SAME = Math.max(10, NOTE * 0.25); // px: closer than this counts as the same spot
    const STEP = Math.max(12, NOTE * 0.32); // px per stack level: enough for the number underneath to show
    const at = (n) => [n.x * W, n.y * H];
    const endOf = (n) => { const e = n.p && n.p[n.p.length - 1]; return e ? [e[1] * W, e[2] * H] : at(n); };
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < SAME;
    notes.forEach((n, i) => {
      n.stack = 0;
      const base = at(n);
      for (let j = i - 1; j >= 0; j--) {
        const m = notes[j];
        if (n.t - (m.t + (m.d || 0)) > APPROACH_MS) break;
        // on an earlier note (its original spot) or on the end of an earlier slider
        if (near(base, m.base || at(m)) || (m.p && near(base, m.baseEnd || endOf(m)))) { n.stack = (m.stack || 0) + 1; break; }
      }
      n.base = base;
      n.baseEnd = endOf(n);
      if (!n.stack) return;
      const dx = Math.min(n.stack * STEP, W * 0.2) / W, dy = Math.min(n.stack * STEP, H * 0.2) / H;
      n.x = Math.max(0.02, Math.min(0.98, n.x + dx));
      n.y = Math.max(0.02, Math.min(0.98, n.y + dy));
      if (n.p) n.p = n.p.map(q => [q[0], Math.max(0.02, Math.min(0.98, q[1] + dx)), Math.max(0.02, Math.min(0.98, q[2] + dy))]);
    });
  };

  // For play: the recorded path is smoothed (moving average, ends kept) and the ball then travels it
  // at a CONSTANT speed over the slider's duration, like sliders in rhythm games. Replaying the mapper's
  // exact hand motion made every flick or hesitation a sudden jump that was very hard to follow.
  // Adds n.sp (smoothed points, viewport fractions), n.cum (cumulative length per point, px) and
  // n.len (total length, px), measured in screen pixels so both axes count equally.
  const prepSlider = (n) => {
    const p = n.p;
    if (!p || p.length < 2) return;
    const W = innerWidth, H = innerHeight;
    let pts = p.map(q => [q[1] * W, q[2] * H]);
    for (let pass = 0; pass < 3; pass++) {
      pts = pts.map((q, i) => {
        if (i === 0 || i === pts.length - 1) return q;
        const a = pts[i - 1], b = pts[i + 1];
        return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4];
      });
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    n.sp = pts.map((q, i) => [p[i][0], q[0] / W, q[1] / H]);
    n.cum = cum;
    n.len = cum[cum.length - 1];
    n.turns = findTurns(n, p.map(q => [q[1] * W, q[2] * H]), cum);
  };

  // Where a slider reverses (the ball goes back over the track it came along), so it can show reverse
  // arrows: without them a back-and-forth slider looks exactly like a one-way one. Found on the path itself:
  // - imported repeat sliders retrace their leg point for point: a turn is a point whose neighbours are
  //   the same point (exact mirror), however short the leg
  // - hand-drawn paths (no exact mirrors): the way in and the way out, each over at least R px, point in
  //   nearly opposite directions AND the way out runs back over the way in (a wide hairpin is no turn)
  // -> [{ frac: share of the slider's length (= time) at the turn, x, y (px), ang: arrow direction }]
  const findTurns = (n, P, cum) => {
    const R = Math.max(12, NOTE * 0.4);
    const d2 = (a, z) => Math.hypot(a[0] - z[0], a[1] - z[1]);
    const out = [];
    const turnAt = (i, from) => out.push({ i, ang: Math.atan2(P[from][1] - P[i][1], P[from][0] - P[i][0]) });
    for (let i = 1; i < P.length - 1; i++) {
      if (d2(P[i - 1], P[i + 1]) < 0.5 && d2(P[i], P[i - 1]) >= 0.5) turnAt(i, i - 1);
    }
    if (!out.length) {
      let best = null; // best candidate of the current run of candidates
      for (let i = 1; i < P.length - 1; i++) {
        let a = i - 1, b = i + 1;
        while (a > 0 && d2(P[i], P[a]) < R) a--;
        while (b < P.length - 1 && d2(P[b], P[i]) < R) b++;
        const v1 = [P[i][0] - P[a][0], P[i][1] - P[a][1]], v2 = [P[b][0] - P[i][0], P[b][1] - P[i][1]];
        const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
        let cos = l1 >= R * 0.8 && l2 >= R * 0.8 ? (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2) : 1;
        if (cos < -0.75) { // retraces: the point R px further on lies close to the way in
          let near = Infinity;
          for (let j = a; j <= i; j++) near = Math.min(near, d2(P[b], P[j]));
          if (near > R * 0.5) cos = 1;
        }
        if (cos < -0.75) {
          if (!best || cos < best.cos) best = { i, a, cos };
        } else if (best) { turnAt(best.i, best.a); best = null; }
      }
      if (best) turnAt(best.i, best.a);
    }
    const len = cum[cum.length - 1] || 1;
    return out.map(tr => ({ frac: cum[tr.i] / len, x: P[tr.i][0], y: P[tr.i][1], ang: tr.ang }));
  };

  // Reverse arrows on the turns still ahead of the ball (elapsed: ms since the slider's start; before it
  // starts all of them). Turns on the same spot draw once, with how many are left there ("x2").
  const drawTurns = (ctx, n, elapsed, alpha) => {
    if (!n.turns || !n.turns.length) return;
    const groups = [];
    n.turns.forEach(tr => {
      if (tr.frac * n.d <= elapsed) return;
      const g = groups.find(o => Math.hypot(o.x - tr.x, o.y - tr.y) < NOTE * 0.5);
      if (g) g.count++; else groups.push({ x: tr.x, y: tr.y, ang: tr.ang, count: 1 });
    });
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
    groups.forEach(g => {
      const c = Math.cos(g.ang), sn = Math.sin(g.ang), size = NOTE * 0.28;
      // double chevron pointing back along the track
      const chevron = (off) => {
        const tx = g.x + c * (size * 1.2 + off), ty = g.y + sn * (size * 1.2 + off); // inside the track end
        ctx.beginPath();
        ctx.moveTo(tx - c * size + sn * size * 0.8, ty - sn * size - c * size * 0.8);
        ctx.lineTo(tx, ty);
        ctx.lineTo(tx - c * size - sn * size * 0.8, ty - sn * size + c * size * 0.8);
        ctx.stroke();
      };
      for (const [w, stroke] of [[7, 'rgba(0,0,0,0.85)'], [3.5, '#fff']]) {
        ctx.lineWidth = w; ctx.strokeStyle = stroke;
        chevron(0); chevron(-size * 0.7);
      }
      if (g.count > 1) {
        ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        const lx = g.x - c * size * 1.6, ly = g.y - sn * size * 1.6;
        ctx.strokeText('x' + g.count, lx, ly);
        ctx.fillStyle = '#fff'; ctx.fillText('x' + g.count, lx, ly);
      }
    });
    ctx.restore();
  };

  // Slider ball position (viewport fractions) dt ms after the note's start.
  // Prepared (play): constant speed along the smoothed path. Otherwise: the recorded timing.
  // p = [[dt, x, y], ...] (first point = the start); linear between points
  const sliderAt = (n, dt) => {
    if (n.sp && n.len > 0 && n.d > 0) {
      const target = Math.max(0, Math.min(1, dt / n.d)) * n.len;
      const c = n.cum, sp = n.sp;
      let i = 1;
      while (i < c.length - 1 && c[i] < target) i++;
      const f = (target - c[i - 1]) / Math.max(1e-6, c[i] - c[i - 1]);
      return { x: sp[i - 1][1] + (sp[i][1] - sp[i - 1][1]) * f, y: sp[i - 1][2] + (sp[i][2] - sp[i - 1][2]) * f };
    }
    const p = n.p;
    if (!p || p.length < 2) return { x: n.x, y: n.y };
    if (dt <= p[0][0]) return { x: p[0][1], y: p[0][2] };
    for (let i = 1; i < p.length; i++) {
      if (dt <= p[i][0]) {
        const a = p[i - 1], b = p[i];
        const f = (dt - a[0]) / Math.max(1, b[0] - a[0]);
        return { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f };
      }
    }
    const l = p[p.length - 1];
    return { x: l[1], y: l[2] };
  };
  // ── note shapes (tuner: note shape) ──
  // Outline of a note of size s px centred on x, y. "image" draws the uploaded picture / GIF as the note
  // body; its outlines (approach frame, ball, follow zone) are circles.
  const SHAPES = [['square', 'Square'], ['circle', 'Circle'], ['diamond', 'Diamond'], ['hexagon', 'Hexagon'],
    ['octagon', 'Octagon'], ['triangle', 'Triangle'], ['star', 'Star'], ['image', 'Image / GIF (upload below)']];
  const shapePath = (ctx, x, y, s) => {
    const r = s / 2;
    const poly = (k, rot, rr) => {
      for (let i = 0; i < k; i++) { const a = rot + i * 2 * Math.PI / k; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    };
    ctx.beginPath();
    switch (O.noteShape) {
      case 'circle': case 'image': ctx.arc(x, y, r, 0, 2 * Math.PI); break;
      case 'diamond': poly(4, -Math.PI / 2, r * 1.2); break;
      case 'hexagon': poly(6, 0, r * 1.08); break;
      case 'octagon': poly(8, Math.PI / 8, r * 1.05); break;
      case 'triangle': poly(3, -Math.PI / 2, r * 1.25); break;
      case 'star':
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.55 : r * 1.2; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
        break;
      default: ctx.rect(x - r, y - r, s, s);
    }
    ctx.closePath();
  };
  const strokeShape = (ctx, x, y, s) => { shapePath(ctx, x, y, s); ctx.stroke(); };
  const fillShape = (ctx, x, y, s) => { shapePath(ctx, x, y, s); ctx.fill(); };
  // The uploaded note image. Kept in the page (tiny, invisible) so animated GIFs keep animating when
  // drawn onto the canvas (Chromium only advances GIF frames of images that are in the document).
  function loadNoteImage() {
    let url = null;
    if (O.noteShape === 'image') { try { url = localStorage.getItem(NOTE_IMAGE_KEY); } catch (_) {} }
    if (url === noteImgFor) return;
    if (noteImg) noteImg.remove();
    noteImg = null; noteImgFor = url;
    if (!url) return;
    noteImg = new Image();
    noteImg.alt = '';
    noteImg.style.cssText = 'position: fixed; left: 0; top: 0; width: 1px; height: 1px; opacity: 0.01; pointer-events: none; z-index: -1;';
    noteImg.src = url;
    document.body.appendChild(noteImg);
  }
  // A note's body: the image, or the shape filled dark with an accent outline
  const drawNoteBody = (ctx, x, y, s, col, lineWidth) => {
    if (O.noteShape === 'image' && noteImg && noteImg.complete && noteImg.naturalWidth) {
      const k = s * 1.1 / Math.max(noteImg.naturalWidth, noteImg.naturalHeight);
      const w = noteImg.naturalWidth * k, h = noteImg.naturalHeight * k;
      ctx.drawImage(noteImg, x - w / 2, y - h / 2, w, h);
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; fillShape(ctx, x, y, s);
    ctx.strokeStyle = col; ctx.lineWidth = lineWidth || 3; strokeShape(ctx, x, y, s);
  };

  // Stroke a slider track (path in viewport fractions) as a wide band: accent edge, dark core
  const drawTrack = (ctx, pts, col, alpha) => {
    if (!pts || pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'bevel'; ctx.lineCap = 'butt';
    ctx.beginPath();
    pts.forEach((q, i) => { const x = q[1] * innerWidth, y = q[2] * innerHeight; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.strokeStyle = col; ctx.lineWidth = NOTE * 0.8 + 4; ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = NOTE * 0.8; ctx.stroke();
    ctx.restore();
    const e = pts[pts.length - 1];
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.lineWidth = 2;
    strokeShape(ctx, e[1] * innerWidth, e[2] * innerHeight, NOTE * 0.6);
    ctx.restore();
  };

  // ── helpers ────────────────────────────────────────────────────────────────
  const csrf = () => (window.f0ckSession && window.f0ckSession.csrf_token) || '';
  const loggedIn = () => !!(window.f0ckSession && window.f0ckSession.user);
  const api = (url, opts = {}) => fetch(url, Object.assign({ credentials: 'include' }, opts, {
    headers: Object.assign({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, opts.headers || {}),
  })).then(r => r.json()).catch(() => ({ success: false, msg: 'Network error' }));
  const scope = () => (document.body.classList.contains('onara-modal-open') && document.getElementById('onara-item-mount')) || document;
  // The media to play to: the item's own <audio> / <video>#my-video, or in an album the player of the
  // entry that is showing (f0ckm.js keeps data-current-sub-id / -mime on the album container).
  // YouTube embeds and image entries have none.
  const albumBox = () => scope().querySelector('.album-gallery-container');
  const playableMime = (m) => /^(audio|video)\//.test(m || '') && m !== 'video/youtube';
  const getAudio = () => {
    const own = scope().querySelector('audio#my-video, video#my-video');
    if (own) return own;
    const box = albumBox();
    const mime = box ? box.dataset.currentSubMime || '' : '';
    if (!playableMime(mime)) return null;
    return box.querySelector(mime.startsWith('audio/') ? '#f0ck-album-audio' : '#f0ck-album-video');
  };
  // Album entry (album_items.id) the maps belong to; null for normal items
  const getSubId = () => { const box = albumBox(); return (box && +box.dataset.currentSubId) || null; };
  // Does this album have any audio / video entry (then the button shows, even while an image is showing)
  const albumHasMedia = () => {
    const box = albumBox();
    const j = box && box.querySelector('.album-data-json');
    try { return !!(j && JSON.parse(j.textContent).some(e => playableMime(e.mime))); } catch (_) { return false; }
  };
  // Darken the page less over a video, so the video stays watchable while playing to it
  // Backdrop drawn over the page: tuner colour at the audio / video opacity (up to fully opaque)
  const dim = (media) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(O.dimColor || '').trim());
    const n = m ? parseInt(m[1], 16) : 0;
    const a = Math.max(0, Math.min(1, media && media.tagName === 'VIDEO' ? +O.dimVideo : +O.dimAudio));
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  };
  const getItemId = () => (window.getCurrentItemId ? window.getCurrentItemId() : null);
  const accent = () => (getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#9f0');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmtTime = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const flash = (msg, type) => { if (window.flashMessage) window.flashMessage(msg, 2500, type || 'success'); };

  // ── hit sounds (synthesized with Web Audio: no files, no loading, no decode latency) ──
  // Hit sound type, volume and toggles come from the settings (tuner). Every type varies with the
  // judgement: 300 brightest/loudest, 100 a bit lower, 50 duller. 'custom' plays an uploaded file
  // (pitched down a little for 100 / 50). A combo break is a low thump.
  const Sfx = (() => {
    let ctx = null, noise = null;
    let customBuf = null, customFor = null; // decoded upload + the data URL it came from
    let defaultBuf = null, defaultLoading = false; // hitsound.mp3, the default hit sound
    // Created/resumed from a click (browsers only allow audio after a user gesture)
    const ensure = () => {
      if (!ctx) {
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; }
        const len = Math.floor(ctx.sampleRate * 0.06);
        noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    };
    const vol = () => Math.max(0, Math.min(1, +O.volume));
    const out = (c, gain) => { const g = c.createGain(); g.gain.value = vol() * gain; g.connect(c.destination); return g; };
    // Band-passed noise burst
    const snap = (c, dest, t0, freq, q, len, level) => {
      const src = c.createBufferSource(); src.buffer = noise;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
      const g = c.createGain(); g.gain.setValueAtTime(level, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + len);
      src.connect(bp); bp.connect(g); g.connect(dest); src.start(t0); src.stop(t0 + len + 0.01);
    };
    // Short tone with a pitch drop
    const tone = (c, dest, t0, type, f0, f1, len, level) => {
      const o = c.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + len);
      const g = c.createGain(); g.gain.setValueAtTime(level, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + len + 0.01);
      o.connect(g); g.connect(dest); o.start(t0); o.stop(t0 + len + 0.02);
    };
    // One hit; m = 1 (300) / 0.85 (100) / 0.7 (50) / 1.25 (hold end) / 0.65 (countdown)
    const hit = (m, gain) => {
      const c = ensure();
      if (!c) return;
      const t0 = c.currentTime;
      const dest = out(c, gain);
      switch (O.hitSound) {
        case 'none': return;
        case 'clap': snap(c, dest, t0, 1500 * m, 0.9, 0.09, 1.1); snap(c, dest, t0 + 0.012, 1100 * m, 0.8, 0.07, 0.6); return;
        case 'drum': tone(c, dest, t0, 'sine', 190 * m, 60, 0.13, 1); snap(c, dest, t0, 600, 1, 0.03, 0.4); return;
        case 'soft': tone(c, dest, t0, 'sine', 950 * m, 800 * m, 0.09, 0.6); return;
        case 'chip': tone(c, dest, t0, 'square', 880 * m, 870 * m, 0.05, 0.25); return;
        case 'wood': tone(c, dest, t0, 'triangle', 620 * m, 560 * m, 0.05, 0.7); snap(c, dest, t0, 820 * m, 6, 0.04, 0.5); return;
        case 'default':
          if (defaultBuf) {
            const src = c.createBufferSource(); src.buffer = defaultBuf; src.playbackRate.value = m;
            src.connect(dest); src.start(t0);
            return;
          }
          loadDefault();
          // not decoded (yet): the synthesized tick meanwhile
          snap(c, dest, t0, 4200 * m, 1.2, 0.05, 0.9);
          tone(c, dest, t0, 'triangle', 1400 * m, 700 * m, 0.08, 0.5);
          return;
        case 'custom':
          if (customBuf) {
            const src = c.createBufferSource(); src.buffer = customBuf; src.playbackRate.value = m;
            src.connect(dest); src.start(t0);
            return;
          }
          // not decoded (yet): fall through to the default tick
        default: // 'tick'
          snap(c, dest, t0, 4200 * m, 1.2, 0.05, 0.9);
          tone(c, dest, t0, 'triangle', 1400 * m, 700 * m, 0.08, 0.5);
      }
    };
    const thump = () => {
      const c = ensure();
      if (!c) return;
      tone(c, out(c, 0.9), c.currentTime, 'sine', 170, 55, 0.18, 1);
    };
    const loadDefault = async () => {
      if (defaultBuf || defaultLoading) return;
      const c = ensure();
      if (!c) return;
      defaultLoading = true;
      try { defaultBuf = await c.decodeAudioData(await (await fetch(DEFAULT_HIT_SOUND)).arrayBuffer()); } catch (_) {}
      defaultLoading = false;
    };
    // Decode the uploaded sound (data URL in localStorage) once an audio context exists
    const loadCustom = async () => {
      let url = null;
      try { url = localStorage.getItem(CUSTOM_SOUND_KEY); } catch (_) {}
      if (!url) { customBuf = null; customFor = null; return; }
      if (url === customFor && customBuf) return;
      const c = ensure();
      if (!c) return;
      try {
        const bytes = await (await fetch(url)).arrayBuffer();
        customBuf = await c.decodeAudioData(bytes);
        customFor = url;
      } catch (_) { customBuf = null; customFor = null; }
    };
    // Metronome click, scheduled `delaySec` ahead on the audio clock (sample-accurate beats)
    const metronome = (delaySec, accent) => {
      const c = ensure();
      if (!c) return;
      const t0 = c.currentTime + Math.max(0, delaySec);
      const g = c.createGain();
      g.gain.value = Math.max(0, Math.min(1, +O.metronomeVolume));
      g.connect(c.destination);
      tone(c, g, t0, 'sine', accent ? 1600 : 1050, accent ? 1500 : 1000, 0.035, 0.8);
    };
    return {
      metronome,
      unlock() { ensure(); if (O.hitSound === 'custom') loadCustom(); if (O.hitSound === 'default') loadDefault(); },
      loadCustom,
      play(kind) {
        switch (kind) {
          case 300: hit(1, 1); break;
          case 100: hit(0.85, 0.85); break;
          case 50: hit(0.7, 0.7); break;
          case 'hold': hit(1.25, 0.55); break;   // hold / slider completed
          case 'count': hit(0.65, 0.35); break;  // countdown
          case 'miss': if (+O.missSound) thump(); break; // combo break
        }
      },
    };
  })();

  // ── styles (this script is only loaded when the feature is on) ─────────────
  const style = el('style');
  style.textContent = `
    .sqc-panel { position: fixed; right: 20px; bottom: 20px; transition: right 600ms cubic-bezier(0.45, 0, 0.2, 1); z-index: 2147482000; width: 340px; max-height: 70vh;
      overflow-y: auto; background: var(--dropdown-bg, #232323); border: 1px solid var(--accent, #9f0);
      color: var(--white, #fff); font-family: var(--font, monospace); font-size: 13px; }
    .sqc-panel header { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 8px 10px; border-bottom: 1px solid var(--nav-border-color, #444); font-weight: bold; }
    .sqc-panel .sqc-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
    .sqc-panel .sqc-map { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
      border: 1px solid var(--nav-border-color, #444); background: var(--bg, #111); }
    .sqc-panel .sqc-map .sqc-map-info { flex: 1; min-width: 0; }
    .sqc-panel .sqc-map .sqc-map-title { font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sqc-panel .sqc-map .sqc-map-meta { opacity: 0.65; font-size: 11px; }
    .sqc-panel button { height: 28px; padding: 0 10px; border: 1px solid var(--nav-border-color, #444);
      background: var(--navigation-links-bg, #2b2b2b); color: var(--white, #fff); font-family: inherit; font-size: 12px; cursor: pointer; }
    .sqc-panel button:hover { border-color: var(--accent, #9f0); color: var(--accent, #9f0); }
    .sqc-panel button.sqc-primary { background: var(--accent, #9f0); color: var(--black, #000); border-color: var(--accent, #9f0); font-weight: bold; }
    .sqc-panel input { height: 28px; padding: 0 8px; border: 1px solid var(--nav-border-color, #444);
      background: var(--bg, #111); color: var(--white, #fff); font-family: inherit; }
    .sqc-panel .sqc-muted { opacity: 0.65; font-size: 12px; line-height: 1.4; }
    .sqc-panel table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .sqc-panel td { padding: 3px 4px; border-bottom: 1px solid var(--nav-border-color, #333); }
    .sqc-panel .sqc-grade { font-size: 44px; font-weight: bold; color: var(--accent, #9f0); line-height: 1; }
    .sqc-overlay { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; z-index: 2147481000; cursor: default; touch-action: none; overflow: hidden; }
    .sqc-overlay canvas { position: absolute; left: 0; top: 0; display: block; }
    .sqc-pausebtn { position: absolute; left: 8px; top: 42px; z-index: 3; width: 44px; height: 44px; padding: 0;
      display: flex; align-items: center; justify-content: center; font-size: 18px; cursor: pointer;
      background: rgba(0,0,0,0.55); color: var(--white, #fff); border: 1px solid var(--accent, #9f0); }
    .sqc-overlay.sqc-is-paused .sqc-pausebtn { display: none; }
    body.sqc-settings .global-sidebar-right, body.sqc-settings .item-sidebar-right, body.sqc-settings .index-sidebar-right { z-index: 2147481500 !important; }
    .sqc-settings-back { display: none; position: fixed; left: 12px; top: 12px; z-index: 2147482100; padding: 8px 14px; cursor: pointer;
      background: var(--accent, #9f0); color: var(--black, #000); border: 1px solid var(--accent, #9f0); font-family: var(--font, monospace); font-weight: bold; }
    /* phones: the sidebar covers the game and its pause menu, this gets back to them */
    @media (max-width: 599px), (hover: none) and (pointer: coarse) { .sqc-settings-back { display: block; } }
    .sqc-last-setting { outline: 1px solid var(--accent, #9f0); outline-offset: 2px; transition: outline-color 1.5s; }
    .sqc-pause { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 2; width: 260px;
      display: flex; flex-direction: column; gap: 8px; padding: 16px; background: var(--dropdown-bg, #232323);
      border: 1px solid var(--accent, #9f0); font-family: var(--font, monospace); color: var(--white, #fff); cursor: default; }
    .sqc-pause .sqc-pause-title { font-size: 22px; font-weight: bold; text-align: center; margin-bottom: 4px; }
    .sqc-pause button { height: 34px; border: 1px solid var(--nav-border-color, #444); background: var(--navigation-links-bg, #2b2b2b);
      color: var(--white, #fff); font-family: inherit; font-size: 13px; cursor: pointer; }
    .sqc-pause button:hover { border-color: var(--accent, #9f0); color: var(--accent, #9f0); }
    .sqc-pause button.sqc-primary { background: var(--accent, #9f0); color: var(--black, #000); border-color: var(--accent, #9f0); font-weight: bold; }
    .sqc-edit-bar { position: absolute; left: 0; right: 0; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; background: rgba(0,0,0,0.75); border-bottom: 1px solid var(--nav-border-color, #444);
      font-family: var(--font, monospace); font-size: 12px; color: var(--white, #fff); cursor: default; }
    .sqc-edit-bar input { height: 28px; width: 240px; padding: 0 8px; border: 1px solid var(--nav-border-color, #444);
      background: var(--bg, #111); color: var(--white, #fff); font-family: inherit; }
    .sqc-edit-bar button { height: 28px; padding: 0 10px; border: 1px solid var(--nav-border-color, #444);
      background: var(--navigation-links-bg, #2b2b2b); color: var(--white, #fff); font-family: inherit; font-size: 12px; cursor: pointer; }
    .sqc-edit-bar button:hover { border-color: var(--accent, #9f0); color: var(--accent, #9f0); }
    .sqc-edit-bar button.sqc-primary { background: var(--accent, #9f0); color: var(--black, #000); border-color: var(--accent, #9f0); font-weight: bold; }
    body.sqc-session .v0ck_player_controls, body.sqc-session .v0ck_progress { opacity: 0 !important; pointer-events: none !important; }
    .sqc-edit-bar .sqc-edit-info { margin-left: auto; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;
  document.head.appendChild(style);

  // ── auto maps: generated from the song itself ───────────────────────────────
  // Analysis (once per file, cached): the media is fetched, its audio decoded (video files too: the
  // browser decodes the audio track), mixed to mono at ~22 kHz and cut into ~12 ms slices. Per slice an
  // FFT gives the spectrum, stored as 32 log-spaced frequency bands (30 Hz - 11 kHz). From that:
  // - the tempo (BPM) and beat phase, from how the overall onset curve repeats (autocorrelation)
  // - per preset an onset curve over its own bands with its own method:
  //     flux   = how much the (log) band levels rise from one slice to the next (things starting)
  //     hfc    = flux weighted toward high frequencies (sharp attacks: hats, clicks, consonants)
  //     energy = rise of the total loudness in the bands (swells, drops)
  //     grid   = notes on the beat grid (1/1, 1/2, 1/4 beats) wherever the bands aren't silent
  // Peak picking keeps local maxima clearly above their surroundings, strongest first, with a minimum
  // gap from the difficulty; optional snapping moves notes onto the beat grid.
  // Placement: notes flow across the screen (jump length grows with the gap, the direction drifts and
  // bounces off the edges); longer gaps can become curved sliders. Seeded from item + preset +
  // difficulty, so everyone gets the same map.
  const Auto = (() => {
    const MAX_BYTES = 80 * 1024 * 1024;
    const NB = 32, F_LO = 30, F_HI = 11000; // analysis bands
    const cache = new Map(); // media URL -> Promise of the analysis

    const DIFFICULTIES = {
      easy:   { label: 'Easy',   gap: 450, k: 1.6,  slider: 1000 },
      normal: { label: 'Normal', gap: 280, k: 1.4,  slider: 750 },
      hard:   { label: 'Hard',   gap: 170, k: 1.25, slider: 600 },
      insane: { label: 'Insane', gap: 110, k: 1.15, slider: 500 },
    };
    // bands: [[fromHz, toHz, weight], ...]; kMul/gapMul scale the difficulty's threshold and gap;
    // snap: snap notes to 1/snap beats; sub: beat grid subdivision; jump: jump distance factor;
    // sliders: chance that a long enough gap becomes a slider
    const PRESETS = {
      balanced:   { label: 'Balanced',             desc: 'everything, bass counts a bit more', method: 'flux', bands: [[30, 11000, 1], [30, 250, 0.5]] },
      kick:       { label: 'Kick drum',            desc: '35-120 Hz',                          method: 'flux', bands: [[35, 120, 1]], gapMul: 1.2 },
      bass:       { label: 'Bass line',            desc: '40-300 Hz',                          method: 'flux', bands: [[40, 300, 1]] },
      snare:      { label: 'Snare',                desc: 'body 150-350 Hz + crack 1.8-5 kHz',  method: 'flux', bands: [[150, 350, 1], [1800, 5000, 0.8]] },
      hihat:      { label: 'Hi-hats & cymbals',    desc: '6-11 kHz, sharp attacks',            method: 'hfc',  bands: [[6000, 11000, 1]], gapMul: 0.8 },
      perc:       { label: 'Claps & percussion',   desc: '1-4 kHz',                            method: 'flux', bands: [[1000, 4000, 1]] },
      vocals:     { label: 'Vocals',               desc: '300-3400 Hz, sustained notes slide', method: 'flux', bands: [[300, 3400, 1]], sliders: 0.6 },
      melody:     { label: 'Melody & lead',        desc: '500-6000 Hz',                        method: 'flux', bands: [[500, 6000, 1]] },
      drums:      { label: 'Full drum kit',        desc: 'kick + snare + hats',                method: 'flux', bands: [[35, 120, 1], [150, 350, 0.8], [1800, 5000, 0.5], [6000, 11000, 0.5]] },
      transients: { label: 'Sharp transients',     desc: 'high frequency content, whole range',method: 'hfc',  bands: [[30, 11000, 1]] },
      loudness:   { label: 'Loudness jumps',       desc: 'total energy rises',                 method: 'energy', bands: [[30, 11000, 1]], kMul: 0.9 },
      beat:       { label: 'Beat grid 1/1',        desc: 'on every beat of the detected BPM',  method: 'grid', sub: 1, bands: [[30, 11000, 1]] },
      beat2:      { label: 'Beat grid 1/2',        desc: 'on beats and half beats',            method: 'grid', sub: 2, bands: [[30, 11000, 1]] },
      beat4:      { label: 'Beat grid 1/4',        desc: 'sixteenth notes where the music is', method: 'grid', sub: 4, bands: [[30, 11000, 1]] },
      snapped:    { label: 'Beat-snapped',         desc: 'balanced, snapped to 1/2 beats',     method: 'flux', bands: [[30, 11000, 1], [30, 250, 0.5]], snap: 2 },
      drops:      { label: 'Drops only',           desc: 'only the strongest hits, sparse',    method: 'flux', bands: [[30, 11000, 1], [30, 250, 0.5]], kMul: 1.6, gapMul: 2.2 },
      streams:    { label: 'Streams',              desc: 'dense runs of close notes',          method: 'flux', bands: [[30, 11000, 1]], gapMul: 0.55, jump: 0.45 },
      sliders:    { label: 'Slider heavy',         desc: 'long gaps become sliders',           method: 'flux', bands: [[300, 3400, 1], [30, 250, 0.5]], sliders: 0.9, sliderGapMul: 0.6 },
      jumps:      { label: 'Jumps',                desc: 'balanced timing, big jumps',         method: 'flux', bands: [[30, 11000, 1], [30, 250, 0.5]], jump: 1.7 },
      custom:     { label: 'Custom',               desc: 'your advanced tuner settings',       method: 'flux', bands: [[30, 11000, 1]] },
    };
    // The Custom preset and its difficulty, from the advanced tuner settings
    const customPreset = () => ({
      label: 'Custom', method: O.autoMethod || 'flux',
      bands: [[O.autoB1Lo, O.autoB1Hi, O.autoB1W], [O.autoB2Lo, O.autoB2Hi, O.autoB2W], [O.autoB3Lo, O.autoB3Hi, O.autoB3W]]
        .map(b => b.map(Number)).filter(([lo, hi, w]) => w > 0 && hi > lo),
      snap: +O.autoSnap || 0, sub: Math.max(1, +O.autoGridDiv || 1), jump: +O.autoJump || 1,
      sliders: +O.autoSliderChance, windowMs: +O.autoWindowMs || 230, floor: +O.autoFloor,
    });
    const customDifficulty = () => ({ label: 'Custom', gap: Math.max(30, +O.autoGapMs || 280), k: Math.max(0.5, +O.autoK || 1.4), slider: Math.max(100, +O.autoSliderGapMs || 750) });

    // In-place radix-2 FFT
    const fft = (re, im) => {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let k = 0; k < half; k++) {
            const a = i + k, b = a + half;
            const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
            const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
          }
        }
      }
    };

    // Decode + spectrum per slice, stored as NB band levels (log-compressed). Cached per file.
    const analyze = (src, onProgress) => {
      if (cache.has(src)) return cache.get(src);
      const job = (async () => {
        const res = await fetch(src, { credentials: 'include' });
        if (!res.ok) throw new Error('Could not load the media (' + res.status + ')');
        if ((+res.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('File too large to analyze (over 80 MB)');
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_BYTES) throw new Error('File too large to analyze (over 80 MB)');
        onProgress && onProgress(0.05);
        const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
        const c0 = audio.getChannelData(0), c1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
        const step = audio.sampleRate >= 44100 ? 2 : 1;
        const sr = audio.sampleRate / step;
        const nS = Math.floor(c0.length / step);
        const mono = new Float32Array(nS);
        for (let i = 0; i < nS; i++) {
          let v = 0;
          for (let k = 0; k < step; k++) { const j = i * step + k; v += c0[j] + (c1 ? c1[j] : 0); }
          mono[i] = v / (step * (c1 ? 2 : 1));
        }
        const N = 1024, HOP = 256;
        const frames = Math.max(0, Math.floor((nS - N) / HOP));
        // band edges (log spaced) and which band each FFT bin belongs to
        const edges = Array.from({ length: NB + 1 }, (_, i) => F_LO * Math.pow(F_HI / F_LO, i / NB));
        const centers = Array.from({ length: NB }, (_, i) => Math.sqrt(edges[i] * edges[i + 1]));
        const binBand = new Int16Array(N / 2).fill(-1);
        for (let b = 1; b < N / 2; b++) {
          const f = b * sr / N;
          for (let k = 0; k < NB; k++) if (f >= edges[k] && f < edges[k + 1]) { binBand[b] = k; break; }
        }
        const levels = new Float32Array(frames * NB);
        const win = new Float32Array(N);
        for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
        const re = new Float32Array(N), im = new Float32Array(N), acc = new Float32Array(NB), cnt = new Float32Array(NB);
        for (let f = 0; f < frames; f++) {
          const off = f * HOP;
          for (let i = 0; i < N; i++) { re[i] = mono[off + i] * win[i]; im[i] = 0; }
          fft(re, im);
          acc.fill(0); cnt.fill(0);
          for (let b = 1; b < N / 2; b++) {
            const k = binBand[b];
            if (k < 0) continue;
            acc[k] += Math.sqrt(re[b] * re[b] + im[b] * im[b]); cnt[k]++;
          }
          for (let k = 0; k < NB; k++) levels[f * NB + k] = cnt[k] ? Math.log1p(100 * acc[k] / cnt[k]) : 0;
          if (f % 600 === 0) { onProgress && onProgress(0.05 + 0.9 * f / frames); await new Promise(r => setTimeout(r, 0)); }
        }
        const hopMs = HOP / sr * 1000;
        // A slice's rise peaks when the attack sits in the middle of its window: shift by half a window
        // (+ half a hop) so notes land on the attack, not ~29 ms early
        const shiftMs = (N / 2 + HOP / 2) / sr * 1000;
        const a = { levels, frames, hopMs, shiftMs, centers, duration: audio.duration * 1000 };
        a.tempo = tempo(a);
        return a;
      })();
      cache.set(src, job);
      job.catch(() => cache.delete(src));
      return job;
    };

    // Weight of each analysis band for a preset (by band centre)
    const bandWeights = (preset, a) => a.centers.map(c => preset.bands.reduce((w, [lo, hi, wt]) => w + (c >= lo && c < hi ? wt : 0), 0));

    // Onset curve for a preset's bands and method
    const curve = (a, preset) => {
      const w = bandWeights(preset, a);
      const { levels, frames } = a;
      const out = new Float32Array(frames);
      const method = preset.method === 'grid' ? 'flux' : preset.method;
      let prevE = 0;
      for (let f = 1; f < frames; f++) {
        let v = 0, e = 0;
        for (let k = 0; k < NB; k++) {
          if (!w[k]) continue;
          const cur = levels[f * NB + k], d = cur - levels[(f - 1) * NB + k];
          if (method === 'energy') e += w[k] * cur;
          else if (d > 0) v += w[k] * d * (method === 'hfc' ? a.centers[k] / 1000 : 1);
        }
        if (method === 'energy') { out[f] = Math.max(0, e - prevE); prevE = e; } else out[f] = v;
      }
      return out;
    };

    // BPM and beat phase from the balanced onset curve: the lag (60-200 BPM) at which the curve best
    // matches itself, then the offset whose beat positions carry the most onset energy
    const tempo = (a) => {
      const c = curve(a, PRESETS.balanced);
      const n = c.length;
      if (n < 400) return null;
      let mean = 0;
      for (let i = 0; i < n; i++) mean += c[i];
      mean /= n;
      const x = Float32Array.from(c, v => v - mean);
      const lagMin = Math.round(60000 / 200 / a.hopMs), lagMax = Math.round(60000 / 60 / a.hopMs);
      let best = 0, bestLag = 0;
      for (let lag = lagMin; lag <= lagMax; lag++) {
        let sum = 0;
        for (let i = 0; i + lag < n; i += 2) sum += x[i] * x[i + lag];
        // gently prefer 80-160 BPM (avoids halving / doubling)
        const bpm = 60000 / (lag * a.hopMs);
        const prefer = bpm >= 80 && bpm <= 160 ? 1.15 : 1;
        if (sum * prefer > best) { best = sum * prefer; bestLag = lag; }
      }
      if (!bestLag) return null;
      let bestPhase = 0, bestSum = -1;
      for (let ph = 0; ph < bestLag; ph++) {
        let sum = 0;
        for (let i = ph; i < n; i += bestLag) sum += c[i];
        if (sum > bestSum) { bestSum = sum; bestPhase = ph; }
      }
      const periodMs = bestLag * a.hopMs;
      return { bpm: Math.round(60000 / periodMs * 10) / 10, periodMs, phaseMs: bestPhase * a.hopMs + a.shiftMs };
    };

    // Note times (ms) for a preset + difficulty
    const times = (a, preset, diff) => {
      const c = curve(a, preset);
      const n = c.length;
      const W = Math.max(2, Math.round((preset.windowMs || 230) / a.hopMs)); // moving-average window (frames)
      const floor = preset.floor != null ? preset.floor : 0.04;               // share of the loudest peak
      const k = diff.k * (preset.kMul || 1);
      const gap = diff.gap * (preset.gapMul || 1);
      const pre = new Float64Array(n + 1);
      let max = 0;
      for (let i = 0; i < n; i++) { pre[i + 1] = pre[i] + c[i]; if (c[i] > max) max = c[i]; }
      const localMean = (i) => { const lo = Math.max(0, i - W), hi = Math.min(n, i + W + 1); return (pre[hi] - pre[lo]) / (hi - lo); };
      let cand = [];
      if (preset.method === 'grid') {
        if (!a.tempo) return [];
        const stepMs = a.tempo.periodMs / (preset.sub || 1);
        for (let t = a.tempo.phaseMs; t < a.duration; t += stepMs) {
          const i = Math.round((t - a.shiftMs) / a.hopMs);
          if (i < 2 || i >= n - 2) continue;
          const v = Math.max(c[i - 1], c[i], c[i + 1]);
          if (v > localMean(i) * 0.9 + max * 0.02) cand.push({ t, s: v }); // skip silent grid points
        }
      } else {
        for (let i = 2; i < n - 2; i++) {
          const v = c[i];
          if (v < c[i - 1] || v < c[i + 1] || v < c[i - 2] || v < c[i + 2]) continue;
          const m = localMean(i);
          if (v > m * k + max * floor) cand.push({ t: i * a.hopMs + a.shiftMs, s: v - m });
        }
        if (preset.snap && a.tempo) { // snap onto the beat grid when close
          const stepMs = a.tempo.periodMs / preset.snap;
          cand = cand.map(p => {
            const g = a.tempo.phaseMs + Math.round((p.t - a.tempo.phaseMs) / stepMs) * stepMs;
            return Math.abs(g - p.t) <= Math.min(60, stepMs / 3) ? { t: g, s: p.s } : p;
          });
        }
      }
      cand.sort((x, y) => y.s - x.s);
      const kept = [];
      for (const p of cand) {
        if (p.t < 300) continue;
        if (kept.every(q => Math.abs(q - p.t) >= gap)) kept.push(p.t);
        if (kept.length >= 3000) break;
      }
      return kept.sort((x, y) => x - y);
    };

    const seeded = (str) => { // mulberry32 from a string hash
      let h = 1779033703;
      for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
      let a = h >>> 0;
      return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    };

    const place = (ts, preset, diff, seed) => {
      const rnd = seeded(seed);
      const W = innerWidth, H = innerHeight;
      const X0 = W * 0.12, X1 = W * 0.88, Y0 = H * 0.18, Y1 = H * 0.85;
      const inside = (x, y) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
      const clampX = (x) => Math.max(X0, Math.min(X1, x)), clampY = (y) => Math.max(Y0, Math.min(Y1, y));
      const jump = preset.jump || 1;
      const sliderGap = diff.slider * (preset.sliderGapMul || 1);
      const sliderChance = preset.sliders != null ? preset.sliders : 0.45;
      let x = W / 2, y = H / 2, ang = rnd() * Math.PI * 2;
      const notes = [];
      for (let i = 0; i < ts.length; i++) {
        const t = Math.round(ts[i]);
        if (i) {
          const gap = t - ts[i - 1];
          const dist = Math.max(NOTE * 1.3, Math.min(Math.min(W, H) * 0.4, gap * 0.45 * jump));
          ang += (rnd() - 0.5) * 1.6;
          let nx = x + Math.cos(ang) * dist, ny = y + Math.sin(ang) * dist;
          if (!inside(nx, ny)) { // bounce back toward the middle
            ang = Math.atan2(H / 2 - y, W / 2 - x) + (rnd() - 0.5) * 0.9;
            nx = x + Math.cos(ang) * dist; ny = y + Math.sin(ang) * dist;
          }
          x = clampX(nx); y = clampY(ny);
        }
        const note = { t, x: +(x / W).toFixed(4), y: +(y / H).toFixed(4), d: 0 };
        const next = ts[i + 1];
        if (next && next - t >= sliderGap && rnd() < sliderChance) { // curved slider into the gap
          const d = Math.min(1400, Math.round((next - t) * 0.55));
          const L = Math.max(110, Math.min(280, d * 0.28));
          const bend = (rnd() - 0.5) * 2.2;
          let hx = x, hy = y, a = ang;
          if (!inside(x + Math.cos(a) * L, y + Math.sin(a) * L)) a = Math.atan2(H / 2 - y, W / 2 - x);
          const p = [[0, note.x, note.y]];
          for (let k = 1; k <= 16; k++) {
            const hd = a + bend * (k / 16);
            hx = clampX(hx + Math.cos(hd) * L / 16); hy = clampY(hy + Math.sin(hd) * L / 16);
            p.push([Math.round(d * k / 16), +(hx / W).toFixed(4), +(hy / H).toFixed(4)]);
          }
          note.d = d; note.p = p;
          x = hx; y = hy; ang = a + bend;
        }
        notes.push(note);
      }
      return notes;
    };

    return {
      PRESETS, DIFFICULTIES,
      // Detected tempo of a media file ({ bpm, periodMs, phaseMs } or null), from the cached analysis
      async tempoFor(media) {
        const src = media.currentSrc || media.src;
        if (!src) return null;
        return (await analyze(src)).tempo;
      },
      // -> { id: null, title, notes, itemId, duration_ms, bpm } ready for playMap()
      // Fill the Custom (advanced) settings from a preset + difficulty, as a starting point
      copyToCustom(presetKey, diffKey) {
        const p = PRESETS[presetKey] || PRESETS.balanced;
        const d = DIFFICULTIES[diffKey] || DIFFICULTIES.normal;
        const b = (p.bands || []).concat([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
        Object.assign(O, {
          autoMethod: p.method,
          autoB1Lo: b[0][0], autoB1Hi: b[0][1], autoB1W: b[0][2],
          autoB2Lo: b[1][0], autoB2Hi: b[1][1], autoB2W: b[1][2],
          autoB3Lo: b[2][0], autoB3Hi: b[2][1], autoB3W: b[2][2],
          autoK: +(d.k * (p.kMul || 1)).toFixed(2), autoGapMs: Math.round(d.gap * (p.gapMul || 1)),
          autoWindowMs: p.windowMs || 230, autoFloor: p.floor != null ? p.floor : 0.04,
          autoSnap: p.snap || 0, autoGridDiv: p.sub || 2, autoJump: p.jump || 1,
          autoSliderChance: p.sliders != null ? p.sliders : 0.45, autoSliderGapMs: Math.round(d.slider * (p.sliderGapMul || 1)),
          autoPreset: 'custom',
        });
      },
      async build(media, itemId, presetKey, diffKey, onProgress) {
        const isCustom = presetKey === 'custom';
        const preset = isCustom ? customPreset() : (PRESETS[presetKey] || PRESETS.balanced);
        const diff = isCustom ? customDifficulty() : (DIFFICULTIES[diffKey] || DIFFICULTIES.normal);
        if (!preset.bands.length) throw new Error('The custom preset has no frequency band with a weight above 0');
        const src = media.currentSrc || media.src;
        if (!src) throw new Error('No media source');
        const a = await analyze(src, onProgress);
        if (preset.method === 'grid' && !a.tempo) throw new Error('Could not detect a tempo in this file');
        const ts = times(a, preset, diff);
        if (!ts.length) throw new Error('No notes found for this preset: try another one');
        return {
          id: null, auto: true, itemId, duration_ms: Math.round(a.duration), bpm: a.tempo && a.tempo.bpm,
          title: isCustom ? 'Auto · Custom' : 'Auto · ' + preset.label + ' · ' + diff.label,
          notes: place(ts, preset, diff, itemId + ':' + presetKey + ':' + (isCustom ? JSON.stringify(preset) + JSON.stringify(diff) : diffKey)),
        };
      },
    };
  })();

  // for debugging / testing: the generator and the running session (read-only use)
  window.f0ckSqc = { Auto, get session() { return S; } };

  // ── settings API for the sidebar tuner's "Square Clicker" tab (built from this schema by f0ckm.js) ──
  const SCHEMA = [
    { section: 'Sounds' },
    { key: 'hitSound', label: 'Hit sound', type: 'select', options: [
      ['default', 'Default (hitsound.mp3)'], ['tick', 'Tick'], ['clap', 'Clap'], ['drum', 'Drum'], ['soft', 'Soft'], ['chip', '8-bit'], ['wood', 'Wood'], ['custom', 'Custom sound file'], ['none', 'None'],
    ] },
    { key: 'customSound', label: 'Custom sound file', type: 'file', accept: 'audio/*', activeWhen: ['hitSound', 'custom'] },
    { key: 'volume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'missSound', label: 'Combo break sound', type: 'toggle' },
    { key: 'countdownTicks', label: 'Countdown ticks', type: 'toggle' },
    { section: 'Gameplay' },
    { key: 'approachMs', label: 'Approach time (lower = faster notes)', type: 'range', min: 400, max: 1800, step: 50, unit: 'ms' },
    { key: 'noteSize', label: 'Note size', type: 'range', min: 40, max: 130, step: 2, unit: 'px' },
    { key: 'noteShape', label: 'Note shape', type: 'select', options: SHAPES },
    { key: 'noteImage', label: 'Note image / GIF', type: 'file', accept: 'image/*', activeWhen: ['noteShape', 'image'] },
    { key: 'noteNumbers', label: 'Numbers on notes', type: 'toggle' },
    { key: 'followMul', label: 'Slider follow zone', type: 'range', min: 1, max: 3, step: 0.1, unit: 'x' },
    { key: 'leadInMs', label: 'Countdown before the song', type: 'range', min: 0, max: 5000, step: 250, unit: 'ms' },
    { key: 'offsetMs', label: 'Audio offset (+ if you hear it late)', type: 'range', min: -250, max: 250, step: 5, unit: 'ms' },
    { key: 'dimColor', label: 'Background colour', type: 'color' },
    { key: 'dimAudio', label: 'Background opacity (audio)', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'dimVideo', label: 'Background opacity (video)', type: 'range', min: 0, max: 1, step: 0.05 },
    { section: 'BPM & metronome' },
    { key: 'bpmMode', label: 'BPM', type: 'select', options: [['auto', 'Detect from the song'], ['manual', 'Manual (below)']] },
    { key: 'bpm', label: 'Manual BPM', type: 'range', min: 40, max: 300, step: 0.5, unit: ' bpm' },
    { key: 'beatOffsetMs', label: 'Manual beat offset (first beat at)', type: 'range', min: 0, max: 3000, step: 5, unit: 'ms' },
    { key: 'beatsPerBar', label: 'Beats per bar (accented click)', type: 'range', min: 1, max: 8, step: 1 },
    { key: 'metronomeRecord', label: 'Metronome while recording', type: 'toggle' },
    { key: 'metronomePlay', label: 'Metronome while playing', type: 'toggle' },
    { key: 'metronomeVolume', label: 'Metronome volume', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'snapRecord', label: 'Snap recorded notes to the beat', type: 'select', options: [['0', 'Off'], ['1', '1/1 beats'], ['2', '1/2 beats'], ['4', '1/4 beats']] },
    { section: 'Auto maps' },
    { key: 'autoPreset', label: 'Preset', type: 'select', options: Object.keys(Auto.PRESETS).map(k => [k, Auto.PRESETS[k].label]) },
    { key: 'autoDifficulty', label: 'Difficulty (not used by Custom)', type: 'select', options: Object.keys(Auto.DIFFICULTIES).map(k => [k, Auto.DIFFICULTIES[k].label]) },
    { type: 'actions', buttons: [['quickPlay', 'Quick play on this item'], ['copyPreset', 'Copy preset to Custom']] },
    { key: 'autoAdvanced', label: 'Advanced tuning (the Custom preset)', type: 'toggle' },
    { key: 'autoMethod', label: 'Detection method', type: 'select', showIf: 'autoAdvanced', options: [['flux', 'Spectral flux (things starting)'], ['hfc', 'HFC (sharp attacks)'], ['energy', 'Energy (loudness jumps)'], ['grid', 'Beat grid']] },
    { key: 'autoB1Lo', label: 'Band 1 from', type: 'range', min: 20, max: 11000, step: 10, unit: ' Hz', showIf: 'autoAdvanced' },
    { key: 'autoB1Hi', label: 'Band 1 to', type: 'range', min: 20, max: 11000, step: 10, unit: ' Hz', showIf: 'autoAdvanced' },
    { key: 'autoB1W', label: 'Band 1 weight (0 = off)', type: 'range', min: 0, max: 3, step: 0.1, showIf: 'autoAdvanced' },
    { key: 'autoB2Lo', label: 'Band 2 from', type: 'range', min: 20, max: 11000, step: 10, unit: ' Hz', showIf: 'autoAdvanced' },
    { key: 'autoB2Hi', label: 'Band 2 to', type: 'range', min: 20, max: 11000, step: 10, unit: ' Hz', showIf: 'autoAdvanced' },
    { key: 'autoB2W', label: 'Band 2 weight (0 = off)', type: 'range', min: 0, max: 3, step: 0.1, showIf: 'autoAdvanced' },
    { key: 'autoB3Lo', label: 'Band 3 from', type: 'range', min: 20, max: 11000, step: 10, unit: ' Hz', showIf: 'autoAdvanced' },
    { key: 'autoB3Hi', label: 'Band 3 to', type: 'range', min: 20, max: 11000, step: 10, unit: ' Hz', showIf: 'autoAdvanced' },
    { key: 'autoB3W', label: 'Band 3 weight (0 = off)', type: 'range', min: 0, max: 3, step: 0.1, showIf: 'autoAdvanced' },
    { key: 'autoK', label: 'Threshold (x the surroundings; lower = more notes)', type: 'range', min: 0.8, max: 3, step: 0.05, unit: 'x', showIf: 'autoAdvanced' },
    { key: 'autoGapMs', label: 'Minimum gap between notes', type: 'range', min: 40, max: 1500, step: 10, unit: 'ms', showIf: 'autoAdvanced' },
    { key: 'autoWindowMs', label: 'Threshold window (surroundings)', type: 'range', min: 50, max: 1000, step: 10, unit: 'ms', showIf: 'autoAdvanced' },
    { key: 'autoFloor', label: 'Silence floor (share of the loudest peak)', type: 'range', min: 0, max: 0.3, step: 0.01, showIf: 'autoAdvanced' },
    { key: 'autoSnap', label: 'Snap to the beat', type: 'select', showIf: 'autoAdvanced', options: [['0', 'Off'], ['1', '1/1'], ['2', '1/2'], ['4', '1/4']] },
    { key: 'autoGridDiv', label: 'Beat grid subdivision (grid method)', type: 'select', showIf: 'autoAdvanced', options: [['1', '1/1'], ['2', '1/2'], ['4', '1/4']] },
    { key: 'autoJump', label: 'Jump distance', type: 'range', min: 0.2, max: 2.5, step: 0.05, unit: 'x', showIf: 'autoAdvanced' },
    { key: 'autoSliderChance', label: 'Slider chance on long gaps', type: 'range', min: 0, max: 1, step: 0.05, showIf: 'autoAdvanced' },
    { key: 'autoSliderGapMs', label: 'Gap needed for a slider', type: 'range', min: 200, max: 3000, step: 50, unit: 'ms', showIf: 'autoAdvanced' },
  ];
  const customSoundName = () => { try { return localStorage.getItem(CUSTOM_SOUND_KEY + '_name') || ''; } catch (_) { return ''; } };
  const noteImageName = () => { try { return localStorage.getItem(NOTE_IMAGE_KEY + '_name') || ''; } catch (_) { return ''; } };
  const readDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const settingsChanged = () => {
    saveSettings();
    applySettings();
    window.dispatchEvent(new CustomEvent('f0ck:sqc_settings_changed', { detail: settingsApi.getState() }));
  };
  const rememberSetting = (key) => { try { localStorage.setItem(LAST_SETTING_KEY, key); } catch (_) {} };
  const settingsApi = {
    schema: SCHEMA,
    defaults: Object.assign({}, SQC_DEFAULTS),
    getState: () => Object.assign({}, O, { customSound: customSoundName(), noteImage: noteImageName() }),
    // File rows of the schema: the hit sound (customSound) or the note image (noteImage)
    async setFile(key, file) {
      rememberSetting(key);
      if (key === 'customSound') return settingsApi.setCustomSound(file);
      if (key !== 'noteImage') return { ok: false, msg: 'Unknown setting' };
      if (!file || !/^image\//.test(file.type)) return { ok: false, msg: 'Pick an image or GIF' };
      if (file.size > NOTE_IMAGE_MAX) return { ok: false, msg: 'Image too large (max 2 MB)' };
      const url = await readDataUrl(file);
      try {
        localStorage.setItem(NOTE_IMAGE_KEY, url);
        localStorage.setItem(NOTE_IMAGE_KEY + '_name', file.name);
      } catch (_) { return { ok: false, msg: 'Not enough browser storage' }; }
      O.noteShape = 'image';
      noteImgFor = null; // reload even if the same shape was already on
      settingsChanged();
      return { ok: true };
    },
    clearFile(key) {
      if (key === 'customSound') return settingsApi.clearCustomSound();
      if (key !== 'noteImage') return;
      try { localStorage.removeItem(NOTE_IMAGE_KEY); localStorage.removeItem(NOTE_IMAGE_KEY + '_name'); } catch (_) {}
      if (O.noteShape === 'image') O.noteShape = 'square';
      settingsChanged();
    },
    set(key, val) {
      if (!(key in SQC_DEFAULTS)) return;
      rememberSetting(key);
      O[key] = typeof SQC_DEFAULTS[key] === 'number' ? (Number(val) || 0) : String(val);
      settingsChanged();
      if (key === 'hitSound' && val === 'custom') Sfx.loadCustom();
    },
    reset() { Object.assign(O, SQC_DEFAULTS); settingsChanged(); },
    // Store an uploaded sound (as a data URL, per device) and switch to it
    async setCustomSound(file) {
      if (!file) return { ok: false, msg: 'No file' };
      if (file.size > CUSTOM_SOUND_MAX) return { ok: false, msg: 'File too large (max 700 KB)' };
      const url = await readDataUrl(file);
      try {
        localStorage.setItem(CUSTOM_SOUND_KEY, url);
        localStorage.setItem(CUSTOM_SOUND_KEY + '_name', file.name);
      } catch (_) { return { ok: false, msg: 'Not enough browser storage' }; }
      O.hitSound = 'custom';
      settingsChanged();
      await Sfx.loadCustom();
      return { ok: true };
    },
    clearCustomSound() {
      try { localStorage.removeItem(CUSTOM_SOUND_KEY); localStorage.removeItem(CUSTOM_SOUND_KEY + '_name'); } catch (_) {}
      if (O.hitSound === 'custom') O.hitSound = 'default';
      Sfx.loadCustom();
      settingsChanged();
    },
    preview() { Sfx.unlock(); Sfx.play(300); },
    action(name) {
      if (name === 'quickPlay') {
        if (!getAudio()) return { ok: false, msg: 'Open an audio or video item first' };
        startAuto(O.autoPreset, O.autoDifficulty);
        return { ok: true };
      }
      if (name === 'copyPreset') {
        Auto.copyToCustom(O.autoPreset === 'custom' ? 'balanced' : O.autoPreset, O.autoDifficulty);
        O.autoAdvanced = 1;
        settingsChanged();
        return { ok: true, msg: 'Copied to Custom' };
      }
      return { ok: false };
    },
  };
  window.f0ckSqcSettings = settingsApi;
  // Tell a tuner that was built before this script to show its Square Clicker tab
  window.dispatchEvent(new CustomEvent('f0ck:sqc_settings_changed', { detail: settingsApi.getState() }));

  const startAuto = async (presetKey, diffKey) => {
    const media = getAudio();
    const itemId = getItemId();
    if (!media || !itemId) return;
    const body = openPanel('Auto map');
    const status = el('div', 'sqc-muted', 'Analyzing the song...');
    body.appendChild(status);
    try {
      const map = await Auto.build(media, itemId, presetKey, diffKey, (p) => { status.textContent = 'Analyzing the song... ' + Math.round(p * 100) + '%'; });
      map.subId = getSubId();
      playMap(map);
    } catch (e) {
      status.textContent = 'Could not generate a map: ' + (e && e.message ? e.message : e);
      const back = el('button', null, 'Back to maps');
      back.addEventListener('click', showMaps);
      body.appendChild(back);
    }
  };

  // ── entry button + panel ────────────────────────────────────────────────────
  let panel = null;
  let panelFor = null; // item:entry the open maps list is for

  // ── beatmap import ──────────────────────────────────────────────────────────
  // .osz sets are zips: only their .osu text files are read here (central directory, stored or deflated
  // entries via DecompressionStream) and sent to the server, which converts them. The set's song is not
  // uploaded: the maps are for the song this item already has.
  const readZipTexts = async (file, want) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count && dv.getUint32(off, true) === 0x02014b50; n++) {
      const method = dv.getUint16(off + 10, true), size = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), commentLen = dv.getUint16(off + 32, true);
      const local = dv.getUint32(off + 42, true);
      const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
      if (!want(name)) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = buf.subarray(start, start + size);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else continue;
      out.push({ name, text: dec.decode(data) });
    }
    return out;
  };

  const importBeatmaps = (btn) => {
    const input = el('input');
    input.type = 'file';
    input.accept = '.osz,.osu';
    input.multiple = true;
    input.addEventListener('change', async () => {
      const picked = [...input.files];
      if (!picked.length) return;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Importing...';
      try {
        const files = [];
        for (const f of picked) {
          if (/\.osu$/i.test(f.name)) files.push({ name: f.name, text: await f.text() });
          else files.push(...await readZipTexts(f, (n) => /\.osu$/i.test(n)));
        }
        if (!files.length) { flash('No .osu difficulties found in that file', 'error'); return; }
        const media = getAudio();
        const r = await api('/api/v2/sqc/import', { method: 'POST', body: JSON.stringify({
          item_id: getItemId(), album_item_id: getSubId(), files, duration_ms: media ? Math.round((media.duration || 0) * 1000) : 0,
        }) });
        if (!r.success) { flash(r.msg || 'Import failed', 'error'); return; }
        const skipped = (r.skipped || []).map(d => d.version + ' (' + d.reason + ')');
        flash(r.imported + ' map' + (r.imported === 1 ? '' : 's') + ' imported' + (skipped.length ? '. Skipped: ' + skipped.join(', ') : ''), r.imported ? 'success' : 'error');
        showMaps();
      } catch (e) {
        flash('Could not read the beatmap: ' + (e.message || e), 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
    input.click();
  };
  const closePanel = () => { if (panel) panel.remove(); panel = null; };
  // The maps panel sits left of the right sidebar when that is open (on phones the sidebar covers the
  // screen: there the panel stays at the edge). Follows the sidebar opening / closing.
  const placePanel = () => {
    if (!panel) return;
    const bar = document.querySelector(SIDEBAR_SEL);
    const open = bar && !document.body.classList.contains('sidebar-right-hidden') && innerWidth > 599;
    panel.style.right = (open ? (bar.offsetWidth || 300) + 20 : 20) + 'px';
  };
  new MutationObserver(placePanel).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', placePanel);
  const openPanel = (title) => {
    closePanel();
    panelFor = null; // set again by showMaps; other panels (draft, results) stay when the album entry changes
    panel = el('div', 'sqc-panel');
    const head = el('header');
    head.appendChild(el('span', null, title || 'Square Clicker'));
    const x = el('button', null, '×');
    x.title = 'Close';
    x.addEventListener('click', closePanel);
    head.appendChild(x);
    panel.appendChild(head);
    const body = el('div', 'sqc-body');
    panel.appendChild(body);
    document.body.appendChild(panel);
    placePanel();
    return body;
  };

  const injectButton = () => {
    const root = scope();
    if ((!getAudio() && !albumHasMedia()) || root.querySelector('#a_sqc')) return;
    const row = root.querySelector('.gapRight');
    if (!row) return;
    const b = el('i', 'iconset fa-solid fa-circle-dot');
    b.id = 'a_sqc';
    b.title = 'Square Clicker';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showMaps(); });
    row.appendChild(b);
  };

  const showMaps = async () => {
    const itemId = getItemId();
    if (!itemId) return;
    const body = openPanel();
    body.appendChild(el('div', 'sqc-muted', 'Loading maps...'));
    const subId = getSubId();
    panelFor = itemId + ':' + subId;
    if (!getAudio()) { // album showing an image / YouTube entry
      body.textContent = '';
      body.appendChild(el('div', 'sqc-muted', 'Switch to an audio or video entry of this album: every entry has its own maps.'));
      return;
    }
    const data = await api('/api/v2/sqc/maps?item_id=' + encodeURIComponent(itemId) + (subId ? '&album_item_id=' + subId : ''));
    if (panelFor !== itemId + ':' + subId) return; // switched entries meanwhile
    body.textContent = '';
    body.appendChild(el('div', 'sqc-muted',
      'The whole site is a rhythm game. Pick a map, generate one from the song, or make your own: click along to the song, hold (and drag) for long notes.'));
    const maps = (data && data.maps) || [];
    if (!maps.length) body.appendChild(el('div', 'sqc-muted', 'No maps for this song yet. Be the first.'));
    const me = window.f0ckSession || {};
    maps.forEach(m => {
      const row = el('div', 'sqc-map');
      const info = el('div', 'sqc-map-info');
      info.appendChild(el('div', 'sqc-map-title', m.title));
      info.appendChild(el('div', 'sqc-map-meta',
        'by ' + (m.username || 'someone') + ' · ' + m.note_count + ' notes · ' + (m.plays || 0) + ' plays' +
        (m.best != null ? ' · best ' + Number(m.best).toLocaleString() : '')));
      row.appendChild(info);
      const play = el('button', 'sqc-primary', 'Play');
      play.addEventListener('click', () => startPlay(m.id));
      row.appendChild(play);
      if (me.admin || me.is_moderator || (me.id && m.user_id === me.id)) {
        const edit = el('button', null, 'Edit');
        edit.title = 'Edit this map';
        edit.addEventListener('click', () => startEdit(m.id));
        row.appendChild(edit);
        const del = el('button', null, '×');
        del.title = 'Delete map';
        del.addEventListener('click', async () => {
          if (!confirm('Delete the map "' + m.title + '"?')) return;
          const r = await api('/api/v2/sqc/maps/' + m.id, { method: 'DELETE' });
          if (r.success) showMaps(); else flash(r.msg || 'Could not delete', 'error');
        });
        row.appendChild(del);
      }
      body.appendChild(row);
    });
    // Auto maps generated from the song: a preset (what to listen for) + a difficulty
    const autoBox = el('div', 'sqc-map');
    autoBox.style.flexWrap = 'wrap';
    const autoInfo = el('div', 'sqc-map-info');
    autoInfo.style.flexBasis = '100%';
    autoInfo.appendChild(el('div', 'sqc-map-title', 'Auto map'));
    const presetSel = el('select');
    presetSel.style.cssText = 'width: 100%; height: 28px; margin-top: 4px; background: var(--bg, #111); color: var(--white, #fff); border: 1px solid var(--nav-border-color, #444); font-family: inherit;';
    Object.keys(Auto.PRESETS).forEach(k => {
      const o = el('option', null, Auto.PRESETS[k].label + ' (' + Auto.PRESETS[k].desc + ')');
      o.value = k;
      presetSel.appendChild(o);
    });
    presetSel.value = Auto.PRESETS[O.autoPreset] ? O.autoPreset : 'balanced';
    presetSel.addEventListener('change', () => { O.autoPreset = presetSel.value; saveSettings(); });
    autoInfo.appendChild(presetSel);
    autoBox.appendChild(autoInfo);
    Object.keys(Auto.DIFFICULTIES).forEach(level => {
      const b = el('button', level === O.autoDifficulty ? 'sqc-primary' : null, Auto.DIFFICULTIES[level].label);
      b.addEventListener('click', () => { O.autoDifficulty = level; saveSettings(); startAuto(presetSel.value, level); });
      autoBox.appendChild(b);
    });
    body.appendChild(autoBox);
    body.appendChild(el('div', 'sqc-muted', 'Sounds, keys, speed and more: sidebar tuner, Square Clicker tab.'));
    if (loggedIn()) {
      const create = el('button', null, '+ Create a map');
      create.addEventListener('click', () => startRecord());
      body.appendChild(create);
      const imp = el('button', null, 'Import beatmap (.osz / .osu)');
      imp.title = 'Adds the standard-mode difficulties of a beatmap set as maps for this song';
      imp.addEventListener('click', () => importBeatmaps(imp));
      body.appendChild(imp);
    } else {
      body.appendChild(el('div', 'sqc-muted', 'Log in to create maps and save scores.'));
    }
  };

  // ── session (record or play) ────────────────────────────────────────────────
  let S = null; // current session

  // Song time in ms, interpolated between audio timeupdates for smooth motion
  const songTime = () => {
    if (!S) return 0;
    const a = S.audio;
    if (S.leadUntil) return S.leadRemaining != null ? -S.leadRemaining : performance.now() - S.leadUntil; // negative during lead-in
    const off = +O.offsetMs || 0; // audio offset setting: positive when you hear the song late
    const t = a.currentTime * 1000;
    if (t !== S.lastAudioT) { S.lastAudioT = t; S.lastPerf = performance.now(); return t - off; }
    return (a.paused ? t : t + (performance.now() - S.lastPerf)) - off;
  };

  const makeOverlay = () => {
    const ov = el('div', 'sqc-overlay');
    const cv = el('canvas');
    ov.appendChild(cv);
    document.body.appendChild(ov);
    const ctx = cv.getContext('2d');
    // The overlay is sized to exactly innerWidth x innerHeight (the coordinates everything is drawn and
    // hit-tested in) and the canvas backing store to that at the real pixel ratio. A plain inset: 0
    // overlay leaves out the page scrollbar in Chromium, so the canvas was squeezed by the scrollbar
    // width: resampled every frame (shimmering, smeared edges) and drawn slightly off from where clicks count.
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      ov.style.width = innerWidth + 'px'; ov.style.height = innerHeight + 'px';
      cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
      cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    return { ov, cv, ctx, size };
  };

  const endSession = () => {
    if (!S) return;
    cancelAnimationFrame(S.raf);
    window.removeEventListener('blur', S.onBlur);
    window.removeEventListener('resize', S.view.size);
    S.audio.removeEventListener('ended', S.onEnded);
    closeSettings();
    S.view.ov.remove();
    document.body.classList.remove('sqc-session');
    const s = S;
    S = null;
    return s;
  };

  const startSession = (mode, extra) => {
    endSession();
    closePanel();
    const audio = getAudio();
    if (!audio) { flash('Open an audio or video item first', 'error'); return null; }
    const view = makeOverlay();
    S = Object.assign({ mode, audio, view, lastAudioT: -1, lastPerf: 0, mouse: { x: innerWidth / 2, y: innerHeight / 2 }, fx: [] }, extra);
    window.addEventListener('resize', view.size);
    // Pause button: the way to pause (and from the menu stop) without a keyboard, e.g. on phones
    const pb = el('button', 'sqc-pausebtn');
    pb.type = 'button';
    pb.title = 'Pause (Esc)';
    pb.setAttribute('aria-label', 'Pause');
    pb.innerHTML = '<i class="fa-solid fa-pause"></i>';
    pb.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); pause(true); });
    view.ov.appendChild(pb);
    // No player controls popping up while playing (v0ck ignores hover during a session, see v0ck.js)
    document.body.classList.add('sqc-session');
    document.querySelectorAll('.v0ck_hover').forEach(e => e.classList.remove('v0ck_hover'));
    view.ov.addEventListener('pointermove', (e) => { S && (S.mouse = { x: e.clientX, y: e.clientY }); });
    try { audio.pause(); audio.currentTime = 0; } catch (_) {}
    Sfx.unlock();
    resolveTempo(S);
    return S;
  };

  // Tempo for this session: manual BPM from the tuner, or detected from the song (cached analysis;
  // ready after the first decode, usually during the countdown). Only fetched when something needs it.
  const resolveTempo = (s) => {
    s.tempo = null;
    if (O.bpmMode === 'manual') {
      const bpm = Math.max(20, +O.bpm || 120);
      s.tempo = { bpm, periodMs: 60000 / bpm, phaseMs: +O.beatOffsetMs || 0 };
      return;
    }
    Auto.tempoFor(s.audio).then(tp => { if (S === s && tp) s.tempo = tp; }).catch(() => {});
  };

  // Metronome: schedules the beats of the next 120 ms on the audio clock every frame (sample-accurate,
  // not tied to the frame rate). First beat of each bar accented.
  const tickMetronome = (t) => {
    const on = S.mode === 'record' ? +O.metronomeRecord : +O.metronomePlay;
    if (!on || !S.tempo || t < -30 || S.audio.paused) return;
    const { periodMs, phaseMs } = S.tempo;
    const bpb = Math.max(1, Math.round(+O.beatsPerBar || 4));
    const LOOK = 120;
    const first = Math.ceil((t - 5 - phaseMs) / periodMs);
    if (S.metIdx == null || S.metIdx < first - 1) S.metIdx = first - 1;
    for (let i = S.metIdx + 1; ; i++) {
      const bt = phaseMs + i * periodMs;
      if (bt > t + LOOK) break;
      Sfx.metronome((bt - t) / 1000, ((i % bpb) + bpb) % bpb === 0);
      S.metIdx = i;
    }
  };

  // Shared: a quick expanding square where something happened
  const addFx = (x, y, text, color) => { if (S) S.fx.push({ x, y, text, color, t: performance.now() }); };
  const drawFx = (ctx) => {
    const now = performance.now();
    S.fx = S.fx.filter(f => now - f.t < 500);
    S.fx.forEach(f => {
      const p = (now - f.t) / 500;
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = f.color; ctx.lineWidth = 2;
      const s = NOTE * (1 + p * 0.6);
      strokeShape(ctx, f.x, f.y, s);
      if (f.text) {
        ctx.fillStyle = f.color; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(f.text, f.x, f.y - NOTE * 0.8 - p * 14);
      }
      ctx.globalAlpha = 1;
    });
  };

  // Start the song when the lead-in ends, continue it when the resume countdown ends (frame-driven,
  // so a pause simply stops both)
  const drive = () => {
    if (S.paused) return;
    const now = performance.now();
    // lastAudioT = -1 re-anchors songTime()'s interpolation to the real audio time; a stale anchor from
    // before a pause made the clock jump ahead by the paused duration (every note missed)
    if (S.leadUntil && now >= S.leadUntil) { S.leadUntil = 0; S.lastAudioT = -1; S.audio.play().catch(() => {}); }
    if (S.resumeUntil && now >= S.resumeUntil) { S.resumeUntil = 0; S.lastAudioT = -1; S.audio.play().catch(() => {}); }
  };

  // Esc (or leaving the window) pauses: song, notes, metronome and countdown freeze, hits are ignored.
  // Esc again / Resume continues after a short get-ready countdown.
  const RESUME_MS = 1000;
  // byUser (Esc, the pause button): the tuner opens next to the menu. Pauses from leaving the window don't.
  const pause = (byUser) => {
    if (!S || S.paused || S.finished) return;
    S.paused = true;
    if (S.leadUntil) S.leadRemaining = Math.max(0, S.leadUntil - performance.now());
    S.resumeUntil = 0;
    try { S.audio.pause(); } catch (_) {}
    S.lastAudioT = -1;
    if (S.clearHeld) S.clearHeld();
    if (S.mode === 'record' && S.press && S.commitPress) S.commitPress(); // a hold running into the pause ends there
    const menu = el('div', 'sqc-pause');
    menu.appendChild(el('div', 'sqc-pause-title', 'Paused'));
    const btn = (label, fn, primary) => { const b = el('button', primary ? 'sqc-primary' : null, label); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); menu.appendChild(b); };
    btn('Resume (Esc)', resume, true);
    if (S.mode === 'play') {
      const map = S.map, returnTo = S.returnTo;
      btn('Retry', () => { const s = endSession(); try { s && s.audio.pause(); } catch (_) {} playMap(map, { returnTo }); });
      btn(map.playtest ? 'Back' : 'Exit', quitPlay);
    } else if (S.mode === 'edit') {
      btn('Playtest', () => editorPlaytest());
      if (S.ctx && S.ctx.draft) {
        btn('Done', () => exitEdit(true));
      } else {
        btn('Save & exit', () => saveEdit(true));
        btn('Exit without saving', exitEdit);
      }
    } else {
      // Recording: everything so far is a draft you can playtest, tweak, save or keep recording
      btn('Playtest', () => { const d = leaveRecording(); playtest(d, () => showDraft(d)); });
      btn('Edit & tweak', () => { const d = leaveRecording(); startEdit(draftAsMap(d), { draft: d }); });
      btn('Finish', finishRecord);
      btn('Discard', () => { if (S.notes.length && !confirm('Throw away this recording?')) return; const s = endSession(); try { s && s.audio.pause(); } catch (_) {} showMaps(); });
    }
    // Buttons must not count as hits
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    S.view.ov.appendChild(menu);
    S.view.ov.classList.add('sqc-is-paused');
    S.pauseMenu = menu;
    if (byUser === true) openSettings();
  };
  const resume = () => {
    if (!S || !S.paused) return;
    closeSettings();
    if (S.pauseMenu) { S.pauseMenu.remove(); S.pauseMenu = null; }
    S.view.ov.classList.remove('sqc-is-paused');
    S.paused = false;
    if (S.mode === 'edit') return; // the editor stays stopped; Space plays
    if (S.leadRemaining != null) { S.leadUntil = performance.now() + S.leadRemaining; S.leadRemaining = null; }
    else S.resumeUntil = performance.now() + RESUME_MS;
  };
  // Pausing (Esc / pause button) opens the sidebar's tuner, Square Clicker tab, raised above the game so it
  // can be used right there (changes apply at once), and scrolls to the setting changed last unless that is
  // already in view. Resume / Esc (and "Back to the game" on phones, where the sidebar covers the game)
  // close it again: previous sidebar tab back, sidebar hidden again if it was hidden.
  const SIDEBAR_SEL = '.global-sidebar-right, .item-sidebar-right, .index-sidebar-right';
  const openSettings = () => {
    if (!S || S.settings) return;
    if (!document.querySelector(SIDEBAR_SEL)) { flash('The settings sidebar is not available on this page', 'error'); return; }
    S.settings = { hidSidebar: document.body.classList.contains('sidebar-right-hidden'), prevTab: document.querySelector('.sidebar-tab.active') };
    document.body.classList.add('sqc-settings');
    if (S.settings.hidSidebar && window.toggleSidebarRight) window.toggleSidebarRight();
    const tab = document.querySelector('#sidebar-tab-tuner');
    if (tab && !tab.classList.contains('active')) tab.click();
    setTimeout(() => {
      const sub = document.querySelector('.f0ck-tuner-subtab-btn[data-subtab="sqc"]');
      if (sub && !sub.classList.contains('active')) sub.click();
      // after the tab switch (and its own "pane start into view" scroll) has settled
      setTimeout(jumpToLastSetting, 250);
    }, 60);
    const back = el('button', 'sqc-settings-back', 'Back to the game');
    back.type = 'button';
    back.addEventListener('click', () => closeSettings());
    document.body.appendChild(back);
    S.settings.back = back;
  };
  const jumpToLastSetting = () => {
    let key = null;
    try { key = localStorage.getItem(LAST_SETTING_KEY); } catch (_) {}
    const row = key && document.querySelector('#f0ck-tuner-pane-sqc [data-sqc-key="' + key + '"]');
    if (!row || !row.offsetParent) return;
    const sc = window._f0ckScrollerFor ? window._f0ckScrollerFor(row) : null;
    if (!sc) return;
    const rr = row.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    const pane = document.querySelector('#f0ck-tuner-pane-sqc');
    const header = pane && pane.parentElement && pane.parentElement.querySelector('.f0ck-tuner-header');
    const top = header && getComputedStyle(header).position === 'sticky' ? Math.max(sr.top, header.getBoundingClientRect().bottom) : sr.top;
    if (rr.top >= top && rr.bottom <= sr.bottom) return; // already in view: leave the scroll position alone
    sc.scrollBy({ top: rr.top - top - (sr.bottom - top) / 3, behavior: 'smooth' });
    row.classList.add('sqc-last-setting');
    setTimeout(() => row.classList.remove('sqc-last-setting'), 1500);
  };
  function closeSettings() {
    if (!S || !S.settings) return;
    const st = S.settings;
    S.settings = null;
    st.back.remove();
    document.body.classList.remove('sqc-settings');
    if (st.prevTab && st.prevTab.id !== 'sidebar-tab-tuner' && document.contains(st.prevTab)) st.prevTab.click();
    if (st.hidSidebar && !document.body.classList.contains('sidebar-right-hidden') && window.toggleSidebarRight) window.toggleSidebarRight();
  }

  // "Get ready" countdown after a resume
  const drawResume = (ctx) => {
    if (!S.resumeUntil) return;
    const left = Math.max(0, S.resumeUntil - performance.now());
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 22px monospace'; ctx.fillText('Get ready', innerWidth / 2, innerHeight / 2 - 44);
    ctx.font = 'bold 48px monospace'; ctx.fillText(String(Math.ceil(left / (RESUME_MS / 3))), innerWidth / 2, innerHeight / 2);
  };

  // Lead-in countdown (song time is negative until the song starts), one tick per count
  const drawCountdown = (ctx, t) => {
    drawResume(ctx);
    if (t >= 0 || S.paused) return;
    const count = Math.ceil(-t / 500);
    if (count !== S.lastCount) { S.lastCount = count; if (+O.countdownTicks) Sfx.play('count'); }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 48px monospace';
    ctx.fillText(String(count), innerWidth / 2, innerHeight / 2);
  };

  const drawBar = (ctx, label, right) => {
    const W = innerWidth;
    const t = songTime();
    const dur = (S.audio.duration || 0) * 1000;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, 34);
    if (dur > 0) { ctx.fillStyle = accent(); ctx.fillRect(0, 32, W * Math.min(1, Math.max(0, t / dur)), 2); }
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px monospace'; ctx.textBaseline = 'middle';
    ctx.textAlign = 'left'; ctx.fillText(label, 12, 17);
    ctx.textAlign = 'right'; ctx.fillText(right, W - 12, 17);
    // BPM + a square that flashes on every beat (stronger on the bar's first beat)
    if (S.tempo) {
      const { bpm, periodMs, phaseMs } = S.tempo;
      const rel = (t - phaseMs) / periodMs;
      const frac = rel - Math.floor(rel);
      const bpb = Math.max(1, Math.round(+O.beatsPerBar || 4));
      const down = ((Math.floor(rel) % bpb) + bpb) % bpb === 0;
      const x = W / 2;
      ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.fillText(Math.round(bpm * 10) / 10 + ' BPM', x - 10, 17);
      ctx.globalAlpha = t >= 0 ? Math.max(0.15, 1 - frac * 1.6) : 0.15;
      ctx.fillStyle = down ? accent() : '#fff';
      ctx.fillRect(x, 10, 14, 14);
      ctx.globalAlpha = 1;
    }
  };

  // ── record mode ─────────────────────────────────────────────────────────────
  // A recording is a draft: { itemId, title, notes, resumeAt, duration_ms }. Starting again with a draft
  // continues it (from resumeAt, a little before where it stopped); new notes are added to it.
  const startRecord = (draft) => {
    if (!loggedIn()) return;
    const d = draft && draft.notes ? draft : { itemId: getItemId(), subId: getSubId(), title: '', notes: [], resumeAt: 0 };
    const s = startSession('record', { notes: d.notes, press: null, itemId: d.itemId, subId: d.subId || null, title: d.title || '', leadUntil: performance.now() + LEAD_IN_MS });
    if (!s) return;
    if (d.resumeAt) { try { s.audio.currentTime = d.resumeAt / 1000; } catch (_) {} }
    const now = () => Math.max(0, Math.round(songTime()));
    // A new press while a hold is running (hold x, tap z) ends that hold right there and starts the next note
    const down = (x, y, id) => {
      if (!S || songTime() < 0) return; // nothing is recorded during the countdown
      if (S.press) commit();
      S.press = { t: now(), x, y, id, path: [[0, x, y]] };
      Sfx.play(300);
    };
    // Only the input that started the note ends it (id undefined: window blur, let go of everything)
    const up = (id) => {
      if (!S || !S.press || (id !== undefined && S.press.id !== id)) return;
      commit();
    };
    const commit = () => {
      const p = S.press;
      S.press = null;
      let d = now() - p.t;
      // Snap to the beat grid (tuner: snap recorded notes) when a tempo is known
      const snap = +O.snapRecord || 0;
      if (snap && S.tempo) {
        const stepMs = S.tempo.periodMs / snap;
        const onGrid = (ms) => S.tempo.phaseMs + Math.round((ms - S.tempo.phaseMs) / stepMs) * stepMs;
        const t0 = Math.max(0, Math.round(onGrid(p.t)));
        if (d >= HOLD_MIN_MS) d = Math.max(Math.round(stepMs), Math.round(onGrid(p.t + d)) - t0);
        p.t = t0;
      }
      const note = { t: p.t, x: p.x / innerWidth, y: p.y / innerHeight, d: d >= HOLD_MIN_MS ? d : 0 };
      // A hold that moved becomes a slider: its path is replayed in play mode
      if (note.d) {
        const moved = p.path.reduce((m, q) => Math.max(m, Math.hypot(q[1] - p.x, q[2] - p.y)), 0);
        if (moved >= SLIDER_MIN_MOVE) {
          let pts = p.path.filter(q => q[0] <= d);
          if (pts.length > SLIDER_MAX_POINTS) { const step = pts.length / SLIDER_MAX_POINTS; pts = Array.from({ length: SLIDER_MAX_POINTS }, (_, i) => pts[Math.floor(i * step)]); }
          note.p = pts.map(q => [Math.round(q[0]), +(q[1] / innerWidth).toFixed(4), +(q[2] / innerHeight).toFixed(4)]);
        }
      }
      S.notes.push(note);
      if (note.d) Sfx.play('hold');
      addFx(p.x, p.y, note.p ? 'SLIDE' : note.d ? 'HOLD' : +O.noteNumbers ? String(S.notes.length) : null, accent());
    };
    bindInputs(s, down, up, true);
    s.commitPress = commit;
    s.onEnded = () => finishRecord();
    s.audio.addEventListener('ended', s.onEnded);
    // Countdown first (like play mode), then the song starts at 0

    const frame = () => {
      if (!S || S.mode !== 'record') return;
      drive();
      const { ctx } = S.view;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.fillStyle = dim(S.audio); ctx.fillRect(0, 0, innerWidth, innerHeight);
      // recent notes stay visible a moment so you see your pattern
      const t = songTime();
      S.notes.forEach((n, i) => {
        const age = t - (n.t + n.d);
        if (age > 1200 || age < -60000) return;
        ctx.globalAlpha = Math.max(0, 1 - age / 1200) * 0.8;
        if (n.p) { drawTrack(ctx, n.p, accent(), ctx.globalAlpha * 0.6); ctx.globalAlpha = Math.max(0, 1 - age / 1200) * 0.8; }
        ctx.strokeStyle = accent(); ctx.lineWidth = 2;
        strokeShape(ctx, n.x * innerWidth, n.y * innerHeight, NOTE);
        if (+O.noteNumbers) {
          ctx.fillStyle = '#fff'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(i + 1), n.x * innerWidth, n.y * innerHeight);
        }
        ctx.globalAlpha = 1;
      });
      if (S.press) { // hold being recorded: sample the cursor path and draw the trace so far
        const pp = S.press.path;
        const last = pp[pp.length - 1];
        if (Math.hypot(S.mouse.x - last[1], S.mouse.y - last[2]) >= 4) pp.push([Math.max(0, Math.round(t - S.press.t)), S.mouse.x, S.mouse.y]);
        drawTrack(ctx, pp.map(q => [q[0], q[1] / innerWidth, q[2] / innerHeight]), accent(), 0.6);
      }
      drawFx(ctx);
      tickMetronome(t);
      drawBar(ctx, 'REC  ' + S.notes.length + ' notes', fmtTime(Math.max(0, t)) + '  Esc = pause');
      drawCountdown(ctx, t);
      S.raf = requestAnimationFrame(frame);
    };
    S.raf = requestAnimationFrame(frame);
  };

  // Leave the recording and keep what was recorded as a draft (a held note becomes a tap)
  const leaveRecording = () => {
    const s = S;
    if (s.press) { const p = s.press; s.press = null; s.notes.push({ t: p.t, x: p.x / innerWidth, y: p.y / innerHeight, d: 0 }); }
    const at = (s.audio.currentTime || 0) * 1000;
    const d = {
      itemId: s.itemId, subId: s.subId, title: s.title || '', notes: s.notes.slice().sort((a, z) => a.t - z.t),
      resumeAt: Math.max(0, Math.round(at - 2000)), duration_ms: Math.round((s.audio.duration || 0) * 1000),
    };
    endSession();
    try { s.audio.pause(); } catch (_) {}
    return d;
  };
  const draftAsMap = (d) => ({ id: null, title: d.title, notes: d.notes, item_id: d.itemId, duration_ms: d.duration_ms });

  // Play a draft (or edited notes) as a game: nothing is saved, `back` runs when it ends or is left
  const playtest = (d, back) => {
    if (!d.notes.length) { flash('No notes to playtest yet', 'error'); back(); return; }
    playMap({ id: null, playtest: true, title: 'Playtest · ' + (d.title || 'untitled'), itemId: d.itemId, notes: d.notes.map(n => Object.assign({}, n)) }, { returnTo: back });
  };

  const finishRecord = () => {
    if (!S || S.mode !== 'record') return;
    showDraft(leaveRecording());
  };

  // The draft hub: continue recording, playtest, tweak in the editor, save, discard
  const showDraft = (d) => {
    const body = openPanel('Your map (not saved yet)');
    const slides = d.notes.filter(n => n.p).length;
    body.appendChild(el('div', 'sqc-muted', d.notes.length
      ? d.notes.length + ' notes: ' + (d.notes.filter(n => n.d).length - slides) + ' holds, ' + slides + ' sliders.'
      : 'No notes recorded yet. Click along to the song while it plays.'));
    const input = el('input');
    input.placeholder = 'Map title';
    input.maxLength = 80;
    input.value = d.title || '';
    input.addEventListener('input', () => { d.title = input.value; });
    body.appendChild(input);
    const btn = (label, fn, primary, disabled) => { const b = el('button', primary ? 'sqc-primary' : null, label); b.disabled = !!disabled; b.addEventListener('click', fn); body.appendChild(b); return b; };
    btn('Continue recording (from ' + fmtTime(d.resumeAt || 0) + ')', () => startRecord(d));
    btn('Playtest', () => playtest(d, () => showDraft(d)), false, !d.notes.length);
    btn('Edit & tweak', () => startEdit(draftAsMap(d), { draft: d }), false, !d.notes.length);
    const save = btn('Save map', async () => {
      save.disabled = true;
      const r = await api('/api/v2/sqc/maps', { method: 'POST', body: JSON.stringify({
        item_id: d.itemId, album_item_id: d.subId || null, title: d.title, notes: d.notes, duration_ms: d.duration_ms || 0,
      }) });
      if (r.success) { flash('Map saved'); showMaps(); } else { save.disabled = false; flash(r.msg || 'Could not save', 'error'); }
    }, true, !d.notes.length);
    btn('Discard', () => { if (d.notes.length && !confirm('Throw away this map?')) return; showMaps(); });
    setTimeout(() => input.focus(), 0);
  };

  // ── editor ──────────────────────────────────────────────────────────────────
  // Your own maps (any map for staff): a timeline along the bottom (every note a tick, click / drag to
  // seek), notes around the playhead on the page. Space play / pause; ← → seek 1 s (Shift 5 s); , . one
  // beat. Click a note to select and drag it (sliders move whole); click empty space to add a note at
  // the playhead; Del removes; [ ] nudge -/+10 ms (Shift 50); S snaps to the beat. Esc: menu.
  const TIMELINE_H = 46;
  const EDIT_BEFORE = 900, EDIT_AFTER = 1600; // notes shown around the playhead (ms)

  // source: a saved map's id, or a map object ({ id|null, title, notes, item_id, duration_ms, dirty? }):
  // a draft from recording, or the editor's own state coming back from a playtest.
  // ctx.draft: editing a recording draft (Done goes back to the draft hub instead of saving).
  const startEdit = async (source, ctx = {}) => {
    let map = source;
    if (typeof source !== 'object') {
      const data = await api('/api/v2/sqc/maps/' + source);
      if (!data || !data.success) { flash((data && data.msg) || 'Map not found', 'error'); return; }
      map = data.map;
    }
    const raw = typeof map.notes === 'string' ? JSON.parse(map.notes) : map.notes;
    const notes = raw.map(n => ({ t: n.t, x: n.x, y: n.y, d: n.d || 0, p: n.p ? n.p.map(q => q.slice()) : undefined }));
    const s = startSession('edit', { map, notes, sel: -1, drag: null, dirty: !!map.dirty, lastPlayT: 0, ctx });
    if (!s) return;
    if (map.editAt) { try { s.audio.currentTime = map.editAt / 1000; } catch (_) {} }
    s.onEnded = () => {};
    s.audio.addEventListener('ended', s.onEnded);

    // toolbar: title, play, save, exit (DOM so the title can be typed)
    const bar = el('div', 'sqc-edit-bar');
    const title = el('input');
    title.value = map.title || '';
    title.maxLength = 80;
    title.addEventListener('input', () => { s.dirty = true; });
    const info = el('span', 'sqc-edit-info');
    const b = (label, fn, primary) => { const x = el('button', primary ? 'sqc-primary' : null, label); x.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return x; };
    const playBtn = b('Play (Space)', () => togglePlay());
    bar.appendChild(title); bar.appendChild(playBtn); bar.appendChild(b('Playtest', () => editorPlaytest()));
    if (ctx.draft) bar.appendChild(b('Done', () => exitEdit(true), true));
    else { bar.appendChild(b('Save', () => saveEdit(false), true)); bar.appendChild(b('Exit', exitEdit)); }
    bar.appendChild(info);
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    s.view.ov.appendChild(bar);
    s.titleInput = title;

    const W = () => innerWidth, H = () => innerHeight;
    const dur = () => Math.max(1, (s.audio.duration || 0) * 1000 || (s.map.duration_ms || 0) || 1);
    const seek = (ms) => {
      const t = Math.max(0, Math.min(dur() - 50, ms));
      try { s.audio.currentTime = t / 1000; } catch (_) {}
      s.lastAudioT = -1; s.lastPlayT = t;
      s.metIdx = null;
    };
    const togglePlay = () => {
      if (s.audio.paused) { s.lastAudioT = -1; s.lastPlayT = songTime(); s.audio.play().catch(() => {}); }
      else { s.audio.pause(); s.lastAudioT = -1; }
    };
    const markDirty = () => { s.dirty = true; };
    const sortKeepSel = () => {
      const selNote = s.notes[s.sel];
      s.notes.sort((a, z) => a.t - z.t);
      s.sel = selNote ? s.notes.indexOf(selNote) : -1;
    };
    const visibleAt = (t) => s.notes.map((n, i) => ({ n, i })).filter(({ n }) => n.t + n.d >= t - EDIT_BEFORE && n.t <= t + EDIT_AFTER);
    const noteAt = (x, y, t) => {
      let best = null;
      visibleAt(t).forEach(({ n, i }) => {
        const px = n.x * W(), py = n.y * H();
        if (Math.abs(px - x) <= NOTE * 0.6 && Math.abs(py - y) <= NOTE * 0.6) {
          const dist = Math.abs(n.t - t);
          if (!best || dist < best.dist) best = { i, dist };
        }
      });
      return best ? best.i : -1;
    };
    const onGrid = (ms, div) => {
      if (!s.tempo) return ms;
      const step = s.tempo.periodMs / div;
      return Math.max(0, Math.round(s.tempo.phaseMs + Math.round((ms - s.tempo.phaseMs) / step) * step));
    };

    // pointer: timeline seek / select + drag / add
    s.view.ov.addEventListener('contextmenu', (e) => e.preventDefault());
    s.view.ov.addEventListener('pointerdown', (e) => {
      if (S !== s || s.paused || e.button !== 0) return;
      e.preventDefault();
      if (e.clientY >= H() - TIMELINE_H) { s.drag = { timeline: true }; seek(e.clientX / W() * dur()); return; }
      const t = songTime();
      const i = noteAt(e.clientX, e.clientY, t);
      if (i >= 0) {
        s.sel = i;
        const n = s.notes[i];
        s.drag = { i, x0: e.clientX, y0: e.clientY, nx: n.x, ny: n.y, p: n.p ? n.p.map(q => q.slice()) : null, moved: false };
      } else {
        let nt = Math.max(0, Math.round(t));
        if (+O.snapRecord && s.tempo) nt = onGrid(nt, +O.snapRecord);
        s.notes.push({ t: nt, x: +(e.clientX / W()).toFixed(4), y: +(e.clientY / H()).toFixed(4), d: 0 });
        s.sel = s.notes.length - 1;
        sortKeepSel(); markDirty();
        Sfx.play(300);
        addFx(e.clientX, e.clientY, 'NEW', accent());
      }
    });
    s.view.ov.addEventListener('pointermove', (e) => {
      if (!s.drag) return;
      if (s.drag.timeline) { seek(e.clientX / W() * dur()); return; }
      const n = s.notes[s.drag.i];
      if (!n) return;
      const dx = (e.clientX - s.drag.x0) / W(), dy = (e.clientY - s.drag.y0) / H();
      if (!s.drag.moved && Math.hypot(e.clientX - s.drag.x0, e.clientY - s.drag.y0) < 3) return;
      s.drag.moved = true;
      const c = (v) => +Math.max(0, Math.min(1, v)).toFixed(4);
      n.x = c(s.drag.nx + dx); n.y = c(s.drag.ny + dy);
      if (s.drag.p) n.p = s.drag.p.map(q => [q[0], c(q[1] + dx), c(q[2] + dy)]);
      markDirty();
    });
    window.addEventListener('pointerup', s.onUp = () => { if (s.drag) s.drag = null; });

    // keys (through the key guard; typing in the title field is left to the field)
    s.onKey = (e) => {
      if (S !== s) return;
      if (e.key === 'Escape') { e.preventDefault(); if (!e.repeat) (s.paused ? resume() : pause(true)); return; }
      if (s.paused || e.ctrlKey || e.altKey || e.metaKey || /^F\d{1,2}$/.test(e.key)) return;
      e.preventDefault();
      const t = songTime();
      const n = s.notes[s.sel];
      const big = e.shiftKey;
      switch (e.key) {
        case ' ': if (!e.repeat) togglePlay(); break;
        case 'ArrowLeft': seek(t - (big ? 5000 : 1000)); break;
        case 'ArrowRight': seek(t + (big ? 5000 : 1000)); break;
        case ',': if (s.tempo) seek(onGrid(t - s.tempo.periodMs, 1)); break;
        case '.': if (s.tempo) seek(onGrid(t + s.tempo.periodMs, 1)); break;
        case 'Delete': case 'Backspace':
          if (n) { s.notes.splice(s.sel, 1); s.sel = -1; markDirty(); }
          break;
        case '[': case '{': case ']': case '}':
          if (n) { n.t = Math.max(0, n.t + ((e.key === '[' || e.key === '{') ? -1 : 1) * (big ? 50 : 10)); sortKeepSel(); markDirty(); }
          break;
        case 's': case 'S':
          if (n && s.tempo) { n.t = onGrid(n.t, +O.snapRecord || 2); sortKeepSel(); markDirty(); }
          else if (n) flash('No BPM known yet (tuner: BPM)', 'error');
          break;
      }
    };
    s.onKeyUp = () => {};

    const frame = () => {
      if (!S || S !== s) return;
      const { ctx } = s.view;
      const t = Math.max(0, songTime());
      const Wd = W(), Hd = H();
      const col = accent();
      ctx.clearRect(0, 0, Wd, Hd);
      ctx.fillStyle = dim(s.audio); ctx.fillRect(0, 0, Wd, Hd);
      // hit sounds as the playhead passes notes
      if (!s.audio.paused) {
        s.notes.forEach(n => { if (n.t > s.lastPlayT && n.t <= t) Sfx.play(300); });
        tickMetronome(t);
      }
      s.lastPlayT = t;
      // notes around the playhead, later ones first so the next is on top
      const vis = visibleAt(t);
      for (let k = vis.length - 1; k >= 0; k--) {
        const { n, i } = vis[k];
        const px = n.x * Wd, py = n.y * Hd;
        const dt = n.t - t;
        ctx.globalAlpha = dt >= 0 ? Math.max(0.2, 1 - dt / EDIT_AFTER) : Math.max(0.2, 1 + (dt + n.d) / EDIT_BEFORE);
        if (n.p) drawTrack(ctx, n.p, col, 0.6 * ctx.globalAlpha);
        drawNoteBody(ctx, px, py, NOTE, col, i === s.sel ? 4 : 2);
        ctx.strokeStyle = col;
        if (i === s.sel) { ctx.lineWidth = 2; ctx.setLineDash([5, 4]); strokeShape(ctx, px, py, NOTE + 16); ctx.setLineDash([]); }
        ctx.fillStyle = '#fff'; ctx.font = 'bold 20px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), px, py);
        if (n.d && !n.p) { ctx.fillStyle = col; ctx.fillRect(px - NOTE / 2, py + NOTE / 2 + 6, NOTE, 6); }
        // approach frame for notes still to come
        if (dt > 0 && dt < APPROACH_MS) { const s2 = NOTE * (1 + 2.2 * dt / APPROACH_MS); ctx.lineWidth = 1; strokeShape(ctx, px, py, s2); }
        ctx.globalAlpha = 1;
      }
      // timeline: every note a tick, the selected one in the accent, the playhead in white
      const ty = Hd - TIMELINE_H;
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, ty, Wd, TIMELINE_H);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.strokeRect(0.5, ty + 0.5, Wd - 1, TIMELINE_H - 1);
      const D = dur();
      s.notes.forEach((n, i) => {
        const x = n.t / D * Wd;
        ctx.fillStyle = i === s.sel ? col : 'rgba(255,255,255,0.7)';
        ctx.fillRect(x, ty + 8, i === s.sel ? 3 : 1.5, TIMELINE_H - 16);
        if (n.d) { ctx.globalAlpha = 0.35; ctx.fillRect(x, ty + TIMELINE_H - 12, Math.max(1, n.d / D * Wd), 4); ctx.globalAlpha = 1; }
      });
      ctx.fillStyle = '#fff'; ctx.fillRect(t / D * Wd - 1, ty, 2, TIMELINE_H);
      drawFx(ctx);
      // info: time, notes, selection
      const n = s.notes[s.sel];
      info.textContent = fmtTime(t) + ' / ' + fmtTime(D) + ' · ' + s.notes.length + ' notes' + (s.tempo ? ' · ' + (Math.round(s.tempo.bpm * 10) / 10) + ' BPM' : '') +
        (n ? ' · #' + (s.sel + 1) + ' at ' + (n.t / 1000).toFixed(3) + 's ' + (n.p ? 'slider' : n.d ? 'hold' : 'tap') : '') + (s.dirty ? ' · unsaved' : '');
      playBtn.textContent = s.audio.paused ? 'Play (Space)' : 'Pause (Space)';
      S.raf = requestAnimationFrame(frame);
    };
    S.raf = requestAnimationFrame(frame);
  };

  const saveEdit = async (andExit) => {
    const s = S;
    if (!s || s.mode !== 'edit') return;
    if (!s.notes.length) { flash('A map needs at least one note', 'error'); return; }
    const r = await api('/api/v2/sqc/maps/' + s.map.id, { method: 'PUT', body: JSON.stringify({
      title: s.titleInput.value, notes: s.notes.map(n => { const o = { t: n.t, x: n.x, y: n.y, d: n.d || 0 }; if (n.p) o.p = n.p; return o; }),
    }) });
    if (!r.success) { flash(r.msg || 'Could not save', 'error'); return; }
    s.dirty = false;
    flash('Map saved' + (r.scores_cleared ? ' (' + r.scores_cleared + ' old scores cleared)' : ''));
    if (andExit) exitEdit(true);
  };
  // The editor's current state as a map object (to come back to it, or to hand to a draft)
  const editorSnapshot = (s) => ({
    id: s.map.id, title: s.titleInput.value, item_id: s.map.item_id, duration_ms: s.map.duration_ms, dirty: s.dirty,
    editAt: Math.round((s.audio.currentTime || 0) * 1000),
    notes: s.notes.slice().sort((a, z) => a.t - z.t).map(n => { const o = { t: n.t, x: n.x, y: n.y, d: n.d || 0 }; if (n.p) o.p = n.p.map(q => q.slice()); return o; }),
  });
  // Playtest what's in the editor right now, then come back to it (unsaved edits kept)
  const editorPlaytest = () => {
    const s = S;
    if (!s || s.mode !== 'edit') return;
    const w = editorSnapshot(s), ctx = s.ctx || {};
    window.removeEventListener('pointerup', s.onUp);
    endSession();
    try { s.audio.pause(); } catch (_) {}
    playtest({ title: w.title, itemId: w.item_id, notes: w.notes }, () => startEdit(w, ctx));
  };
  const exitEdit = (force) => {
    const s = S;
    if (!s || s.mode !== 'edit') return;
    const ctx = s.ctx || {};
    if (!ctx.draft && s.dirty && force !== true && !confirm('Leave the editor without saving your changes?')) return;
    const w = editorSnapshot(s);
    window.removeEventListener('pointerup', s.onUp);
    endSession();
    try { s.audio.pause(); } catch (_) {}
    if (ctx.draft) { // back to the recording draft, with the edits
      ctx.draft.notes = w.notes;
      ctx.draft.title = w.title;
      showDraft(ctx.draft);
      return;
    }
    showMaps();
  };

  // ── play mode ───────────────────────────────────────────────────────────────
  // A saved map from the server
  const startPlay = async (mapId) => {
    const data = await api('/api/v2/sqc/maps/' + mapId);
    if (!data || !data.success) { flash((data && data.msg) || 'Map not found', 'error'); return; }
    playMap(data.map);
  };

  // Play any map: { id (null for a generated auto map), title, notes }
  // Auto map settings changed while an auto map plays (tuner, e.g. via Settings in the pause menu): the
  // rest of the map is rebuilt with them and the game goes on. Notes up to a little ahead of now (what is
  // on screen, plus a margin) stay as they are; the new notes start after that. Score and combo carry on.
  const autoSig = () => JSON.stringify(Object.keys(O).filter(k => /^auto/.test(k)).map(k => [k, O[k]]));
  let regenTimer = null;
  const regenAuto = async () => {
    const s = S;
    if (!s || s.mode !== 'play' || !s.map.auto || s.finished) return;
    const sig = autoSig();
    if (sig === s.autoSig) return;
    s.autoSig = sig;
    let map;
    try { map = await Auto.build(s.audio, s.map.itemId, O.autoPreset, O.autoDifficulty); } catch (e) { flash('Could not rebuild the auto map', 'error'); return; }
    if (S !== s || s.finished || s.autoSig !== sig) return; // left, ended, or changed again meanwhile
    const from = Math.max(0, songTime()) + Math.max(APPROACH_MS, 1500);
    const keep = s.notes.filter(n => n.t < from);
    const fresh = toPlayNotes(map.notes.filter(n => n.t >= from));
    s.notes = keep.concat(fresh);
    s.notes.forEach((n, i) => { n.i = i; });
    map.subId = s.map.subId;
    s.map = map; // Retry and "Save as map" use the new map
    flash('Auto map updated: ' + map.title + ' (' + fresh.length + ' notes from ' + fmtTime(from) + ')');
  };
  window.addEventListener('f0ck:sqc_settings_changed', () => {
    if (!S || S.mode !== 'play' || !S.map.auto || autoSig() === S.autoSig) return;
    clearTimeout(regenTimer);
    regenTimer = setTimeout(regenAuto, 400); // sliders fire on every step: rebuild once they settle
  });

  // opts.returnTo: where to go when the game ends or is left (playtests go back to the draft / editor)
  // Map notes -> game notes (judging state, stacking, prepared sliders)
  const toPlayNotes = (raw) => {
    const notes = raw.map((n, i) => ({ t: n.t, x: n.x, y: n.y, d: n.d || 0, p: Array.isArray(n.p) && n.p.length > 1 ? n.p : null, i, state: 'pending', judge: 0, outSince: 0 }));
    stackNotes(notes);
    notes.forEach(prepSlider);
    return notes;
  };
  const playMap = (map, opts = {}) => {
    const notes = toPlayNotes(typeof map.notes === 'string' ? JSON.parse(map.notes) : map.notes);
    const s = startSession('play', {
      map, notes, next: 0, score: 0, combo: 0, maxCombo: 0, returnTo: opts.returnTo || null, autoSig: map.auto ? autoSig() : null,
      hits: { 300: 0, 100: 0, 50: 0, miss: 0 }, leadUntil: performance.now() + LEAD_IN_MS, finished: false,
    });
    if (!s) return;
    s.leadUntil = performance.now() + LEAD_IN_MS; // songTime() is negative until the song starts

    const pos = (n) => ({ x: n.x * innerWidth, y: n.y * innerHeight });
    // Where the ball of a hold/slider is at song time t (px); a plain hold stays on its note
    const ballPos = (n, t) => { const b = sliderAt(n, t - n.t); return { x: b.x * innerWidth, y: b.y * innerHeight }; };
    // Hold/slider broken (let go early or left the follow zone): counts as a miss (no points, combo
    // reset), but the note stays on screen until its end so you can keep following it for practice
    const breakHold = (n, t) => {
      S.holding = null;
      const b = ballPos(n, t);
      if (S.combo >= 5) Sfx.play('miss');
      S.hits.miss++;
      S.combo = 0;
      n.state = 'broken';
      n.judge = 0;
      addFx(b.x, b.y, '×', '#ff4d4d');
    };
    const judgeValue = (delta) => (delta <= WIN_300 ? 300 : delta <= WIN_100 ? 100 : 50);
    // opts.holdEnd: a completed hold (light second tick); opts.silent: caller plays its own sound
    const award = (n, value, x, y, opts = {}) => {
      n.state = value ? 'hit' : 'miss';
      n.judge = value;
      if (!opts.silent) {
        if (value) Sfx.play(opts.holdEnd ? 'hold' : value);
        else if (S.combo >= 5) Sfx.play('miss'); // combo break
      }
      if (value) {
        S.hits[value]++;
        S.combo++;
        S.maxCombo = Math.max(S.maxCombo, S.combo);
        S.score += Math.round(value * (1 + S.combo / 25));
        addFx(x, y, String(value), value === 300 ? accent() : value === 100 ? '#7ec8ff' : '#ffc857');
      } else {
        S.hits.miss++;
        S.combo = 0;
        addFx(x, y, '×', '#ff4d4d');
      }
    };

    const press = (x, y) => {
      if (!S || S.mode !== 'play') return;
      const t = songTime();
      // earliest unjudged note inside the hit window and under the pointer
      for (let k = S.next; k < S.notes.length; k++) {
        const n = S.notes[k];
        if (n.state !== 'pending') continue;
        if (n.t - t > WIN_50) break;
        const p = pos(n);
        if (Math.abs(p.x - x) > NOTE * 0.75 || Math.abs(p.y - y) > NOTE * 0.75) continue;
        const delta = Math.abs(t - n.t);
        if (delta > WIN_50) continue;
        if (n.d > 0) { n.state = 'holding'; n.judge = judgeValue(delta); S.holding = n; Sfx.play(n.judge); addFx(p.x, p.y, null, accent()); }
        else award(n, judgeValue(delta), p.x, p.y);
        return;
      }
    };
    const release = () => {
      if (!S || !S.holding) return;
      const n = S.holding;
      S.holding = null;
      const t = songTime();
      // let go too early: the hold breaks (50 and combo reset)
      if (t < n.t + n.d - HOLD_SLACK_MS) { breakHold(n, t); return; }
      const b = ballPos(n, t);
      award(n, n.judge, b.x, b.y, { holdEnd: true });
    };

    bindInputs(s, press, release);
    s.onEnded = () => finishPlay();
    s.audio.addEventListener('ended', s.onEnded);

    const frame = () => {
      if (!S || S.mode !== 'play') return;
      drive();
      const { ctx } = S.view;
      const t = songTime();
      const W = innerWidth, H = innerHeight;
      const col = accent();
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = dim(S.audio); ctx.fillRect(0, 0, W, H);

      // misses: pending notes whose window has passed; holds that ran to their end while held
      for (let k = S.next; k < S.notes.length; k++) {
        const n = S.notes[k];
        if (n.t - t > APPROACH_MS) break;
        const p = pos(n);
        if (n.state === 'pending' && t > n.t + WIN_50) award(n, 0, p.x, p.y);
        if (n.state === 'holding') {
          const b = ballPos(n, Math.min(t, n.t + n.d));
          if (t >= n.t + n.d) { S.holding = null; award(n, n.judge, b.x, b.y, { holdEnd: true }); continue; }
          // the cursor has to follow the ball (a plain hold: stay on the note)
          const outside = Math.abs(S.mouse.x - b.x) > FOLLOW || Math.abs(S.mouse.y - b.y) > FOLLOW;
          if (!outside || S.paused || S.resumeUntil) n.outSince = 0; // no follow checks while paused
          else if (!n.outSince) n.outSince = performance.now();
          else if (performance.now() - n.outSince > FOLLOW_GRACE_MS) breakHold(n, t);
        }
        if (n.state === 'broken') n.outSince = 0;
        if (n.state === 'broken' && t >= n.t + n.d) n.state = 'miss'; // already counted when it broke
      }
      const live = (st) => st === 'pending' || st === 'holding' || st === 'broken';
      while (S.next < S.notes.length && !live(S.notes[S.next].state)) S.next++;

      // draw upcoming notes, latest first so the next one is on top
      const visible = [];
      for (let k = S.next; k < S.notes.length; k++) {
        const n = S.notes[k];
        if (n.t - t > APPROACH_MS) break;
        if (live(n.state)) visible.push(n);
      }
      // slider tracks first, under every note, so a note lying on a track is never hidden by it
      for (let k = visible.length - 1; k >= 0; k--) {
        const n = visible[k];
        if (!n.p) continue;
        const a = 0.75 * Math.max(0, Math.min(1, (APPROACH_MS - (n.t - t)) / 200));
        drawTrack(ctx, n.sp || n.p, col, a);
        drawTurns(ctx, n, t - n.t, Math.min(1, a / 0.75));
      }
      ctx.globalAlpha = 1;
      for (let k = visible.length - 1; k >= 0; k--) {
        const n = visible[k];
        const p = pos(n);
        const until = n.t - t; // ms until hit time (negative: late / holding)
        const fadeIn = Math.min(1, (APPROACH_MS - until) / 200);
        ctx.globalAlpha = Math.max(0, fadeIn);
        const going = n.state === 'holding' || n.state === 'broken';
        if (going) ctx.globalAlpha = n.p ? 0.35 : n.state === 'broken' ? 0.5 : 1; // the ball takes over from the start square
        // body
        drawNoteBody(ctx, p.x, p.y, NOTE, col, 3);
        if (+O.noteNumbers) { // off by default (tuner: numbers on notes)
          ctx.fillStyle = '#fff'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(n.i + 1), p.x, p.y);
        }
        // holding: the ball (follows the path on sliders) and the follow zone the cursor must stay in
        // broken: faded and red, the zone still shows whether you'd be following (no points any more)
        if (going) {
          const broken = n.state === 'broken';
          const b = ballPos(n, t);
          const inside = Math.abs(S.mouse.x - b.x) <= FOLLOW && Math.abs(S.mouse.y - b.y) <= FOLLOW;
          ctx.globalAlpha = broken ? 0.5 : 1;
          ctx.fillStyle = broken ? '#ff4d4d' : col;
          fillShape(ctx, b.x, b.y, NOTE * 0.56);
          ctx.setLineDash([6, 5]);
          ctx.strokeStyle = (broken ? !inside : n.outSince) ? '#ff4d4d' : col; ctx.lineWidth = 2;
          strokeShape(ctx, b.x, b.y, FOLLOW * 2);
          ctx.setLineDash([]);
        }
        // plain hold notes: a bar under the note that fills while held
        if (n.d > 0 && !n.p) {
          const prog = going ? Math.min(1, Math.max(0, (t - n.t) / n.d)) : 0;
          ctx.strokeStyle = col; ctx.lineWidth = 1;
          ctx.strokeRect(p.x - NOTE / 2, p.y + NOTE / 2 + 6, NOTE, 8);
          ctx.fillStyle = col; ctx.fillRect(p.x - NOTE / 2, p.y + NOTE / 2 + 6, NOTE * prog, 8);
        }
        // approach frame closing in on the note
        if (until > 0) {
          const sc = 1 + 2.2 * (until / APPROACH_MS);
          const s2 = NOTE * sc;
          ctx.strokeStyle = col; ctx.lineWidth = 2;
          strokeShape(ctx, p.x, p.y, s2);
        }
        ctx.globalAlpha = 1;
      }

      drawFx(ctx);
      const acc = accuracy(S);
      tickMetronome(t);
      drawBar(ctx, S.map.title, S.score.toLocaleString() + '   ' + acc.toFixed(2) + '%');
      ctx.fillStyle = '#fff'; ctx.font = 'bold 28px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      if (S.combo > 1) ctx.fillText(S.combo + 'x', 16, H - 16);
      drawCountdown(ctx, t);

      // done once every note is judged and the last effects faded
      const last = S.notes[S.notes.length - 1];
      if (S.next >= S.notes.length && (!last || t > last.t + last.d + 800)) { finishPlay(); return; }
      S.raf = requestAnimationFrame(frame);
    };
    S.raf = requestAnimationFrame(frame);
  };

  const accuracy = (s) => {
    const judged = s.hits[300] + s.hits[100] + s.hits[50] + s.hits.miss;
    return judged ? ((s.hits[300] * 300 + s.hits[100] * 100 + s.hits[50] * 50) / (judged * 300)) * 100 : 100;
  };
  const grade = (s, acc) => {
    if (acc === 100) return 'SS';
    if (acc > 95 && !s.hits.miss) return 'S';
    if (acc > 90) return 'A';
    if (acc > 80) return 'B';
    if (acc > 70) return 'C';
    return 'D';
  };

  const quitPlay = () => {
    const s = endSession();
    if (s) try { s.audio.pause(); } catch (_) {}
    if (s && s.returnTo) s.returnTo(); else showMaps();
  };

  const finishPlay = async () => {
    if (!S || S.mode !== 'play' || S.finished) return;
    S.finished = true;
    // anything left unjudged (song ended early) counts as a miss
    S.notes.forEach(n => {
      if (n.state === 'pending' || n.state === 'holding') { S.hits.miss++; n.state = 'miss'; }
      else if (n.state === 'broken') n.state = 'miss'; // counted when it broke
    });
    const s = endSession();
    try { s.audio.pause(); } catch (_) {}
    const acc = accuracy(s);
    const body = openPanel('Results: ' + s.map.title);
    body.appendChild(el('div', 'sqc-grade', grade(s, acc)));
    body.appendChild(el('div', null, 'Score ' + s.score.toLocaleString() + ' · ' + acc.toFixed(2) + '% · max combo ' + s.maxCombo + 'x'));
    body.appendChild(el('div', 'sqc-muted', '300: ' + s.hits[300] + '   100: ' + s.hits[100] + '   50: ' + s.hits[50] + '   miss: ' + s.hits.miss));
    let top = [];
    if (s.map.playtest) {
      body.appendChild(el('div', 'sqc-muted', 'Playtest: nothing is saved.'));
      const again = el('button', 'sqc-primary', 'Playtest again');
      again.addEventListener('click', () => playMap(s.map, { returnTo: s.returnTo }));
      const back = el('button', null, 'Back');
      back.addEventListener('click', () => (s.returnTo ? s.returnTo() : showMaps()));
      body.appendChild(again);
      body.appendChild(back);
      return;
    }
    if (!s.map.id) {
      // Generated auto map: not on the server, so no scores; saving it makes it a normal map
      body.appendChild(el('div', 'sqc-muted', 'Auto maps have no leaderboard.' + (loggedIn() ? ' Save it as a map so others can play and compete on it.' : '')));
      if (loggedIn()) {
        const save = el('button', null, 'Save as map');
        save.addEventListener('click', async () => {
          save.disabled = true;
          const r = await api('/api/v2/sqc/maps', { method: 'POST', body: JSON.stringify({
            item_id: s.map.itemId, album_item_id: s.map.subId || null, title: s.map.title, notes: s.map.notes, duration_ms: s.map.duration_ms || 0,
          }) });
          if (r.success) { s.map.id = r.id; save.textContent = 'Saved'; flash('Map saved'); }
          else { save.disabled = false; flash(r.msg || 'Could not save', 'error'); }
        });
        body.appendChild(save);
      }
    } else if (loggedIn()) {
      const r = await api('/api/v2/sqc/maps/' + s.map.id + '/scores', { method: 'POST', body: JSON.stringify({
        score: s.score, max_combo: s.maxCombo, hits: s.hits,
      }) });
      if (!r.success) body.appendChild(el('div', 'sqc-muted', 'Score not saved: ' + (r.msg || 'error')));
    } else {
      body.appendChild(el('div', 'sqc-muted', 'Log in to save your score.'));
    }
    if (s.map.id) {
      const data = await api('/api/v2/sqc/maps/' + s.map.id);
      top = (data && data.scores) || [];
    }
    if (top.length) {
      const table = el('table');
      top.forEach((row, i) => {
        const tr = el('tr');
        tr.appendChild(el('td', null, '#' + (i + 1)));
        tr.appendChild(el('td', null, row.username || 'someone'));
        tr.appendChild(el('td', null, Number(row.score).toLocaleString()));
        tr.appendChild(el('td', null, Number(row.accuracy).toFixed(2) + '%'));
        table.appendChild(tr);
      });
      body.appendChild(table);
    }
    const retry = el('button', 'sqc-primary', 'Retry');
    retry.addEventListener('click', () => (s.map.id ? startPlay(s.map.id) : playMap(s.map)));
    const back = el('button', null, 'Back to maps');
    back.addEventListener('click', showMaps);
    body.appendChild(retry);
    body.appendChild(back);
  };

  // Hotkey o (f0ckm.js keybindings): toggle the panel on an audio / video item
  window.f0ckSqcOpen = () => {
    if (S) return;
    if (panel) { closePanel(); return; }
    if (!getAudio() && !albumHasMedia()) { flash('Square Clicker: open an audio or video post first', 'error'); return; }
    showMaps();
  };

  // ── lifecycle ───────────────────────────────────────────────────────────────
  // Navigating away (AJAX) ends a running session; the button is (re)added on audio/video items
  document.addEventListener('f0ck:contentLoaded', () => {
    if (S) { const s = endSession(); try { s && s.audio.pause(); } catch (_) {} }
    closePanel();
    setTimeout(injectButton, 50);
  });
  // Album entry switched: the open maps list is for the previous entry
  document.addEventListener('f0ck:albumChange', () => {
    injectButton();
    if (!S && panel && panelFor && panelFor !== getItemId() + ':' + getSubId()) showMaps();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
  else injectButton();
  setTimeout(injectButton, 800);
})();
