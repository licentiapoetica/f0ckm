/**
 * danmaku.js — NicoNico/弾幕-style flying comments for v0ck
 *
 * Usage:
 *   const d = new Danmaku(playerEl, videoEl);
 *   d.load(commentsArray);          // feed comments from API
 *   d.fire('hello!', 'user', '#f0f'); // fire one immediately
 *   d.toggle();                     // toggle on/off
 *   d.destroy();                    // cleanup
 */
(function () {

const PILL_MIN_MS      = 6000;   // Fastest a pill can cross the screen
const PILL_MAX_MS      = 12000;  // Slowest a pill can cross the screen
const LANE_COUNT       = 10;     // Vertical lane slots
const LOOKAHEAD_SEC    = 0.25;   // How far ahead of currentTime we look when scanning
const MIN_RANDOM_SECS  = 2;      // Random timecode lower bound (avoid very start)
const RANDOM_SPREAD    = 0.85;   // Use 85% of duration for random spread

/**
 * SyntheticClock — emulates a <video> element's time API for non-video items
 * (Flash/Ruffle). Ticks at 4 Hz so Danmaku's timeupdate handler fires normally.
 */
class SyntheticClock {
    constructor() {
        this._currentTime = 0;
        this._paused = false;
        this._listeners = { timeupdate: [], seeked: [] };
        this._timer = this._startTimer();
    }
    _startTimer() {
        return setInterval(() => {
            if (this._paused) return;
            this._currentTime += 0.25;
            this._listeners.timeupdate.forEach(fn => fn());
        }, 250);
    }
    get currentTime() { return this._currentTime; }
    get duration()    { return Infinity; }
    get paused()      { return this._paused; }
    pause() {
        // For Flash/Ruffle: never pause the clock — let pills and time advance freely.
        // Ruffle's is_playing is unreliable and would stall danmaku if respected.
        this._paused = true;
    }
    resume() {
        this._paused = false;
    }
    addEventListener(type, fn, opts) {
        if (this._listeners[type]) this._listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
        if (this._listeners[type])
            this._listeners[type] = this._listeners[type].filter(f => f !== fn);
    }
    /** Reset the clock to zero (used for looping in Flash/Ruffle mode). */
    reset() {
        this._currentTime = 0;
        this._listeners.seeked.forEach(fn => fn());
    }
    destroy() { clearInterval(this._timer); }
}

class Danmaku {
    /**
     * @param {HTMLElement} playerEl  — the .v0ck wrapper element
     * @param {HTMLVideoElement|HTMLAudioElement} mediaEl — the <video> or <audio>
     */
    constructor(playerEl, mediaEl) {
        this.player      = playerEl;
        this.media       = mediaEl;
        this._synthClock = (mediaEl instanceof SyntheticClock) ? mediaEl : null;
        this.overlay     = null;
        this.items       = [];
        this._lastTime   = -1;
        this._paused     = false;
        this._laneUntil  = new Array(LANE_COUNT).fill(0);
        // Site-wide config default
        const configDefault = (window.f0ckSession && window.f0ckSession.enable_danmaku !== undefined)
            ? !!window.f0ckSession.enable_danmaku
            : true;

        // User preference
        const savedPref = localStorage.getItem('danmaku');

        if (savedPref !== null) {
            // User has explicitly chosen ON or OFF in the past
            this._enabled = savedPref !== 'false';
        } else {
            // No user preference yet — use the site-wide factory default
            this._enabled = configDefault;
        }
        this._bound_onTime  = this._onTimeUpdate.bind(this);
        this._bound_onSeek  = this._onSeeked.bind(this);
        this._bound_onPause = this._onPause.bind(this);
        this._bound_onPlay  = this._onPlay.bind(this);

        // Own emoji cache — populated via CommentSystem, event, or independent fetch
        this._emojiCache = {};
        this._initEmojiCache();

        this._createOverlay();
        this.media.addEventListener('timeupdate', this._bound_onTime,  { passive: true });
        this.media.addEventListener('seeked',     this._bound_onSeek,  { passive: true });
        this.media.addEventListener('pause',      this._bound_onPause, { passive: true });
        this.media.addEventListener('play',       this._bound_onPlay,  { passive: true });

        // For Ruffle/SyntheticClock: no poller needed — clock runs freely
    }

    /**
     * Initialise the emoji cache from whichever source resolves first:
     *   1. CommentSystem.emojiCache already populated (fast path — browser was already on a page)
     *   2. f0ck:emojis_ready event (CommentSystem finishes loading after us)
     *   3. Independent fetch (Ruffle/Flash items where CommentSystem may never fire the event)
     */
    _initEmojiCache() {
        // Fast path: CommentSystem already populated (AJAX nav / second page view)
        const tryCs = () => {
            const cs = (typeof CommentSystem !== 'undefined') ? CommentSystem.emojiCache : null;
            return (cs && Object.keys(cs).length > 0) ? cs : null;
        };

        const cs0 = tryCs();
        if (cs0) { this._emojiCache = cs0; return; }

        // Listen for CommentSystem's own event
        this._bound_onEmojis = (e) => {
            const map = e.detail || tryCs() || {};
            if (map && Object.keys(map).length > 0) {
                this._emojiCache = map;
                this._reRenderEmojis();
            }
        };
        window.addEventListener('f0ck:emojis_ready', this._bound_onEmojis);

        // Aggressive retry: try every 500 ms for up to 30 attempts.
        // Each attempt checks CommentSystem first (free), then falls back to a fetch.
        let attempts = 0;
        let fetched  = false;
        const retry = () => {
            if (this._emojiCache && Object.keys(this._emojiCache).length > 0) return; // already got them
            if (++attempts > 30) return;

            // 1. CommentSystem populated by now?
            const cs = tryCs();
            if (cs) {
                this._emojiCache = cs;
                this._reRenderEmojis();
                return;
            }

            // 2. Kick off the HTTP fetch once; then just wait for it / the event
            if (!fetched) {
                fetched = true;
                fetch('/api/v2/emojis')
                    .then(r => {
                        if (!r.ok) throw new Error(`emoji fetch ${r.status}`);
                        return r.json();
                    })
                    .then(data => {
                        if (!data.success || !Array.isArray(data.emojis)) return;
                        const map = {};
                        data.emojis.forEach(e => { map[e.name] = e.url; });
                        if (Object.keys(map).length > 0) {
                            this._emojiCache = map;
                            this._reRenderEmojis();
                        }
                    })
                    .catch(err => {
                        console.warn('[Danmaku] emoji fetch failed:', err.message);
                        fetched = false; // allow retry
                    });
            }

            // Schedule next check
            if (!this._destroyed) setTimeout(retry, 500);
        };
        setTimeout(retry, 200); // first attempt after a short grace window
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Load (or reload) comments. Comments with video_time=null get a random time.
     * @param {Array} comments — raw comment objects from /api/comments
     */
    load(comments) {
        if (!Array.isArray(comments) || comments.length === 0) return;

        const duration = this.media.duration;
        const hasDuration = isFinite(duration) && duration > 0;

        // Build the prepared item list
        const mapped = comments
            .filter(c => !c.is_deleted && c.content)
            .map(c => ({
                text:     this._prepareText(c.content),
                username: c.display_name || c.username || '?',
                color:    c.username_color || null,
                raw_time: (c.video_time != null) ? parseFloat(c.video_time) : null,
                fired:    false,
                video_time: 0
            }));

        if (this._synthClock) {
            // Flash/Ruffle mode: bypass the timeline entirely.
            // Store pool and start the random continuous loop.
            this._flashPool = mapped;
            this._startFlashLoop();
            return; // don't touch this.items / _lastTime
        }

        // Normal video mode: use video_time, random spread for nulls
        this.items = mapped.map(item => {
            if (item.raw_time !== null) {
                item.video_time = item.raw_time;
            } else if (hasDuration) {
                const spread = duration * RANDOM_SPREAD;
                item.video_time = MIN_RANDOM_SECS + Math.random() * Math.max(0, spread - MIN_RANDOM_SECS);
            } else {
                item.video_time = MIN_RANDOM_SECS + Math.random() * 598;
            }
            return item;
        }).sort((a, b) => a.video_time - b.video_time);

        this._resetFiredState(this.media.currentTime);
        this._lastTime = this.media.currentTime;
    }

    /**
     * Random continuous loop for Flash/Ruffle.
     * Fires one comment every 2-5 s (random), reshuffles pool on exhaustion.
     */
    _startFlashLoop() {
        // Cancel any previous loop
        if (this._flashTimer) clearTimeout(this._flashTimer);
        this._flashTimer = null;

        if (!this._flashPool || this._flashPool.length === 0) return;

        // Shuffle helper
        const shuffle = arr => {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
        };

        // Working queue — randomised copy of pool
        let queue = shuffle([...this._flashPool]);
        let idx = 0;

        const tick = () => {
            if (this._destroyed || !this._enabled) return;

            // Refill and reshuffle when queue exhausted
            if (idx >= queue.length) {
                queue = shuffle([...this._flashPool]);
                idx = 0;
            }

            const item = queue[idx++];
            this._spawnPill(item.text, item.username, item.color);

            // Random delay 2 – 5 seconds between pills
            const delay = 2000 + Math.random() * 3000;
            this._flashTimer = setTimeout(tick, delay);
        };

        // Small initial delay so page finishes loading before first pill
        this._flashTimer = setTimeout(tick, 800);
    }

    /**
     * Immediately fire a single comment pill (e.g. user's own new comment).
     */
    fire(text, username, color) {
        if (!this._enabled) return;
        this._spawnPill(this._prepareText(text), username, color);
    }

    /**
     * Add a new comment to the timeline so it loops back in future playback.
     * Also fires it immediately as a one-shot pill.
     * @param {Object} comment — raw comment object from API
     */
    addItem(comment) {
        if (!comment || !comment.content) return;

        const duration    = this.media.duration;
        const hasDuration = isFinite(duration) && duration > 0;

        let t = (comment.video_time != null) ? parseFloat(comment.video_time) : null;

        if (t === null) {
            const now = this.media.currentTime || 0;
            if (hasDuration) {
                const remaining = duration - now;
                const spread    = Math.max(remaining * 0.9, MIN_RANDOM_SECS);
                t = now + MIN_RANDOM_SECS + Math.random() * spread;
                if (t > duration) t = MIN_RANDOM_SECS + Math.random() * duration * RANDOM_SPREAD;
            } else {
                t = (this.media.currentTime || 0) + MIN_RANDOM_SECS + Math.random() * 300;
            }
        }

        const item = {
            video_time: t,
            text: this._prepareText(comment.content),
            username: comment.display_name || comment.username || '?',
            color: comment.username_color || null,
            fired: true   // mark as already fired — caller handles any immediate one-shot
        };

        // Insert in sorted order
        const idx = this.items.findIndex(i => i.video_time > t);
        if (idx === -1) this.items.push(item);
        else            this.items.splice(idx, 0, item);
    }

    /** Toggle danmaku on/off. */
    toggle() {
        this._enabled = !this._enabled;
        localStorage.setItem('danmaku', this._enabled ? 'true' : 'false');
        this.overlay.style.display = this._enabled ? '' : 'none';

        // Update the switch if it exists in the player
        const sw = this.player.querySelector('#toggledanmaku');
        if (sw) sw.classList.toggle('active', this._enabled);
    }

    setEnabled(val) {
        if (this._enabled === !!val) return;
        this.toggle();
    }

    isEnabled() { return this._enabled; }

    destroy() {
        this._destroyed = true;
        this.media.removeEventListener('timeupdate', this._bound_onTime);
        this.media.removeEventListener('seeked',     this._bound_onSeek);
        this.media.removeEventListener('pause',      this._bound_onPause);
        this.media.removeEventListener('play',       this._bound_onPlay);
        if (this._bound_onEmojis) window.removeEventListener('f0ck:emojis_ready', this._bound_onEmojis);
        if (this._rufflePoller) clearInterval(this._rufflePoller);
        if (this._flashTimer)   clearTimeout(this._flashTimer);
        if (this._synthClock) this._synthClock.destroy();
        if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
        this.overlay = null;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _createOverlay() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'danmaku-overlay';
        if (!this._enabled) this.overlay.style.display = 'none';
        this.player.appendChild(this.overlay);
    }

    _onPause() {
        this._paused = true;
        if (this._synthClock) this._synthClock.pause();
        // Do NOT pause pill animations — pills already in flight always complete.
    }

    _onPlay() {
        this._paused = false;
        if (this._synthClock) this._synthClock.resume();
        // Nothing to do for in-flight pills — they were never paused.
    }

    _checkRuffleState() {
        const rp = document.querySelector('ruffle-player, ruffle-object');
        if (!rp) return;
        // Ruffle exposes is_playing on the element
        const isPlaying = rp.is_playing !== undefined ? !!rp.is_playing : true;
        if (isPlaying && this._paused)  this._onPlay();
        if (!isPlaying && !this._paused) this._onPause();
    }

    _onTimeUpdate() {
        if (this._paused) return;
        const now = this.media.currentTime;
        if (!this._enabled || this.items.length === 0) { this._lastTime = now; return; }

        const prev = this._lastTime;
        this._lastTime = now;

        // Detect video loop (time jumped backwards) — reset so comments fire again
        if (now < prev - 0.5) {
            this._resetFiredState(now);
            return;
        }

        const from = prev;
        const to   = now + LOOKAHEAD_SEC;

        for (const item of this.items) {
            if (item.fired) continue;
            if (item.video_time < from) { item.fired = true; continue; } // already passed
            if (item.video_time > to) break; // sorted, nothing further in range
            item.fired = true;
            this._spawnPill(item.text, item.username, item.color);
        }

        // Loop for SyntheticClock (Flash/Ruffle): once all items have fired, restart
        if (this._synthClock && this.items.length > 0 && this.items.every(i => i.fired)) {
            this._loopSynth();
        }
    }

    /** Reset all fired flags and the synthetic clock for looping. */
    _loopSynth() {
        this.items.forEach(i => { i.fired = false; });
        this._synthClock.reset();     // back to t=0
        this._lastTime = 0;
    }

    _onSeeked() {
        this._resetFiredState(this.media.currentTime);
        this._lastTime = this.media.currentTime;
    }

    _resetFiredState(currentTime) {
        for (const item of this.items) {
            item.fired = item.video_time < currentTime - LOOKAHEAD_SEC;
        }
    }

    _pickLane() {
        const now = Date.now();
        // Find the lane that will be free soonest
        let best = 0;
        let bestFree = this._laneUntil[0];
        for (let i = 1; i < LANE_COUNT; i++) {
            if (this._laneUntil[i] < bestFree) {
                bestFree = this._laneUntil[i];
                best = i;
            }
        }
        // Occupy the lane — use the max duration so slower pills don't get overwritten
        this._laneUntil[best] = now + PILL_MAX_MS;
        return best;
    }

    _spawnPill(text, username, color) {
        if (!this.overlay || !this._enabled || this._paused) return;

        const pill = document.createElement('div');
        pill.className = 'danmaku-pill';

        // Lane assignment — distribute vertically to avoid full overlap
        const lane       = this._pickLane();
        const laneH      = 100 / LANE_COUNT;
        const topPct     = lane * laneH + (laneH * 0.1); // slight inset
        pill.style.top   = topPct + '%';

        // Message content — store raw text for deferred emoji re-render
        const msg = document.createElement('span');
        msg.className = 'dpill-text';
        msg.dataset.rawText = text;

        // Read the freshest emoji source available at spawn time
        const liveCache = (this._emojiCache && Object.keys(this._emojiCache).length > 0)
            ? this._emojiCache
            : ((typeof CommentSystem !== 'undefined' && CommentSystem.emojiCache) || null);
        if (liveCache && liveCache !== this._emojiCache) this._emojiCache = liveCache;

        msg.appendChild(this._renderContent(text));

        // Track pill for deferred re-render if emojis weren't ready yet
        if (!this._emojiCache || Object.keys(this._emojiCache).length === 0) {
            if (!this._pendingPills) this._pendingPills = new Set();
            this._pendingPills.add(msg);
        }

        pill.appendChild(msg);

        // Insert paused so we can measure before animation fires
        this.overlay.appendChild(pill);

        // Duration scales with text length so long comments get enough time to cross.
        // Formula: 5s base + 25ms per character, clamped to [6s, 45s].
        const charCount = text.length;
        const duration  = Math.min(Math.max(5000 + charCount * 25, PILL_MIN_MS), 45_000);

        // Use actual scroll (content) width — wider than offsetWidth for very long lines.
        // This ensures the animation pixel travel is enough for ALL content to exit left,
        // not just the max-width-capped pill box.
        const overlayW  = this.overlay.offsetWidth || window.innerWidth || 1920;
        const contentW  = pill.scrollWidth || pill.offsetWidth || 200;
        const startX    = overlayW + contentW;    // off-screen right
        const endX      = -(contentW + 200);      // fully off-screen left, overflow included

        const anim = pill.animate(
            [
                { transform: `translateX(${startX}px)` },
                { transform: `translateX(${endX}px)` }
            ],
            { duration, easing: 'linear', fill: 'none' }
        );

        // Remove pill once animation completes
        anim.addEventListener('finish', () => {
            if (pill.parentNode) pill.parentNode.removeChild(pill);
        }, { once: true });

        // Failsafe in case the Animations API finish event doesn't fire
        pill._timeoutId = setTimeout(() => { if (pill.parentNode) pill.parentNode.removeChild(pill); }, duration + 1000);
    }

    /** Re-render pending pills once emojis are available. */
    _reRenderEmojis() {
        if (!this.overlay) return;
        // Prefer direct element tracking (fast, no DOM query needed)
        const pending = this._pendingPills;
        if (pending && pending.size > 0) {
            pending.forEach(msg => {
                if (!msg.parentNode) { pending.delete(msg); return; } // already removed
                const raw = msg.dataset.rawText;
                if (!raw) return;
                msg.textContent = '';
                msg.appendChild(this._renderContent(raw));
            });
            pending.clear();
        }
        // Also sweep any pills that slipped through (belt-and-suspenders)
        this.overlay.querySelectorAll('.dpill-text[data-raw-text]').forEach(msg => {
            const raw = msg.dataset.rawText;
            if (!raw) return;
            // Only re-render if the content is still plain text (no img children)
            if (!msg.querySelector('img.dpill-emoji')) {
                msg.textContent = '';
                msg.appendChild(this._renderContent(raw));
            }
        });
    }

    /**
     * Build a DocumentFragment from raw comment text.
     * Handles [spoiler], [blur], :emoji:, and >greentext lines.
     */
    _renderContent(rawText) {
        if (!rawText) return document.createDocumentFragment();

        const prepared   = this._prepareText(rawText);
        const frag       = document.createDocumentFragment();
        const cache      = this._emojiCache; // always use full cache in danmaku

        // Process line by line — leading > lines become greentext
        // Filter empty lines to avoid ghost rows from trailing newlines
        const lines = prepared.split('\n').filter(l => l.trim() !== '');
        lines.forEach((line) => {
            const isQuote = /^>\s?/.test(line);
            const text    = isQuote ? '> ' + line.replace(/^>\s?/, '') : line;

            const span = document.createElement('span');
            span.className = isQuote ? 'dpill-greentext' : 'dpill-line';
            this._renderInline(text, span, cache);
            frag.appendChild(span);
        });

        return frag;
    }

    /**
     * Renders inline content (spoiler/blur/emoji) into a parent node.
     * Prepends a space before the first text chunk for visual separation.
     */
    _renderInline(text, parent, emojiCache) {
        // match[1]=spoiler, match[2]=blur, match[3]=emoji, match[4]=inline-img-url
        const combined = /\[spoiler\]([\s\S]*?)\[\/spoiler\]|\[blur\]([\s\S]*?)\[\/blur\]|:([a-z0-9_+\-]+):|\x04([^\x05]+)\x05/gi;
        let lastIndex = 0;
        let match;

        while ((match = combined.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            if (match[1] !== undefined) {
                const span = document.createElement('span');
                span.className = 'dpill-spoiler';
                span.title = 'Click to reveal spoiler';
                span.addEventListener('click', (e) => { e.stopPropagation(); span.classList.toggle('revealed'); });
                this._renderInline(match[1], span, emojiCache); // recursive so emojis inside spoilers work
                parent.appendChild(span);
            } else if (match[2] !== undefined) {
                const span = document.createElement('span');
                span.className = 'dpill-blur';
                span.title = 'Click to reveal';
                span.addEventListener('click', (e) => { e.stopPropagation(); span.classList.toggle('revealed'); });
                this._renderInline(match[2], span, emojiCache); // recursive so emojis inside blur work
                parent.appendChild(span);
            } else if (match[3]) {
                const code = match[3];
                const url  = emojiCache[code];
                if (url) {
                    const img = document.createElement('img');
                    img.src = url;
                    img.alt = `:${code}:`;
                    img.className = 'dpill-emoji';
                    parent.appendChild(img);
                } else {
                    parent.appendChild(document.createTextNode(match[0]));
                }
            } else if (match[4]) {
                const mediaUrl = match[4];
                const isConvertedGif = mediaUrl.endsWith('#gif');
                const cleanUrl = mediaUrl.replace(/#gif$/, '');
                const videoExts = /\.(?:mp4|webm|ogv|mov)$/i;
                const audioExts = /\.(?:mp3|ogg|wav|flac|aac|opus|m4a)$/i;

                if (videoExts.test(cleanUrl)) {
                    const vid = document.createElement('video');
                    vid.src = cleanUrl;
                    vid.className = 'dpill-video';
                    vid.muted = true;
                    vid.loop = true;
                    vid.autoplay = true;
                    vid.playsInline = true;
                    vid.play().catch(() => { vid.addEventListener('canplay', () => vid.play().catch(() => {}), { once: true }); });
                    parent.appendChild(vid);
                } else if (audioExts.test(cleanUrl)) {
                    const span = document.createElement('span');
                    span.className = 'dpill-audio';
                    span.textContent = '🔊 ';
                    parent.appendChild(span);
                } else {
                    const img = document.createElement('img');
                    img.src = cleanUrl;
                    img.className = 'dpill-img';
                    parent.appendChild(img);
                }
            }

            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < text.length) {
            parent.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
    }

    /** Strips markdown and character limits; preserves > and newlines for _renderContent. */
    _prepareText(text) {
        if (!text) return '';

        // Protect emoji codes from the bold/italic underscore regex.
        // e.g. `:dance_fart:  :dance_fart:` would have its underscores eaten
        // when the regex pairs the _ from the first code with the _ in the second.
        const emojiTokens = [];
        let protected_ = text.replace(/:([a-z0-9_+\-]+):/gi, (match) => {
            emojiTokens.push(match);
            return `\x02${emojiTokens.length - 1}\x03`; // private-use delimiters
        });

        // Tokenize image URLs with \x04URL\x05 so they survive all regexes and reach _renderInline
        // Only embed images from the allowed-images allowlist (window.f0ckAllowedImages) or same site
        const allowedHosts = Array.isArray(window.f0ckAllowedImages) ? window.f0ckAllowedImages : [];
        const siteHost = window.location.hostname;
        const isAllowedImg = (url) => {
            try {
                const h = new URL(url).hostname;
                return h === siteHost || allowedHosts.some(a => h === a || h.endsWith('.' + a));
            } catch { return false; }
        };
        const imgTokenUrls = [];
        protected_ = protected_
            // Tokenize relative /c/ media URLs (comment attachments)
            .replace(/\/c\/[a-f0-9]+\.(?:png|jpg|jpeg|gif|webp|svg|avif|mp4|webm|ogv|mov|mp3|ogg|wav|flac|aac|opus|m4a)(?:#gif)?/gi, (url) => {
                imgTokenUrls.push(url);
                return `\x04${imgTokenUrls.length - 1}\x05`;
            })
            // Stop at protocol boundaries so concatenated URLs aren't merged into one broken src.
            .replace(/https?:\/\/(?:(?!https?:\/\/)\S)+\.(?:png|jpg|jpeg|gif|webp|svg|avif)(\?(?:(?!https?:\/\/)\S)*)?/gi, (url) => {
                if (!isAllowedImg(url)) return url; // disallowed image URLs stay as plain text
                imgTokenUrls.push(url);
                return `\x04${imgTokenUrls.length - 1}\x05`; // numeric index placeholder
            })
            .replace(/```[\s\S]*?```/g, '[code]')
            .replace(/`[^`]+`/g, match => match.slice(1, -1))
            .replace(/!\[[^\]]*\]\([^)]+\)/g, '[img]')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
            // Normalize \r\n → \n but keep line breaks for greentext
            .replace(/\r\n?/g, '\n')
            // Collapse 3+ blank lines to 2
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        // Restore emoji codes, then image URL tokens
        return protected_
            .replace(/\x02(\d+)\x03/g, (_, i) => emojiTokens[+i] || '')
            .replace(/\x04(\d+)\x05/g, (_, i) => imgTokenUrls[+i] ? `\x04${imgTokenUrls[+i]}\x05` : '');
    }
}

window.Danmaku       = Danmaku;
window.SyntheticClock = SyntheticClock;

})();
