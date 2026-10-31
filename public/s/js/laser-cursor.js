/**
 * Laser cursor: the mouse pointer becomes a glowing laser dot with a smooth, tapering, fading trail.
 * - hover over something clickable: a ring opens around the dot
 * - press: the dot squeezes; release: a shockwave ring
 * - drag (button held while moving): the beam gets thicker and hotter
 * - text fields keep the native text cursor; leaving the window or an idle video player fades it out
 *
 * One transparent, pointer-events:none canvas over the page, drawn only while something moves
 * (the rAF loop stops when the trail is gone and all animations have settled).
 * Mouse/trackpad only; off for touch devices and prefers-reduced-motion.
 *
 * Everything is configurable (tuner "Laser" tab): window.f0ckLaser = { getState, set, setEnabled,
 * reset, defaults, schema }, settings in localStorage 'f0ck_laser_settings', 'f0ck:laser_changed' event.
 */
(() => {
  const STORE_KEY = 'f0ck_laser_settings';
  const LEGACY_KEY = 'f0ck_laser_cursor'; // old on/off switch

  const DEFAULTS = {
    enabled: 1,
    useAccent: 1,        // 1 = theme accent colour, 0 = custom colour below
    color: '#99ff00',
    hotCore: 1,          // white-hot centre on the beam and dot
    rainbow: 0,          // colour cycles along the trail
    rainbowSpeed: 90,    // degrees per second
    trailMs: 260,        // how long a trail point lives
    trailPoints: 64,     // max points kept (smoothness of long trails)
    beamWidth: 5,
    glowWidth: 16,
    glowStrength: 1,
    headSize: 3.2,
    headGlow: 22,
    hoverRing: 15,
    rippleSize: 36,
    rippleMs: 480,
    dragBoost: 0.7,
  };

  // Tuner rows (the tuner builds its UI from this)
  const SCHEMA = [
    { section: 'Colour' },
    { key: 'useAccent', label: 'Use theme accent colour', type: 'toggle' },
    { key: 'color', label: 'Custom colour', type: 'color' },
    { key: 'hotCore', label: 'White-hot core', type: 'toggle' },
    { key: 'rainbow', label: 'Rainbow beam', type: 'toggle' },
    { key: 'rainbowSpeed', label: 'Rainbow speed', type: 'range', min: 0, max: 720, step: 10, unit: '°/s' },
    { section: 'Trail' },
    { key: 'trailMs', label: 'Trail length', type: 'range', min: 0, max: 1500, step: 10, unit: 'ms' },
    { key: 'trailPoints', label: 'Trail smoothness', type: 'range', min: 8, max: 240, step: 1, unit: ' pts' },
    { key: 'beamWidth', label: 'Beam width', type: 'range', min: 0.5, max: 16, step: 0.5, unit: 'px' },
    { key: 'glowWidth', label: 'Glow width', type: 'range', min: 0, max: 60, step: 1, unit: 'px' },
    { key: 'glowStrength', label: 'Glow strength', type: 'range', min: 0, max: 3, step: 0.05, unit: 'x' },
    { section: 'Dot' },
    { key: 'headSize', label: 'Dot size', type: 'range', min: 0, max: 12, step: 0.1, unit: 'px' },
    { key: 'headGlow', label: 'Dot glow radius', type: 'range', min: 0, max: 80, step: 1, unit: 'px' },
    { key: 'hoverRing', label: 'Hover ring size', type: 'range', min: 0, max: 50, step: 1, unit: 'px' },
    { section: 'Click & drag' },
    { key: 'rippleSize', label: 'Shockwave size', type: 'range', min: 0, max: 160, step: 1, unit: 'px' },
    { key: 'rippleMs', label: 'Shockwave duration', type: 'range', min: 100, max: 2000, step: 10, unit: 'ms' },
    { key: 'dragBoost', label: 'Drag boost', type: 'range', min: 0, max: 3, step: 0.05, unit: 'x' },
  ];

  const CLICKABLE = 'a[href], button, [role="button"], label, select, summary, [onclick], .iconset, .thumb, ' +
    '.album-thumb-item, .rating-tag.can-cycle, .tag-btn, input[type="range"], input[type="checkbox"], ' +
    'input[type="radio"], input[type="button"], input[type="submit"], .v0ck_player_button';
  const TEXT_FIELD = 'textarea, [contenteditable=""], [contenteditable="true"], ' +
    'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="color"]):not([type="file"])';

  const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  const supported = () => mq('(hover: hover) and (pointer: fine)') && !mq('(prefers-reduced-motion: reduce)');

  // ── Settings ────────────────────────────────────────────────────────────────
  const S = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') Object.keys(DEFAULTS).forEach(k => { if (saved[k] !== undefined) S[k] = saved[k]; });
    else if (localStorage.getItem(LEGACY_KEY) === 'false') S.enabled = 0;
  } catch (_) {}
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (_) {} };
  const coerce = (key, val) => {
    if (typeof DEFAULTS[key] === 'string') return String(val);
    const n = Number(val);
    return isNaN(n) ? DEFAULTS[key] : n;
  };

  // ── State ───────────────────────────────────────────────────────────────────
  let canvas = null, ctx = null, W = 0, H = 0;
  let active = false, rafId = 0;
  const pts = [];              // trail points {x, y, t}
  const ripples = [];          // {x, y, t}
  let headX = -100, headY = -100, hasPos = false;
  let visible = 0, visibleTarget = 0;   // fade (window leave, text fields, idle player)
  let ring = 0, ringTarget = 0;         // hover ring radius
  let squeeze = 1, squeezeTarget = 1;   // press squeeze
  let heat = 0, heatTarget = 0;         // drag intensity (0..1)
  let down = false, downX = 0, downY = 0;
  let lastTarget = null;
  let hovering = false;                 // last hover classification said "clickable"
  let accentRgb = [153, 255, 0];
  let customRgb = [153, 255, 0];
  let lastColorCheck = 0;

  const cssColorToRgb = (raw) => {
    if (!document.body) return null;
    const probe = document.createElement('span');
    probe.style.color = raw;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
    probe.remove();
    return (m && m.length >= 3) ? [+m[0], +m[1], +m[2]] : null;
  };
  const readColors = () => {
    const raw = getComputedStyle(document.body || document.documentElement).getPropertyValue('--accent').trim() || '#9f0';
    accentRgb = cssColorToRgb(raw) || accentRgb;
    customRgb = cssColorToRgb(S.color) || customRgb;
  };

  // Colour at a position along the trail (0 = tail .. 1 = head)
  const colAt = (a, pos, now) => {
    if (S.rainbow) {
      const hue = ((now / 1000) * S.rainbowSpeed + (1 - pos) * 140) % 360;
      return 'hsla(' + hue.toFixed(1) + ',100%,60%,' + a.toFixed(3) + ')';
    }
    const c = S.useAccent ? accentRgb : customRgb;
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(3) + ')';
  };
  const core = (a, pos, now) => S.hotCore ? 'rgba(255,255,255,' + a.toFixed(3) + ')' : colAt(a, pos, now);

  const resize = () => {
    if (!canvas) return;
    // 1.5x is plenty for a soft glow and keeps the backing store small (Firefox composites it every frame)
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    prevBox = null;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    kick();
  };

  // Native cursor: hidden everywhere by CSS (html.laser-cursor-on, see f0ckm.css), so it can never
  // show, not even for a frame. To still know which cursor an element WOULD show, the element and its
  // ancestors are briefly marked [data-laser-probe] (the hiding rule skips marked elements), the
  // computed cursor is read and the marks are removed, all synchronously, so nothing is ever painted.
  // The laser then draws its own version of that cursor (cursorKind).
  let nativeOnly = false; // fullscreen on a bare <video>/<iframe>: the laser can't be drawn there
  let cursorKind = 'default', kindSince = 0;
  const KIND = {
    // 'none' counts as default: an idle player hides its cursor, but our pointermove runs before the
    // player's mousemove marks it hovered; hiding over the player is decided per frame in classify()
    auto: 'default', default: 'default', none: 'default', pointer: 'pointer',
    text: 'text', 'vertical-text': 'text',
    grab: 'grab', grabbing: 'grabbing', move: 'move', 'all-scroll': 'move',
    'not-allowed': 'no', 'no-drop': 'no',
    wait: 'wait', progress: 'wait',
    'zoom-in': 'zoomin', 'zoom-out': 'zoomout', help: 'help', crosshair: 'cross', cell: 'cross',
    'ew-resize': 'rh', 'e-resize': 'rh', 'w-resize': 'rh', 'col-resize': 'rh',
    'ns-resize': 'rv', 'n-resize': 'rv', 's-resize': 'rv', 'row-resize': 'rv',
    'nwse-resize': 'rd1', 'nw-resize': 'rd1', 'se-resize': 'rd1',
    'nesw-resize': 'rd2', 'ne-resize': 'rd2', 'sw-resize': 'rd2',
  };
  const PROBE = 'data-laser-probe';
  const readCursor = (el) => {
    const chain = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) { e.setAttribute(PROBE, ''); chain.push(e); }
    let c = 'auto';
    try { c = getComputedStyle(el).cursor; } catch (_) {}
    for (const e of chain) e.removeAttribute(PROBE);
    return c;
  };
  // Probing forces a style recalc (costly in Firefox), so each element's kind is cached for a second;
  // clicks and content loads clear the cache (classes that change the cursor usually come with those)
  let kindCache = new WeakMap();
  const KIND_TTL = 1000;
  const takeOverCursor = (el, fresh = false) => {
    if (!el || el.nodeType !== 1) return;
    const now = performance.now();
    const hit = !fresh && kindCache.get(el);
    let kind;
    if (hit && now - hit.t < KIND_TTL) {
      kind = hit.kind;
    } else {
      // Computed value may be "url(...), pointer": the keyword fallback is the last entry
      const raw = readCursor(el).split(',').pop().trim();
      kind = KIND[raw] || 'default';
      if (kind === 'default' && el.closest(TEXT_FIELD)) kind = 'text';
      kindCache.set(el, { kind, t: now });
    }
    if (kind !== cursorKind) { cursorKind = kind; kindSince = now; }
  };
  // Hover state from the element under the pointer: clickable -> ring, text field / idle player -> hide
  // The player goes idle (hides its controls and cursor) on a timer while the mouse rests, when no laser
  // frames run: re-check every 400ms, only while the pointer is over a player
  let playerWatch = 0;
  const watchPlayer = (on) => {
    if (on && !playerWatch) {
      playerWatch = setInterval(() => { if (lastTarget && lastTarget.isConnected) { classify(lastTarget); kick(); } }, 400);
    } else if (!on && playerWatch) {
      clearInterval(playerWatch);
      playerWatch = 0;
    }
  };
  const classify = (el) => {
    if (!el || !el.closest) { hovering = false; ringTarget = 0; watchPlayer(false); return; }
    watchPlayer(active && !!el.closest('.v0ck'));
    const idlePlayer = !!el.closest('.v0ck:not(.v0ck_hover)');
    visibleTarget = idlePlayer ? 0 : 1;
    // Ring for clickables; not when the laser shows a different cursor shape there
    const shaped = cursorKind !== 'default' && cursorKind !== 'pointer';
    hovering = !shaped && (cursorKind === 'pointer' || !!el.closest(CLICKABLE));
    ringTarget = hovering ? S.hoverRing : 0;
  };

  const onMove = (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const now = performance.now();
    const evs = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    // Firefox delivers many coalesced points: keep one per ~2px, more gives no visible smoothness
    if (S.trailMs > 0) {
      for (const c of evs) {
        const last = pts[pts.length - 1];
        if (last && Math.abs(last.x - c.clientX) < 2 && Math.abs(last.y - c.clientY) < 2) { last.t = now; continue; }
        pts.push({ x: c.clientX, y: c.clientY, t: now });
      }
    }
    if (pts.length > S.trailPoints) pts.splice(0, pts.length - S.trailPoints);
    headX = e.clientX; headY = e.clientY;
    if (!hasPos) { hasPos = true; visible = 0; }
    if (e.target !== lastTarget) { lastTarget = e.target; takeOverCursor(e.target); classify(e.target); }
    if (down && Math.hypot(headX - downX, headY - downY) > 4) heatTarget = 1;
    kick();
  };

  const onDown = (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    down = true; downX = e.clientX; downY = e.clientY;
    squeezeTarget = 0.55;
    kick();
  };

  const onUp = (e) => {
    if (!down) return;
    down = false;
    squeezeTarget = 1;
    heatTarget = 0;
    if (visibleTarget > 0 && S.rippleSize > 0 && e && e.clientX !== undefined) {
      ripples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    }
    // A click often swaps the content under a mouse that doesn't move (AJAX navigation, modals):
    // re-read what is under the laser a moment later
    setTimeout(reprobe, 120);
    kick();
  };

  // Re-read the element under the laser without a mouse move (content changed underneath it)
  const reprobe = () => {
    if (!active || !hasPos) return;
    const el = document.elementFromPoint(headX, headY);
    if (!el) return;
    kindCache = new WeakMap();
    lastTarget = el;
    takeOverCursor(el, true);
    classify(el);
    kick();
  };

  const onLeave = (e) => { if (!e.relatedTarget) { visibleTarget = 0; kick(); } };
  const onEnter = () => { visibleTarget = 1; if (lastTarget) classify(lastTarget); kick(); };

  // Tapered, smoothed trail: segments between midpoints (quadratic through each point), each a bit
  // thinner and more transparent toward the tail end. Wide soft pass first, core on top.
  const drawTrail = (now) => {
    while (pts.length && now - pts[0].t > S.trailMs) pts.shift();
    const n = pts.length;
    if (n < 2 || S.trailMs <= 0) return;
    const widthMul = 1 + heat * S.dragBoost;
    const glowA = 0.22 * S.glowStrength * (0.8 + heat * 0.4);
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 0 && (S.glowWidth <= 0 || S.glowStrength <= 0)) continue;
      for (let i = 1; i < n; i++) {
        const p0 = pts[i - 1], p1 = pts[i];
        const age = (now - p1.t) / S.trailMs;            // 0 = fresh .. 1 = gone
        const pos = i / (n - 1);                          // 0 = tail .. 1 = head
        const k = Math.max(0, Math.min(pos, 1 - age));
        if (k <= 0.01) continue;
        const prev = i > 1 ? pts[i - 2] : p0;
        ctx.beginPath();
        ctx.moveTo((prev.x + p0.x) / 2, (prev.y + p0.y) / 2);
        ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
        if (pass === 0) {
          ctx.strokeStyle = colAt(Math.min(1, glowA * k * visible), pos, now);
          ctx.lineWidth = S.glowWidth * widthMul * (0.25 + 0.75 * k);
        } else {
          ctx.strokeStyle = (k > 0.6) ? core(0.9 * k * visible, pos, now) : colAt(0.95 * k * visible, pos, now);
          ctx.lineWidth = S.beamWidth * widthMul * (0.15 + 0.85 * k);
        }
        ctx.stroke();
      }
      // Close the last gap up to the actual pointer position
      const last = pts[n - 1];
      ctx.beginPath();
      ctx.moveTo((pts[n - 2].x + last.x) / 2, (pts[n - 2].y + last.y) / 2);
      ctx.lineTo(last.x, last.y);
      ctx.strokeStyle = pass === 0 ? colAt(Math.min(1, glowA * visible), 1, now) : core(0.9 * visible, 1, now);
      ctx.lineWidth = pass === 0 ? S.glowWidth * widthMul : S.beamWidth * widthMul;
      ctx.stroke();
    }
  };

  const drawHead = (now) => {
    if (!hasPos || visible < 0.01) return;
    const s = squeeze * (1 + heat * 0.25 * S.dragBoost);
    if (S.headGlow > 0 && S.glowStrength > 0) {
      const gr = S.headGlow * s;
      const g = ctx.createRadialGradient(headX, headY, 0, headX, headY, gr);
      g.addColorStop(0, colAt(Math.min(1, 0.55 * S.glowStrength * visible), 1, now));
      g.addColorStop(0.35, colAt(Math.min(1, 0.22 * S.glowStrength * visible), 1, now));
      g.addColorStop(1, colAt(0, 1, now));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(headX, headY, gr, 0, Math.PI * 2); ctx.fill();
    }
    drawGlyph(now);
    // The dot only stays with shapes that have room around it; the others carry detail in the centre
    const dotKinds = { default: 1, pointer: 1, grab: 1, grabbing: 1, wait: 1, none: 1 };
    if (S.headSize > 0 && dotKinds[cursorKind]) {
      ctx.fillStyle = core(visible, 1, now);
      ctx.beginPath(); ctx.arc(headX, headY, S.headSize * s, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(headX, headY, S.headSize * 1.45 * s, 0, Math.PI * 2);
      ctx.lineWidth = 1.5; ctx.strokeStyle = colAt(0.9 * visible, 1, now); ctx.stroke();
    }
    if (ring > 0.5 && S.hoverRing > 0) {
      const ra = visible * Math.min(1, ring / S.hoverRing);
      ctx.beginPath(); ctx.arc(headX, headY, ring * (0.8 + 0.2 * squeeze), 0, Math.PI * 2);
      ctx.lineWidth = 1.5; ctx.strokeStyle = colAt(0.85 * ra, 1, now); ctx.stroke();
      ctx.lineWidth = 6; ctx.strokeStyle = colAt(0.12 * ra * S.glowStrength, 1, now); ctx.stroke();
    }
  };

  // Laser versions of the native cursors. Each shape is stroked twice: a wide faint glow and a thin core.
  const drawGlyph = (now) => {
    const kind = (cursorKind === 'grab' && down) ? 'grabbing' : cursorKind;
    if (kind === 'default' || kind === 'pointer' || kind === 'none') return;
    const a = visible * Math.min(1, (now - kindSince) / 140);
    if (a < 0.01) return;
    const x = headX, y = headY;
    const L = (x1, y1, x2, y2) => { ctx.moveTo(x + x1, y + y1); ctx.lineTo(x + x2, y + y2); };
    const C = (r, a0 = 0, a1 = Math.PI * 2) => { ctx.moveTo(x + r * Math.cos(a0), y + r * Math.sin(a0)); ctx.arc(x, y, r, a0, a1); };
    const arrow = (dx, dy, len) => { // double-headed arrow along (dx, dy)
      const hx = dx * len, hy = dy * len, px = -dy * 4, py = dx * 4, bx = dx * 4, by = dy * 4;
      L(-hx, -hy, hx, hy);
      L(hx, hy, hx - bx + px, hy - by + py); L(hx, hy, hx - bx - px, hy - by - py);
      L(-hx, -hy, -hx + bx + px, -hy + by + py); L(-hx, -hy, -hx + bx - px, -hy + by - py);
    };
    const shape = () => {
      ctx.beginPath();
      switch (kind) {
        case 'text': L(0, -10, 0, 10); L(-4, -10, 4, -10); L(-4, 10, 4, 10); break;
        case 'grab': C(10); break;
        case 'grabbing': C(6); break;
        case 'move': arrow(1, 0, 10); arrow(0, 1, 10); break;
        case 'rh': arrow(1, 0, 11); break;
        case 'rv': arrow(0, 1, 11); break;
        case 'rd1': arrow(0.7071, 0.7071, 11); break;
        case 'rd2': arrow(0.7071, -0.7071, 11); break;
        case 'no': C(9); L(-6.4, 6.4, 6.4, -6.4); break;
        case 'wait': { const t = now / 160; C(9, t, t + Math.PI * 1.4); break; }
        case 'zoomin': C(9); L(-4, 0, 4, 0); L(0, -4, 0, 4); break;
        case 'zoomout': C(9); L(-4, 0, 4, 0); break;
        case 'help': C(9); break;
        case 'cross': L(-11, 0, -3, 0); L(3, 0, 11, 0); L(0, -11, 0, -3); L(0, 3, 0, 11); break;
      }
    };
    ctx.setLineDash(kind === 'grab' ? [3, 3] : []);
    shape();
    ctx.lineWidth = 6; ctx.strokeStyle = colAt(Math.min(1, 0.15 * a * S.glowStrength), 1, now); ctx.stroke();
    ctx.lineWidth = 1.8; ctx.strokeStyle = core(0.95 * a, 1, now); ctx.stroke();
    ctx.setLineDash([]);
    if (kind === 'help') {
      ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = core(0.95 * a, 1, now); ctx.fillText('?', x, y + 0.5);
    }
  };

  const drawRipples = (now) => {
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      const p = (now - r.t) / S.rippleMs;
      if (p >= 1) { ripples.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - p, 3); // ease-out
      const a = (1 - p) * (1 - p);
      ctx.beginPath(); ctx.arc(r.x, r.y, 4 + e * S.rippleSize, 0, Math.PI * 2);
      ctx.lineWidth = 2 * (1 - p) + 0.5; ctx.strokeStyle = colAt(0.9 * a, 1, now); ctx.stroke();
      ctx.lineWidth = 10 * (1 - p); ctx.strokeStyle = colAt(Math.min(1, 0.15 * a * S.glowStrength), 1, now); ctx.stroke();
    }
  };

  const ease = (cur, target, k) => (Math.abs(target - cur) < 0.001 ? target : cur + (target - cur) * k);

  // Bounding box of everything this frame will draw (trail points, head + glow + ring + glyph, ripples),
  // padded by the widest stroke/glow. null when nothing is drawn.
  let prevBox = null;
  const drawBox = (now) => {
    while (pts.length && now - pts[0].t > S.trailMs) pts.shift();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y, r) => {
      if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r;
      if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r;
    };
    const boost = 1 + S.dragBoost;
    const trailPad = Math.max(S.glowWidth, S.beamWidth) * boost / 2 + 4;
    for (const p of pts) add(p.x, p.y, trailPad);
    if (hasPos && visible > 0.005) {
      add(headX, headY, Math.max(S.headGlow * boost * 1.1, S.hoverRing + 10, S.headSize * 2 * boost + 4, 24));
    }
    for (const r of ripples) add(r.x, r.y, S.rippleSize + 16);
    if (x0 === Infinity) return null;
    return { x0: Math.max(0, Math.floor(x0)), y0: Math.max(0, Math.floor(y0)), x1: Math.min(W, Math.ceil(x1)), y1: Math.min(H, Math.ceil(y1)) };
  };

  const frame = () => {
    rafId = 0;
    if (!active) return;
    const now = performance.now();
    if (now - lastColorCheck > 1500) { lastColorCheck = now; readColors(); }
    // Hover state can change without the pointer changing element (the video player adds/removes its
    // hover class after our pointermove): re-read it every frame (a few closest() calls)
    if (lastTarget && lastTarget.isConnected) classify(lastTarget);

    visible = ease(visible, visibleTarget, 0.18);
    ring = ease(ring, ringTarget, 0.22);
    squeeze = ease(squeeze, squeezeTarget, down ? 0.35 : 0.2);
    heat = ease(heat, heatTarget, 0.15);

    // Dirty rectangle: clear only what was drawn last frame plus what will be drawn now, instead of the
    // whole screen (the full-screen clear + composite is what made Firefox lag)
    const box = drawBox(now);
    const clr = prevBox && box ? {
      x0: Math.min(prevBox.x0, box.x0), y0: Math.min(prevBox.y0, box.y0),
      x1: Math.max(prevBox.x1, box.x1), y1: Math.max(prevBox.y1, box.y1),
    } : (prevBox || box);
    if (clr) ctx.clearRect(clr.x0, clr.y0, clr.x1 - clr.x0, clr.y1 - clr.y0);
    prevBox = box;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawTrail(now);
    drawRipples(now);
    drawHead(now);
    ctx.globalCompositeOperation = 'source-over';

    // Keep going while anything is still moving (a rainbow dot keeps cycling); otherwise stop until
    // the next input
    const settled = pts.length === 0 && ripples.length === 0 && !(S.rainbow && S.rainbowSpeed > 0 && visible > 0.01) &&
      !(cursorKind === 'wait' && visible > 0.01) && (now - kindSince > 160) &&
      visible === visibleTarget && ring === ringTarget && squeeze === squeezeTarget && heat === heatTarget;
    if (!settled) kick();
  };

  function kick() { if (active && !rafId) rafId = requestAnimationFrame(frame); }

  // Fullscreen: only the fullscreen element is painted, so the canvas moves into it. A bare
  // <video>/<iframe> can't hold it: then the native cursor comes back until fullscreen ends.
  const onFullscreen = () => {
    if (!canvas) return;
    const fs = document.fullscreenElement;
    const canHost = fs && !/^(VIDEO|IFRAME|IMG|CANVAS)$/.test(fs.tagName);
    (canHost ? fs : document.body).appendChild(canvas);
    nativeOnly = !!fs && !canHost;
    document.documentElement.classList.toggle('laser-cursor-on', !nativeOnly);
    resize();
  };

  const start = () => {
    if (active || !document.body) return;
    active = true;
    canvas = document.createElement('canvas');
    canvas.id = 'laser-cursor-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    ctx = canvas.getContext('2d');
    document.body.appendChild(canvas);
    document.documentElement.classList.add('laser-cursor-on');
    readColors();
    resize();
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('blur', onUp);
    document.addEventListener('mouseout', onLeave, { passive: true });
    document.addEventListener('mouseover', onEnter, { passive: true });
    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('f0ck:contentLoaded', reprobe);
  };

  const stop = () => {
    if (!active) return;
    active = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('blur', onUp);
    document.removeEventListener('mouseout', onLeave);
    document.removeEventListener('mouseover', onEnter);
    window.removeEventListener('resize', resize);
    document.removeEventListener('fullscreenchange', onFullscreen);
    document.removeEventListener('f0ck:contentLoaded', reprobe);
    document.documentElement.classList.remove('laser-cursor-on');
    lastTarget = null;
    watchPlayer(false);
    if (canvas) canvas.remove();
    canvas = null; ctx = null;
    pts.length = 0; ripples.length = 0; hasPos = false;
  };

  const apply = () => { if (S.enabled && supported()) start(); else stop(); };
  const changed = () => {
    save();
    readColors();
    if (hovering) ringTarget = S.hoverRing;
    apply();
    kick();
    window.dispatchEvent(new CustomEvent('f0ck:laser_changed', { detail: api.getState() }));
  };

  const api = {
    defaults: Object.assign({}, DEFAULTS),
    schema: SCHEMA,
    getState: () => Object.assign({}, S, { supported: supported(), active }),
    set: (key, val) => {
      if (!(key in DEFAULTS)) return;
      S[key] = coerce(key, val);
      changed();
    },
    setEnabled: (on) => { S.enabled = on ? 1 : 0; changed(); },
    reset: () => { Object.assign(S, DEFAULTS); changed(); },
  };
  window.f0ckLaser = api;
  window.toggleLaserCursor = (force) => {
    api.setEnabled(typeof force === 'boolean' ? force : !S.enabled);
    return active;
  };

  // Announce once ready, so a tuner built before this script loaded fills its Laser tab
  const init = () => { apply(); window.dispatchEvent(new CustomEvent('f0ck:laser_changed', { detail: api.getState() })); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
