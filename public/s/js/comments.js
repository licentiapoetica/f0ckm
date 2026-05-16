// Safe wrapper — window.f0ckDebug may not be defined yet when this file first executes
// (comments.js loads before the footer script block that sets window.f0ckDebug).
// Calling through this helper defers the lookup to invocation time, not parse time.
const _f0ckDebug = (...args) => (typeof window.f0ckDebug === 'function' ? window.f0ckDebug(...args) : void 0);

class CommentSystem {
    constructor() {
        this.container = document.getElementById('comments-container');
        this.itemId = this.container ? this.container.dataset.itemId : null;
        this.user = this.container ? this.container.dataset.user : null; // logged in user?
        this.isAdmin = this.container ? this.container.dataset.isAdmin === 'true' : false;
        this.isLocked = this.container ? this.container.dataset.isLocked === 'true' : false;
        this.displayMode = window.f0ckSession?.comment_display_mode || 0; // 0=Tree, 1=Linear
        this.sort = (document.body.classList.contains('layout-legacy') || document.body.classList.contains('legacy-view')) ? 'old' : 'new';

        // Linear mode usually implies chronological order (4chan style)
        if (this.displayMode === 1) this.sort = 'old';

        this.customEmojis = CommentSystem.emojiCache || {};

        this.icons = {
            reply: `<i class="fa-solid fa-reply"></i>`,
            pin: `<i class="fa-solid fa-thumbtack"></i>`,
            unpin: `<i class="fa-solid fa-thumbtack"></i>`,
            edit: `<i class="fa-solid fa-pen"></i>`,
            delete: `<i class="fa-solid fa-trash"></i>`,
            link: `<i class="fa-solid fa-link"></i>`,
            pinned: `<i class="fa-solid fa-thumbtack"></i>`,
            lock: `<i class="fa-solid fa-lock"></i>`,
            unlock: `<i class="fa-solid fa-lock-open"></i>`
        };

        // Restore visibility state
        if (this.container) {
            const isHidden = localStorage.getItem('comments_hidden') === 'true';
            // Force show if hash is present
            if (window.location.hash && window.location.hash.startsWith('#c')) {
                this.container.classList.remove('faded-out');
                this.container.style.display = 'block';
                localStorage.setItem('comments_hidden', 'false');
            } else if (isHidden) {
                this.container.classList.add('faded-out');
                this.container.style.display = 'none';
                const layout = this.container.closest('.item-layout-container');
                if (layout) layout.classList.add('sidebar-hidden');
            }
        }

        this.initialLoadDone = false;
        this.pendingSubmissions = new Set();
        this.isMainSubmitting = false;
        this.scrollListenerAdded = false;
        this.commentCache = new Map();
        this._anchorScrollDone = false; // true after the first hash-anchor scroll on initial load

        this.loadEmojis(); // Always load emojis for previews
        this.setupHoverPreviews();

        if (this.itemId) {
            this.init();
        }
    }

    async init() {
        if (!this.container) {
            console.warn('[CommentSystem] Container not found during init');
            return;
        }
        if (this.container.dataset.commentSystemInit) {
            _f0ckDebug('[CommentSystem] Already initialized for this container');
            return;
        }
        this.container.dataset.commentSystemInit = 'true';
        _f0ckDebug('[CommentSystem] Initializing for item:', this.itemId);

        this.loadComments();
        this.setupGlobalListeners();
        this.setupDelegatedEvents();
        this.startLiveTimestamps();
        this.setupScrollListener();
    }

    setupScrollListener() {
        if (this.scrollListenerAdded) return;
        if (!document.body.classList.contains('layout-legacy') && !document.body.classList.contains('legacy-view')) return;

        const updateBtn = () => {
            const btn = document.querySelector('.scroll-to-bottom');
            if (!btn) return;

            const container = document.getElementById('comments-container');
            if (!container) return;

            const rect = container.getBoundingClientRect();
            // Detect if we are at the bottom of the comments section
            const isAtBottom = rect.bottom < window.innerHeight + 100;

            if (isAtBottom) {
                btn.classList.add('is-at-bottom');
                btn.setAttribute('title', 'Scroll to top');
            } else {
                btn.classList.remove('is-at-bottom');
                btn.setAttribute('title', 'Scroll to bottom');
            }
        };

        this.scrollHandler = updateBtn;
        window.addEventListener('scroll', this.scrollHandler, { passive: true });
        this.scrollListenerAdded = true;

        // Dynamic detection after potential renders
        this.scrollTimer = setInterval(this.scrollHandler, 1000);
    }

    /**
     * Boot or reload the Danmaku engine with fresh comment data.
     * Called after render() so the overlay is always in sync with visible comments.
     */
    _loadDanmaku(comments) {
        if (typeof Danmaku === 'undefined') return;

        const playerEl = document.querySelector('.v0ck') || document.getElementById('ruffle-container');
        if (!playerEl) return;

        // Ensure the container is positioned so the absolute overlay works
        if (getComputedStyle(playerEl).position === 'static') {
            playerEl.style.position = 'relative';
        }

        // Prefer real <video>/<audio>; fall back to SyntheticClock for Flash/Ruffle
        let mediaEl = document.querySelector('.v0ck video, .v0ck audio');
        let usingSynth = false;
        if (!mediaEl) {
            // Only create a synthetic clock if the player container exists (Flash/Ruffle etc.)
            if (typeof SyntheticClock !== 'undefined') {
                mediaEl = new SyntheticClock();
                usingSynth = true;
            } else {
                return; // danmaku.js not loaded yet
            }
        }

        // Stale-check: only compare player element (not mediaEl — SyntheticClock is always new)
        if (window.danmakuInstance) {
            const stale = window.danmakuInstance.player !== playerEl
                || !document.contains(window.danmakuInstance.player);
            if (stale) {
                window.danmakuInstance.destroy();
                window.danmakuInstance = null;
            } else if (usingSynth) {
                // Reuse existing instance for Flash — just reload comments, don't recreate clock
                mediaEl.destroy && mediaEl.destroy(); // discard the newly created clock
                mediaEl = window.danmakuInstance.media;
            }
        }

        if (!window.danmakuInstance) {
            window.danmakuInstance = new Danmaku(playerEl, mediaEl);
        }

        // Cancel any previous pending loadedmetadata listener before registering a new one
        if (this._danmakuLoadHandler) {
            mediaEl.removeEventListener('loadedmetadata', this._danmakuLoadHandler);
            this._danmakuLoadHandler = null;
        }

        const load = () => {
            window.danmakuInstance.load(comments);
            this._danmakuLoadHandler = null;
        };

        // SyntheticClock has duration=Infinity (always "ready"); real video may need to wait
        if (usingSynth || (isFinite(mediaEl.duration) && mediaEl.duration > 0)) {
            load();
        } else {
            this._danmakuLoadHandler = load;
            mediaEl.addEventListener('loadedmetadata', load, { once: true });
        }
    }

    destroy() {
        if (this.scrollHandler) {
            window.removeEventListener('scroll', this.scrollHandler);
        }
        if (this.scrollTimer) {
            clearInterval(this.scrollTimer);
        }
        if (this.stabilizationTimer) {
            clearTimeout(this.stabilizationTimer);
        }
        if (this.scrollDebounce) {
            clearTimeout(this.scrollDebounce);
        }
        if (this.stabilizationObserver) {
            this.stabilizationObserver.disconnect();
        }
        this.stopStabilization();
        _f0ckDebug('[CommentSystem] Instance destroyed');
    }

    async loadEmojis() {
        if (CommentSystem.emojiCache) {
            this.customEmojis = CommentSystem.emojiCache;
            // Immediate dispatch if already ready
            window.dispatchEvent(new CustomEvent('f0ck:emojis_ready', { detail: this.customEmojis }));
            return;
        }
        if (CommentSystem.loadingEmojis) return;
        CommentSystem.loadingEmojis = true;

        try {
            const res = await fetch('/api/v2/emojis');
            const data = await res.json();
            if (data.success) {
                this.customEmojis = {};
                data.emojis.forEach(e => {
                    this.customEmojis[e.name] = e.url;
                });
                CommentSystem.emojiCache = this.customEmojis;
                _f0ckDebug('Loaded Emojis:', this.customEmojis);

                // Preload images to prevent NS Binding Aborted errors
                this.preloadEmojiImages();

                if (this.container && this.lastData) {
                    const state = this.saveState();
                    // Invalidate data-raw on any comment content that contains emoji shortcodes,
                    // so that reconcile() sees them as "changed" and re-renders with the real emoji imgs.
                    this.container.querySelectorAll('.comment-content[data-raw]').forEach(el => {
                        if (/:([a-z0-9_]+):/.test(el.dataset.raw)) {
                            el.dataset.raw = '';
                        }
                    });
                    // Use reconciliation instead of full render to protect playing media
                    // even when emojis load late.
                    this.reconcile(this.lastData, this.lastUserId, this.lastIsSubscribed);
                    this.restoreState(state);
                    // Only scroll to anchor on the very first load — never on async emoji reloads
                    if (!this._anchorScrollDone && !this.preservingScroll && window.location.hash && window.location.hash.startsWith('#c')) {
                        const hashId = window.location.hash.substring(2);
                        this._anchorScrollDone = true;
                        this.scrollToComment(hashId);
                    }
                }

                // Global signal for other components (e.g. DMs)
                window.dispatchEvent(new CustomEvent('f0ck:emojis_ready', { detail: this.customEmojis }));
            } else {
                this.customEmojis = {};
            }
        } catch (e) {
            console.error("Failed to load emojis", e);
            this.customEmojis = {};
        } finally {
            CommentSystem.loadingEmojis = false;
        }
    }

    preloadEmojiImages() {
        // Preload all emoji images into browser cache
        if (!this.customEmojis) return;

        Object.values(this.customEmojis).forEach(url => {
            const img = new Image();
            img.src = url;
            // No need to append to DOM, just loading into cache
        });
    }

    // ...

    renderEmoji(match, name) {
        // _f0ckDebug('Rendering Emoji:', name, this.customEmojis ? this.customEmojis[name] : 'No list');
        if (this.customEmojis && this.customEmojis[name]) {
            return `<img src="${this.customEmojis[name]}" style="height:60px;vertical-align:middle;" alt="${name}">`;
        }
        return match;
    }

    saveState() {
        const state = {
            mainText: '',
            openReplies: [],
            focused: null
        };

        if (!this.container) return state;

        // 1. Save main input
        const mainInput = this.container.querySelector('.main-input textarea');
        if (mainInput && !this.isMainSubmitting) {
            state.mainText = mainInput.value;
            if (document.activeElement === mainInput) {
                state.focused = { type: 'main', start: mainInput.selectionStart, end: mainInput.selectionEnd };
            }
        }

        // 2. Save open replies
        this.container.querySelectorAll('.reply-input').forEach(form => {
            const parentId = form.dataset.parent;
            if (!parentId || this.pendingSubmissions.has(parentId)) return;

            const textarea = form.querySelector('textarea');
            const text = textarea ? textarea.value : '';
            if (parentId) {
                const replyState = { parentId, text };
                if (document.activeElement === textarea) {
                    state.focused = { type: 'reply', parentId, start: textarea.selectionStart, end: textarea.selectionEnd };
                }
                state.openReplies.push(replyState);
            }
        });

        return state;
    }

    restoreState(state) {
        if (!this.container) return;

        // 1. Restore open replies
        state.openReplies.forEach(({ parentId, text }) => {
            const commentBody = this.container.querySelector(`#c${parentId} > .comment-body`);
            if (commentBody && !commentBody.querySelector('.reply-input')) {
                const div = document.createElement('div');
                div.innerHTML = this.renderInput(parentId);
                commentBody.appendChild(div.firstElementChild);
                const newForm = commentBody.querySelector('.reply-input');
                if (newForm) {
                    const textarea = newForm.querySelector('textarea');
                    if (textarea) textarea.value = text;
                    this.setupEmojiPicker(newForm);
                }
            }
        });

        // 2. Restore main input text
        const mainInput = this.container.querySelector('.main-input textarea');
        if (mainInput && state.mainText) {
            mainInput.value = state.mainText;
        }

        // 3. Restore focus
        if (state.focused) {
            let targetEl = null;
            if (state.focused.type === 'main') {
                targetEl = this.container.querySelector('.main-input textarea');
            } else if (state.focused.type === 'reply') {
                targetEl = this.container.querySelector(`#c${state.focused.parentId} .reply-input textarea`);
            }

            if (targetEl) {
                targetEl.focus();
                // Ensure selection is restored after focus
                if (typeof targetEl.setSelectionRange === 'function') {
                    try {
                        targetEl.setSelectionRange(state.focused.start, state.focused.end);
                    } catch (e) {
                        // Fallback to end if range is invalid
                        const len = targetEl.value.length;
                        targetEl.setSelectionRange(len, len);
                    }
                }
            }
        }
    }

    handleLiveComment(data) {
        if (!this.container || !this.itemId) return;
        // 1. Check if comment belongs to this item
        if (parseInt(data.item_id) !== parseInt(this.itemId)) return;

        // 2. Check for duplicates (if we just posted it ourselves via optimistic insert).
        //    Even on early return, ensure the button is present if body was truncated.
        if (document.getElementById('c' + data.id)) {
            if (data.body && data.body.endsWith('\u2026')) {
                console.log('[handleLiveComment] duplicate+truncated, ensuring button for', data.id);
                const el = document.getElementById('c' + data.id);
                const contentEl = el?.querySelector('.comment-content');
                if (contentEl && !contentEl.querySelector('.load-full-comment-btn')) {
                    const btnLabel = (window.f0ckI18n?.sidebar_show_full_comment) || 'show full comment';
                    contentEl.insertAdjacentHTML('beforeend',
                        `<span class="item-comment-truncated-notice"><button class="load-full-comment-btn" type="button">${btnLabel}</button></span>`
                    );
                }
                this._patchLiveCommentContent(data.id);
            }
            return;
        }

        // 3. Robustness check: If we don't have lastData, initialize it.
        if (!this.lastData) {
            this.lastData = [];
        }

        // However, if we ARE currently loading comments from server, skip re-render.
        if (this.initialLoadDone === false && this.lastData.length === 0) {
            _f0ckDebug('[CommentSystem] Live comment skipped - initial comments load in progress.');
            return;
        }

        // 4. Construct comment object compatible with render
        const comment = {
            id: data.id,
            item_id: data.item_id,
            parent_id: data.parent_id || null,
            content: data.body,
            created_at: data.created_at,
            username: data.username,
            user_id: data.user_id,
            display_name: data.display_name || null,
            avatar: data.avatar,
            avatar_file: data.avatar_file,
            username_color: data.username_color,
            video_time: data.video_time ?? null,
            is_new: true,
            is_deleted: false,
            is_pinned: false
        };

        // Danmaku: fire one-shot for other users' comments.
        // Own comment is handled by the optimistic submit path (fire + addItem).
        // The _loadDanmaku re-render will add this comment to the items rotation.
        const currentUser = window.f0ckSession?.user;
        if (window.danmakuInstance && data.username !== currentUser) {
            window.danmakuInstance.fire(
                data.body,
                data.display_name || data.username || '?',
                data.username_color || null
            );
        }

        // Update backlinks for live comment
        if (data.body) {
            const matches = data.body.matchAll(/(?<!\w)>>(\d+)/g);
            for (const match of matches) {
                this.updateCommentBacklinks(match[1], data.id || data.comment_id);
            }
        }
        if (data.parent_id) {
            this.updateCommentBacklinks(data.parent_id, data.id || data.comment_id);
        }

        if (!this.lastData) this.lastData = [];

        // 4. Save state before re-render
        const state = this.saveState();

        if (this.sort === 'new') {
            this.lastData.unshift(comment); // Add to top
        } else {
            this.lastData.push(comment); // Add to bottom
        }

        // Reconciliation for live comments preserves media state
        this.reconcile(this.lastData, this.lastUserId, this.lastIsSubscribed);
        this.restoreState(state);

        // 6. Highlight and animate
        setTimeout(() => {
            const el = document.getElementById('c' + comment.id);
            if (el) {
                el.classList.add('new-item-fade');
            }
        }, 100);

        // 7. The NOTIFY body is capped at 500 chars to stay under PostgreSQL's 8KB limit.
        //    If the body was truncated, immediately show the "show full comment" button
        //    and then fetch + patch the real full content asynchronously.
        if (data.body && data.body.endsWith('\u2026')) {
            console.log('[handleLiveComment] body truncated, patching comment', data.id);
            const el = document.getElementById('c' + data.id);
            if (el) {
                const contentEl = el.querySelector('.comment-content');
                if (contentEl && !contentEl.querySelector('.load-full-comment-btn')) {
                    const btnLabel = (window.f0ckI18n?.sidebar_show_full_comment) || 'show full comment';
                    contentEl.insertAdjacentHTML('beforeend',
                        `<span class="item-comment-truncated-notice"><button class="load-full-comment-btn" type="button">${btnLabel}</button></span>`
                    );
                }
            }
            this._patchLiveCommentContent(data.id);
        }
    }

    async _patchLiveCommentContent(commentId) {
        try {
            const res = await fetch(`/api/comment/${commentId}`);
            if (!res.ok) return;
            const json = await res.json();
            if (!json.success || !json.comment) return;

            const fullContent = json.comment.content;
            const el = document.getElementById('c' + commentId);
            if (!el) return;

            const contentEl = el.querySelector('.comment-content');
            if (!contentEl) return;

            // Update in-memory data so future reconciles use the full content
            if (this.lastData) {
                const cached = this.lastData.find(c => String(c.id) === String(commentId));
                if (cached) cached.content = fullContent;
            }

            contentEl.dataset.raw = this.escapeHtml(fullContent);
            contentEl.innerHTML = this.renderCommentContent(fullContent, commentId);
        } catch (e) {
            _f0ckDebug('[CommentSystem] _patchLiveCommentContent failed:', e);
        }
    }

    handleLiveEdit(data) {
        if (data.item_id != this.itemId) return;

        // Update local cache
        if (this.lastData) {
            const comment = this.lastData.find(c => String(c.id) === String(data.comment_id));
            if (comment) {
                comment.content = data.content;
                comment.updated_at = new Date().toISOString();
            }
        }

        const el = document.getElementById('c' + data.comment_id);
        if (!el) return;

        const contentEl = el.querySelector('.comment-content');
        if (contentEl) {
            contentEl.innerHTML = this.renderCommentContent(data.content, data.comment_id);

            // Flash effect to draw attention
            el.classList.remove('new-item-fade');
            void el.offsetWidth; // Trigger reflow
            el.classList.add('new-item-fade');

            // Update admin edit button data attribute
            const editBtn = el.querySelector('.admin-edit-btn');
            if (editBtn) {
                editBtn.dataset.content = this.escapeHtml(data.content);
            }
        }
    }

    handleLiveDeletion(data) {
        if (!this.container || !this.itemId) return;
        if (parseInt(data.item_id) !== parseInt(this.itemId)) return;

        // Update local cache
        if (this.lastData) {
            const comment = this.lastData.find(c => String(c.id) === String(data.comment_id));
            if (comment) {
                comment.is_deleted = true;
                comment.content = '[deleted]';
            }
        }

        // Surgical update of the DOM to preserve other comments' media
        const el = this.container.querySelector('#c' + data.comment_id);
        if (el) {
            el.classList.add('deleted');
            const contentEl = el.querySelector('.comment-content');
            if (contentEl) {
                contentEl.innerHTML = '<span class="deleted-msg">[deleted]</span>';
                contentEl.dataset.raw = '[deleted]';
            }
            // Also remove admin buttons and reply button
            el.querySelectorAll('.admin-pin-btn, .admin-edit-btn, .admin-delete-btn, .reply-btn').forEach(b => b.remove());
        }
    }

    async loadComments(scrollToId = null, preserveScroll = false) {
        if (!this.container) return;

        // Preserve state before re-render
        const state = this.saveState();

        /* Guest handling is managed by the template and server-side routes.
           If we are here and there is no user, it means hide_comments_from_public is false.
           We should still allow loading comments for viewing. */
        if (!this.user) {
            // Check if we have preloaded data first
            const dataEl = document.getElementById('initial-comments');
            if (!dataEl) {
                // If no preloaded data and no user, we might be in a state where we shouldn't be
                // but let's let it proceed to fetch if container exists.
                // Actually, let's just make sure we don't return early if it's a guest.
            }
        }

        // Check for server-side preloaded comments
        const dataEl = document.getElementById('initial-comments');
        const subEl = document.getElementById('initial-subscription');
        const initialIsSubscribed = subEl ? (subEl.textContent.trim() === 'true') : false;

        if (dataEl) {
            try {
                // Decode Base64 for safe template transfer
                const raw = dataEl.textContent.trim();
                const json = decodeURIComponent(escape(atob(raw)));
                const comments = JSON.parse(json);

                // Consume
                dataEl.remove();
                if (subEl) subEl.remove();

                this.render(comments, this.user, initialIsSubscribed);
                this.initialLoadDone = true;
                this.restoreState(state);
                this._loadDanmaku(comments);

                if (scrollToId) {
                    this._anchorScrollDone = true;
                    this.scrollToComment(scrollToId);
                } else if (!this._anchorScrollDone && !preserveScroll && window.location.hash && window.location.hash.startsWith('#c')) {
                    const hashId = window.location.hash.substring(2);
                    this._anchorScrollDone = true;
                    this.scrollToComment(hashId);
                }
                return;
            } catch (e) {
                console.error("SSR comments parse error", e);
            }
        }

        // Render skeleton (Result: Layout visible immediately)
        // Skip when preserveScroll=true (tab re-focus refresh): the user already sees comments,
        // so wiping the DOM causes the browser to lose the #c anchor element and auto-scroll to top.
        if (!scrollToId && !preserveScroll) {
            this.render([], this.user, initialIsSubscribed);
            this.restoreState(state);
        }

        try {
            const res = await fetch(`/api/comments/${this.itemId}?sort=${this.sort}`);

            // If server is restarting (502/503), res.ok will be false.
            if (!res.ok) throw new Error(`Server returned ${res.status}`);

            const data = await res.json();

            if (data.success) {
                if (data.require_login) {
                    this.container.innerHTML = '';
                    this.container.style.display = 'none';
                    return;
                }

                this.isAdmin = data.is_admin || false;
                this.isLocked = data.is_locked || false;

                // Snapshot scroll position before DOM replacement (used when preserving position)
                const savedScrollY = preserveScroll ? window.scrollY : null;

                // Signal to render() and any async media/emoji handlers to NOT scroll to anchor.
                if (preserveScroll) {
                    this.preservingScroll = true;
                    this.stopStabilization();
                }

                const savedHash = (preserveScroll && window.location.hash.startsWith('#c'))
                    ? window.location.hash
                    : null;

                // 1. Early Bail-out: If data is bit-for-bit identical, do nothing.
                // This is the primary defense against tab-switch reloads when nothing changed.
                if (preserveScroll && this._isDeeplyIdentical(data.comments, data.user_id, data.is_subscribed)) {
                    _f0ckDebug('[CommentSystem] Sync: Data identical, bailing early to protect media.');
                    this.restoreState(state);
                    this.preservingScroll = false;
                    return;
                }

                // 2. Reconciliation: If data changed but we want to preserve media.
                if (preserveScroll && this.lastData && this.lastData.length > 0) {
                    _f0ckDebug('[CommentSystem] Sync: Data changed, reconciling DOM.');
                    this.reconcile(data.comments, data.user_id, data.is_subscribed);
                    this.initialLoadDone = true;
                    this.restoreState(state);

                    if (scrollToId) {
                        this.preservingScroll = false;
                        this.scrollToComment(scrollToId);
                    } else if (preserveScroll && savedScrollY !== null) {
                        requestAnimationFrame(() => {
                            window.scrollTo({ top: savedScrollY, behavior: 'instant' });
                            if (savedHash) {
                                history.replaceState(null, '', window.location.pathname + window.location.search + savedHash);
                                const hashId = savedHash.substring(2);
                                const el = document.getElementById(`c${hashId}`);
                                if (el) el.classList.add('comment-highlighted');
                            }
                            setTimeout(() => { this.preservingScroll = false; }, 500);
                        });
                    } else {
                        this.preservingScroll = false;
                    }
                    return;
                }

                if (savedHash) {
                    history.replaceState(null, '', window.location.pathname + window.location.search + savedHash);
                }

                // Render real data
                this.render(data.comments, data.user_id, data.is_subscribed);
                this.initialLoadDone = true;
                this.restoreState(state);
                this._loadDanmaku(data.comments);

                if (scrollToId) {
                    this.preservingScroll = false;
                    if (savedHash) history.replaceState(null, '', window.location.pathname + window.location.search + savedHash);
                    this.scrollToComment(scrollToId);
                } else if (preserveScroll && savedScrollY !== null) {
                    // Restore scroll position without animation to avoid visible jump.
                    // Use rAF so the browser has painted the new DOM before we override its scroll.
                    requestAnimationFrame(() => {
                        window.scrollTo({ top: savedScrollY, behavior: 'instant' });
                        // Silently restore the hash — history.replaceState does NOT trigger a scroll
                        if (savedHash) {
                            history.replaceState(null, '', window.location.pathname + window.location.search + savedHash);
                            // Re-apply the highlight class without scrolling
                            const hashId = savedHash.substring(2);
                            const el = document.getElementById(`c${hashId}`);
                            if (el) el.classList.add('comment-highlighted');
                        }
                        // Keep the flag active briefly to suppress any deferred media-load scrolls
                        setTimeout(() => { this.preservingScroll = false; }, 500);
                    });
                } else {
                    this.preservingScroll = false;
                    if (savedHash) history.replaceState(null, '', window.location.pathname + window.location.search + savedHash);
                    // Only jump to anchor on first load — never on tab re-focus (preserveScroll).
                    if (!this._anchorScrollDone && !preserveScroll && window.location.hash && window.location.hash.startsWith('#c')) {
                        const hashId = window.location.hash.substring(2);
                        this._anchorScrollDone = true;
                        this.scrollToComment(hashId);
                    }
                }
            } else {
                console.warn('[CommentSystem] Failed to load comments:', data.message);
                if (!this.initialLoadDone) {
                    this.container.innerHTML = `<div class="error">Failed to load comments: ${data.message}</div>`;
                }
            }
        } catch (e) {
            console.error('[CommentSystem] Error loading comments:', e);
            // Catch-all for network errors, 502s, JSON parse errors (e.g. server restart)
            // If initial load already finished (SSR or first fetch), just keep existing comments on screen.
            if (!this.initialLoadDone) {
                this.container.innerHTML = `<div class="error">Error loading comments. Please try again later.</div>`;
            }
        }
    }

    // ...



    scrollToComment(id, retries = 5, isStabilizing = false) {
        if (this.isUserInteracting && isStabilizing) return;
        // Never scroll during a tab-refocus restore — preservingScroll is set
        // synchronously in the visibilitychange handler before the async fetch.
        if (this.preservingScroll) return;

        const attempt = () => {
            const el = document.getElementById(`c${id}`);
            if (el) {
                // Remove highlight from any previously highlighted or newly-posted comment
                document.querySelectorAll('.comment-highlighted').forEach(c => c.classList.remove('comment-highlighted'));
                document.querySelectorAll('.comment-entering').forEach(c => c.classList.remove('comment-entering'));
                document.querySelectorAll('.new-item-fade').forEach(c => c.classList.remove('new-item-fade'));

                // Always smooth-scroll so there's no jarring jump
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('comment-highlighted');

                // If not already stabilizing, start a short-lived stabilization phase
                if (!isStabilizing) {
                    this.startStabilization(id);
                }
            } else if (retries > 0) {
                _f0ckDebug(`[CommentSystem] Scroll target #c${id} not found, retrying... (${retries} left)`);
                setTimeout(() => this.scrollToComment(id, retries - 1), 200);
            }
        };

        // Delay to allow for layout stabilization (e.g. images, other comments)
        // Shorter delay for stabilization calls
        setTimeout(attempt, isStabilizing ? 50 : 300);
    }

    startStabilization(id) {
        this.stopStabilization(); // Clear any existing
        this.isUserInteracting = false;

        const el = document.getElementById(`c${id}`);
        if (!el) return;

        // Interaction listeners to abort stabilization
        this.boundStopStabilization = (e) => {
            // Ignore small jitter, but stop on significant interaction
            if (e.type === 'keydown') {
                const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ', 'Home', 'End'];
                if (!scrollKeys.includes(e.key)) return;
            }
            _f0ckDebug(`[CommentSystem] Stabilization aborted due to ${e.type}`);
            this.isUserInteracting = true;
            this.stopStabilization();
        };

        ['wheel', 'touchmove', 'mousedown', 'keydown'].forEach(evt => {
            window.addEventListener(evt, this.boundStopStabilization, { passive: true });
        });

        let lastTop = el.getBoundingClientRect().top;
        let checks = 0;
        const maxChecks = 20; // ~4 seconds at 200ms

        const checkShift = () => {
            if (this.isUserInteracting || this.preservingScroll) return;
            const currentEl = document.getElementById(`c${id}`);
            if (!currentEl) return;

            const currentTop = currentEl.getBoundingClientRect().top;
            const diff = Math.abs(currentTop - lastTop);

            // If it shifted more than 10px (e.g. media loaded), re-scroll
            if (diff > 10 && checks < maxChecks) {
                _f0ckDebug(`[CommentSystem] Layout shift detected (${Math.round(diff)}px), re-stabilizing scroll...`);
                this.scrollToComment(id, 0, true);
                lastTop = currentEl.getBoundingClientRect().top;
            }

            checks++;
            if (checks < maxChecks) {
                this.stabilizationTimer = setTimeout(checkShift, 200);
            }
        };

        this.stabilizationTimer = setTimeout(checkShift, 200);

        // Also use ResizeObserver for immediate reaction to content loading
        if (window.ResizeObserver) {
            this.stabilizationObserver = new ResizeObserver(() => {
                if (this.preservingScroll) return; // Don't fight scroll-position restoration
                if (this.scrollDebounce) clearTimeout(this.scrollDebounce);
                this.scrollDebounce = setTimeout(() => {
                    if (this.preservingScroll) return;
                    const rect = el.getBoundingClientRect();
                    // If it's no longer near the center (roughly), re-center
                    const center = window.innerHeight / 2;
                    if (Math.abs(rect.top + rect.height / 2 - center) > 100) {
                        this.scrollToComment(id, 0, true);
                    }
                }, 100);
            });
            this.stabilizationObserver.observe(this.container);

            // Disconnect after 5 seconds to save resources
            setTimeout(() => this.stopStabilization(), 5000);
        }
    }

    stopStabilization() {
        if (this.stabilizationTimer) clearTimeout(this.stabilizationTimer);
        if (this.stabilizationObserver) this.stabilizationObserver.disconnect();
        this.stabilizationTimer = null;
        this.stabilizationObserver = null;

        if (this.boundStopStabilization) {
            ['wheel', 'touchmove', 'mousedown', 'keydown'].forEach(evt => {
                window.removeEventListener(evt, this.boundStopStabilization);
            });
            this.boundStopStabilization = null;
        }
    }

    async showCommentPreview(link, event) {
        if (this.previewCloseTimer) {
            clearTimeout(this.previewCloseTimer);
            this.previewCloseTimer = null;
        }

        const targetId = link.dataset.id;
        let targetEl = document.getElementById('c' + targetId);

        const parentPopup = link.closest('.comment-preview-popup');
        const level = parentPopup ? parseInt(parentPopup.dataset.level || 0) + 1 : 0;

        if (!targetEl) {
            const cached = this.commentCache.get(targetId);
            if (cached) {
                targetEl = this.createTemporaryCommentNode(cached);
            } else {
                // Fetch from API
                this.fetchCommentForPreview(targetId, link, level);
                return;
            }
        }

        // Close any previews at this level or higher (replacing the current branch)
        this.closePreviewsAboveLevel(level - 1);

        // If this exact ID is already the immediate child of this parent, don't re-open
        const existing = document.querySelector(`.comment-preview-popup[data-id="${targetId}"][data-level="${level}"]`);
        if (existing) return;

        // Clone the target comment
        const preview = targetEl.cloneNode(true);
        preview.id = 'comment-preview-' + Date.now();
        preview.classList.add('comment-preview-popup');
        preview.dataset.level = level;
        preview.dataset.id = targetId;

        // Remove temporary animation/highlight classes
        preview.classList.remove('new-item-fade', 'comment-highlighted', 'comment-entering');

        // Remove input forms or action buttons
        const actions = preview.querySelector('.comment-actions');
        if (actions) actions.remove();
        const footer = preview.querySelector('.comment-footer');
        if (footer) footer.remove();

        // Position the preview
        const rect = link.getBoundingClientRect();
        preview.style.position = 'fixed';
        preview.style.zIndex = (100000 + level).toString();

        // Try to place it to the right of the link, or top/bottom if needed
        let left = rect.right + 10;
        let top = rect.top;

        document.body.appendChild(preview);

        const previewRect = preview.getBoundingClientRect();

        // Boundary checks
        if (left + previewRect.width > window.innerWidth) {
            left = rect.left - previewRect.width - 10;
        }
        if (left < 0) left = 10;

        if (top + previewRect.height > window.innerHeight) {
            top = window.innerHeight - previewRect.height - 10;
        }
        if (top < 0) top = 10;

        preview.style.left = left + 'px';
        preview.style.top = top + 'px';
    }

    async fetchCommentForPreview(id, link, level) {
        if (this.commentCache.has(id)) return; // Already fetching or fetched

        // Prevent double fetches
        this.commentCache.set(id, { loading: true });

        try {
            const res = await fetch(`/api/comment/${id}`);
            const json = await res.json();
            if (json.success && json.comment) {
                this.commentCache.set(id, json.comment);
                // If the link is still being hovered (or we are in the middle of a dwell), show it
                if (this.currentHoverLink === link) {
                    this.showCommentPreview(link);
                }
            } else {
                this.commentCache.delete(id);
            }
        } catch (e) {
            console.error('[CommentSystem] Failed to fetch comment for preview:', e);
            this.commentCache.delete(id);
        }
    }

    createTemporaryCommentNode(comment) {
        if (comment.loading) {
            const div = document.createElement('div');
            div.className = 'comment loading-comment';
            div.innerHTML = '<div class="comment-body"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>';
            return div;
        }
        const html = this.renderComment(comment, window.f0ckSession?.user, false, true);
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.firstElementChild;
    }

    closePreviewsAboveLevel(level) {
        document.querySelectorAll('.comment-preview-popup').forEach(p => {
            if (parseInt(p.dataset.level || 0) > level) {
                p.remove();
            }
        });
    }

    hideCommentPreview(force = false) {
        if (force) {
            this.closePreviewsAboveLevel(-1);
            return;
        }

        if (this.previewCloseTimer) clearTimeout(this.previewCloseTimer);
        this.previewCloseTimer = setTimeout(() => {
            this.closePreviewsAboveLevel(-1);
        }, 400); // 400ms grace period to move mouse between link and popup
    }

    quoteComment(id, openerEl, body) {
        // If no reply input open anywhere, open the local one
        let textarea = document.querySelector('.comment-input.reply-input textarea');
        let isNew = false;
        if (!textarea && !body.querySelector('.reply-input')) {
            const div = document.createElement('div');
            div.innerHTML = this.renderInput(id);
            body.appendChild(div.firstElementChild);
            const newForm = body.querySelector('.reply-input');
            this.setupEmojiPicker(newForm);
            textarea = newForm.querySelector('textarea');
            newForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            isNew = true;
        } else if (!textarea) {
            textarea = body.querySelector('.reply-input textarea');
        }

        if (textarea) {
            const author = openerEl.dataset.display || openerEl.dataset.username || 'System';
            const contentEl = body.querySelector('.comment-content');
            if (contentEl) {
                const LINE_MAX = 200;
                const rawText = (contentEl.dataset.raw || '').trim();
                // Preserve all lines but cap any single line exceeding LINE_MAX chars
                const lines = rawText.split('\n').map(line =>
                    line.length > LINE_MAX ? line.substring(0, LINE_MAX) + '\u2026' : line
                );
                const quote = `>>${id} \n>${author}\n${lines.map(line => `>${line}`).join('\n')}\n`;

                if (isNew) {
                    textarea.value = quote;
                } else {
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const val = textarea.value;
                    textarea.value = val.substring(0, start) + quote + val.substring(end);
                }
                textarea.focus({ preventScroll: true });
                textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }

    saveMediaState() {
        // Snapshot currently playing or paused-mid-way media elements
        const state = [];
        if (!this.container) return state;
        this.container.querySelectorAll('video, audio').forEach(el => {
            if (!el.paused || el.currentTime > 0) {
                state.push({
                    src: el.src || el.currentSrc,
                    currentTime: el.currentTime,
                    paused: el.paused,
                    muted: el.muted,
                    volume: el.volume
                });
            }
        });
        return state;
    }

    restoreMediaState(state) {
        if (!state || state.length === 0 || !this.container) return;
        state.forEach(snap => {
            const el = this.container.querySelector(`video[src="${snap.src}"], audio[src="${snap.src}"]`);
            if (!el) return;
            el.currentTime = snap.currentTime;
            el.muted = snap.muted;
            el.volume = snap.volume;
            if (!snap.paused) {
                el.play().catch(() => {/* autoplay may be blocked */ });
            }
        });
    }

    render(comments, currentUserId, isSubscribed) {
        // Store for re-rendering when emojis load
        this.lastData = comments;
        this.lastUserId = currentUserId;
        this.lastIsSubscribed = isSubscribed;

        // Build map of who replied to whom for back-references (>>ID)
        this.buildBacklinkMap(comments);

        // Render logic based on display mode
        let renderedHtml = '';
        if (this.displayMode === 1) {
            // Linear Mode: Just sort all comments by date and render them flat
            const sortedComments = [...comments].sort((a, b) => {
                if (this.sort === 'old') return new Date(a.created_at) - new Date(b.created_at);
                return new Date(b.created_at) - new Date(a.created_at);
            });
            renderedHtml = sortedComments.map(c => this.renderComment(c, currentUserId, false, true)).join('');
        } else {
            // Tree Mode: Group by roots and replies
            const map = new Map();
            const roots = [];

            comments.forEach(c => {
                c.replies = [];
                c.replyTo = null; // Username being replied to (for @mentions)
                map.set(c.id, c);
            });

            // Find root parent for any comment
            const findRoot = (comment) => {
                if (!comment.parent_id) return null;
                let current = comment;
                while (current.parent_id && map.has(current.parent_id)) {
                    current = map.get(current.parent_id);
                }
                return current;
            };

            comments.forEach(c => {
                if (!c.parent_id) {
                    roots.push(c);
                } else {
                    const root = findRoot(c);
                    if (root && root !== c) {
                        const directParent = map.get(c.parent_id);
                        if (directParent && directParent.id !== root.id) {
                            c.replyTo = directParent.username;
                        }
                        root.replies.push(c);
                    } else {
                        roots.push(c);
                    }
                }
            });

            // Sort replies by date (oldest first)
            roots.forEach(r => {
                if (r.replies && r.replies.length > 0) {
                    r.replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                }
            });

            renderedHtml = roots.map(c => this.renderComment(c, currentUserId)).join('');
        }

        // Determine what to show for input
        let inputSection = '';
        if (this.isLocked && !this.isAdmin) {
            inputSection = '<div class="lock-notice">🔒 Comments are disabled on this thread.</div>';
        } else if (currentUserId) {
            inputSection = this.renderInput();
        } else {
            inputSection = '<div class="login-placeholder"><a href="/login" class="login-trigger-btn">Login</a> to comment</div>';
        }

        const isLegacy = document.body.classList.contains('layout-legacy') || document.body.classList.contains('legacy-view');
        let scrollToBottomBtn = '';
        if (isLegacy) {
            scrollToBottomBtn = `
                <div class="scroll-nav-wrapper">
                    <div class="scroll-to-bottom" title="Scroll to bottom">
                        <i class="fa-solid fa-arrow-down icon-down"></i>
                        <i class="fa-solid fa-arrow-up icon-up"></i>
                    </div>
                </div>
            `;
        }

        let html = '';
        if (isLegacy) {
            html = `
                <div class="comments-list ${this.displayMode === 1 ? 'linear-view' : ''}">
                    ${scrollToBottomBtn}
                    ${renderedHtml}
                </div>
                ${inputSection}
            `;
        } else {
            html = `
                ${inputSection}
                <div class="comments-list ${this.displayMode === 1 ? 'linear-view' : ''}">
                    ${scrollToBottomBtn}
                    ${renderedHtml}
                </div>
            `;
        }


        const mediaState = this.saveMediaState();
        this.container.innerHTML = html;
        this.restoreMediaState(mediaState);
        this.syncSubscribeButton(isSubscribed);

        // Attach media load listeners to re-stabilize scroll if a hash is active.
        // Only during the initial anchor scroll — never on subsequent renders (tab re-focus,
        // emoji reloads, live comment updates). _anchorScrollDone is set after the first
        // scrollToComment call, so this block only runs on the initial page load.
        if (!this._anchorScrollDone && !this.preservingScroll && window.location.hash && window.location.hash.startsWith('#c')) {
            const hashId = window.location.hash.substring(2);
            this.container.querySelectorAll('img, video, audio').forEach(media => {
                const handler = () => {
                    if (this.preservingScroll) return; // still in suppress window
                    if (this.scrollDebounce) clearTimeout(this.scrollDebounce);
                    this.scrollDebounce = setTimeout(() => this.scrollToComment(hashId, 0, true), 100);
                    media.removeEventListener('load', handler);
                    media.removeEventListener('loadedmetadata', handler);
                };
                media.addEventListener('load', handler);
                media.addEventListener('loadedmetadata', handler);
            });
        }

        const mainInput = this.container.querySelector('.main-input');
        if (mainInput) this.setupEmojiPicker(mainInput);
    }

    syncSubscribeButton(isSubscribed) {
        this.lastIsSubscribed = isSubscribed;
        document.querySelectorAll('#subscribe-btn').forEach(btn => {
            btn.classList.toggle('active', isSubscribed);
            btn.setAttribute('title', isSubscribed ? 'Subscribed' : 'Subscribe');

            // Update text if it exists (legacy support)
            const textNodes = Array.from(btn.childNodes).filter(node => node.nodeType === Node.TEXT_NODE);
            if (textNodes.length > 0) {
                textNodes[0].textContent = isSubscribed ? 'Subscribed' : 'Subscribe';
            }

            // FA icon: toggle fa-solid / fa-regular
            btn.classList.toggle('fa-solid', isSubscribed);
            btn.classList.toggle('fa-regular', !isSubscribed);
        });
    }

    _isDeeplyIdentical(newComments, currentUserId, isSubscribed) {
        if (!this.lastData) return false;

        // Use lax comparison for user IDs as they might flip between string/int
        const userMatches = (this.lastUserId == currentUserId);
        if (!userMatches) return false;

        if (this.lastIsSubscribed !== isSubscribed) return false;
        if (this.lastData.length !== newComments.length) return false;

        for (let i = 0; i < newComments.length; i++) {
            const a = this.lastData[i];
            const b = newComments[i];

            // Compare essential data that affects the UI
            if (a.id !== b.id ||
                a.content !== b.content ||
                a.is_deleted !== b.is_deleted ||
                a.is_pinned !== b.is_pinned ||
                a.display_name !== b.display_name) {
                return false;
            }
        }
        return true;
    }

    /**
     * DOM Reconciliation: Synchronizes current thread state with fresh data
     * without replacing the entire container, protecting active media (YouTube).
     */
    reconcile(comments, currentUserId, isSubscribed) {
        if (!this.container) return;
        const list = this.container.querySelector('.comments-list');
        if (!list) return this.render(comments, currentUserId, isSubscribed);

        // Update metadata
        this.syncSubscribeButton(isSubscribed);
        this.lastData = comments;
        this.lastUserId = currentUserId;
        this.lastIsSubscribed = isSubscribed;

        // Build map of who replied to whom for back-references (>>ID)
        this.buildBacklinkMap(comments);

        const incomingMap = new Map();
        comments.forEach(c => incomingMap.set(String(c.id), c));

        // 1. Identify missing or edited comments already in DOM
        const existingEls = list.querySelectorAll('[id^="c"]');
        const existingIds = new Set();

        existingEls.forEach(el => {
            const id = el.id.substring(1);
            existingIds.add(id);
            const incoming = incomingMap.get(id);

            if (!incoming) {
                // Comment was deleted/removed from server
                el.classList.add('deleted');
                const contentEl = el.querySelector('.comment-content');
                if (contentEl) contentEl.innerHTML = '<span class="deleted-msg">[deleted]</span>';
                const actions = el.querySelector('.comment-actions');
                if (actions) actions.style.display = 'none';
            } else {
                // Check for edits or state changes using robust data-attributes
                const contentEl = el.querySelector('.comment-content');
                if (contentEl && contentEl.dataset.raw !== incoming.content) {
                    _f0ckDebug(`[CommentSystem] Reconcile: Updating content for #c${id}`);
                    contentEl.innerHTML = this.renderCommentContent(incoming.content, incoming.id);
                    contentEl.dataset.raw = incoming.content;
                }

                // Update pinned status
                el.classList.toggle('pinned', !!incoming.is_pinned);
                const pinIcon = el.querySelector('.pin-icon');
                if (pinIcon) pinIcon.style.display = incoming.is_pinned ? 'block' : 'none';
            }
        });

        // 2. Insert new comments
        if (this.displayMode === 1) {
            // Linear Mode Insertion
            const sortedComments = [...comments].sort((a, b) => {
                if (this.sort === 'old') return new Date(a.created_at) - new Date(b.created_at);
                return new Date(b.created_at) - new Date(a.created_at);
            });

            sortedComments.forEach((c, idx) => {
                const idStr = String(c.id);
                if (document.getElementById('c' + idStr)) return;

                _f0ckDebug(`[CommentSystem] Reconcile: Injecting new flat comment #c${idStr}`);
                const html = this.renderComment(c, currentUserId, false, true);
                const tmp = document.createElement('div');
                tmp.innerHTML = html;
                const newEl = tmp.firstElementChild;

                if (idx === 0) {
                    const nav = list.querySelector('.scroll-nav-wrapper');
                    if (nav) nav.insertAdjacentElement('afterend', newEl);
                    else list.prepend(newEl);
                } else {
                    const prevId = String(sortedComments[idx - 1].id);
                    const prevEl = document.getElementById('c' + prevId);
                    if (prevEl) prevEl.insertAdjacentElement('afterend', newEl);
                    else list.appendChild(newEl);
                }
                newEl.classList.add('comment-entering', 'new-item-fade');
            });
            return;
        }

        // Tree Mode Insertion (Existing Logic)
        const map = new Map();
        const roots = [];
        comments.forEach(c => {
            c.replies = [];
            c.replyTo = null;
            map.set(c.id, c);
        });

        const findRoot = (comment) => {
            if (!comment.parent_id) return null;
            let current = comment;
            while (current.parent_id && map.has(current.parent_id)) {
                current = map.get(current.parent_id);
            }
            return current;
        };

        comments.forEach(c => {
            if (!c.parent_id) roots.push(c);
            else {
                const root = findRoot(c);
                if (root && root !== c) {
                    const directParent = map.get(c.parent_id);
                    if (directParent && directParent.id !== root.id) c.replyTo = directParent.username;
                    root.replies.push(c);
                } else roots.push(c);
            }
        });

        roots.forEach(r => {
            if (r.replies?.length > 0) r.replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        });

        // Recursively ensures a set of comments exists in a specific container
        const syncLevel = (levelComments, container, isReply) => {
            levelComments.forEach((c, idx) => {
                const idStr = String(c.id);
                let el = document.getElementById('c' + idStr);

                if (!el) {
                    _f0ckDebug(`[CommentSystem] Reconcile: Injecting new comment #c${idStr}`);
                    const html = this.renderComment(c, currentUserId, isReply);
                    const tmp = document.createElement('div');
                    tmp.innerHTML = html;
                    const newEl = tmp.firstElementChild;

                    // Insertion point: after previous sibling if it exists, else prepend
                    if (idx === 0) {
                        const nav = container.querySelector('.scroll-nav-wrapper');
                        if (nav) nav.insertAdjacentElement('afterend', newEl);
                        else container.prepend(newEl);
                    } else {
                        const prevId = String(levelComments[idx - 1].id);
                        const prevEl = document.getElementById('c' + prevId);
                        // If it's a root comment, we must skip the .comment-replies div of the previous sibling
                        let insertAfter = prevEl;
                        if (prevEl && !isReply) {
                            const next = prevEl.nextElementSibling;
                            if (next && next.classList.contains('comment-replies')) insertAfter = next;
                        }
                        if (insertAfter) insertAfter.insertAdjacentElement('afterend', newEl);
                        else container.appendChild(newEl);
                    }
                    el = newEl;
                    el.classList.add('comment-entering');
                    el.classList.add('new-item-fade');
                }

                // Handle replies container
                if (c.replies?.length > 0) {
                    let repliesWrap = el.nextElementSibling;
                    if (!repliesWrap || !repliesWrap.classList.contains('comment-replies')) {
                        repliesWrap = document.createElement('div');
                        repliesWrap.className = 'comment-replies';
                        el.insertAdjacentElement('afterend', repliesWrap);
                    }
                    syncLevel(c.replies, repliesWrap, true);
                }
            });
        };

        syncLevel(roots, list, false);
    }

    // Maximum characters to fully render in the item view per comment
    static get ITEM_VIEW_MAX_CHARS() { return 2000; }

    renderCommentContent(content, commentId = null, bypassTruncation = false) {
        if (!content) return '';

        // Truncate extremely long comments before any processing
        let truncated = false;
        if (!bypassTruncation && content.length > CommentSystem.ITEM_VIEW_MAX_CHARS) {
            content = content.substring(0, CommentSystem.ITEM_VIEW_MAX_CHARS) + '\u2026';
            truncated = true;
        }

        if (typeof marked === 'undefined') {
            console.warn('Marked.js not loaded, falling back to plain text');
            let text = this.escapeHtml(content)
                .replace(/\*fg\*/gi, '$&');
            return text;
        }

        try {
            // 1. Extract and protect code blocks (```...```) before escaping
            const codeBlocks = [];
            let processed = content.replace(/```([\s\S]*?)```/g, (match) => {
                const placeholder = `BLOCKPORTALX${codeBlocks.length}X`;
                codeBlocks.push(marked.parse(match));
                return placeholder;
            });

            // 2. Initial escaping for the rest of the text. Preserve > for manual blockquote handling.
            let escaped = this.escapeHtml(processed)
                .replace(/&gt;/g, ">");


            const siteOrigin = window.location.origin;
            const renderer = new marked.Renderer();

            renderer.blockquote = quote => {
                let text = (typeof quote === 'string') ? quote : (quote.text || '');
                text = text.replace(/<p>|<\/p>/g, '');
                return text.split('\n').map(line => {
                    if (!line.trim()) return '';
                    return `<span class="greentext">&gt;${line}</span>`;
                }).join('\n');
            };

            renderer.paragraph = text => (typeof text === 'string') ? text : (text.text || '');

            renderer.link = (href, title, text) => {
                if (typeof href === 'object' && href !== null) {
                    title = href.title;
                    text = href.text || text;
                    href = href.href;
                }
                if (!href) return text || '';
                const titleAttr = title ? ` title="${title}"` : '';
                const isExternal = href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//');
                let isSameSite = false;

                // Marked greedy autolink fix for spoiler brackets appended to URLs
                let extraSuffix = '';
                const lowerHref = href.toLowerCase();
                if (lowerHref.endsWith('%5b/spoiler%5d')) {
                    href = href.substring(0, href.length - 14);
                    text = text.replace(/\[\/spoiler\]/ig, '');
                    extraSuffix = '[/spoiler]';
                } else if (lowerHref.endsWith('[/spoiler]')) {
                    href = href.substring(0, href.length - 10);
                    text = text.replace(/\[\/spoiler\]/ig, '');
                    extraSuffix = '[/spoiler]';
                }

                let uri = encodeURI(href);
                if (href.startsWith(siteOrigin) || (href.startsWith('/') && !href.startsWith('//'))) {
                    isSameSite = true;
                } else {
                    try {
                        const urlToParse = href.startsWith('//') ? window.location.protocol + href : href;
                        const urlObj = new URL(urlToParse, siteOrigin);
                        isSameSite = (urlObj.hostname === window.location.hostname);
                    } catch (e) { }
                }

                // Shorten internal links if text matches the URL
                let displayText = text;
                if (isSameSite && (text === href || text === href.replace(/^https?:\/\//, '') || text === href.replace(siteOrigin, ''))) {
                    try {
                        const urlToParse = href.startsWith('//') ? window.location.protocol + href : href;
                        const url = new URL(urlToParse.startsWith('http') ? urlToParse : siteOrigin + (urlToParse.startsWith('/') ? '' : '/') + urlToParse);
                        displayText = url.pathname + url.search + url.hash;
                    } catch (e) {
                        console.warn('[CommentSystem] Failed to parse internal URL for shortening:', href);
                    }
                }

                const isMention = href.startsWith('/user/') && text.startsWith('@');
                if (isExternal && !isSameSite) {
                    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${displayText}<i class="fa-solid fa-arrow-up-right-from-square external-link-icon"></i></a>${extraSuffix}`;
                }
                return `<a href="${href}"${titleAttr}${isMention ? ' class="mention"' : ''}>${displayText}</a>${extraSuffix}`;
            };

            // Pre-compile regexes used in the loop
            const escapedSiteHost = window.location.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const allowedHosts = [escapedSiteHost];
            if (window.f0ckAllowedImages && Array.isArray(window.f0ckAllowedImages)) {
                window.f0ckAllowedImages.forEach(h => {
                    const escapedHost = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    allowedHosts.push(`(?:[a-z0-9-]+\\.)*${escapedHost}`);
                });
            }
            const hostsRegexPart = allowedHosts.join('|');
            const domainOrRelative = `(?:(?:https?:\\/\\/|\\/\\/)?(?:${hostsRegexPart})|(?<!\\S)(?=\\/[a-zA-Z0-9_\\-]))`;

            // "Safe non-whitespace" — matches any \S except the start of an https?:// boundary.
            // Prevents concatenated URLs (url1.webpurl2.webp) being consumed as one giant src.
            const safeS = `(?:(?!https?:\\/\\/)\\S)`;
            const imageRegex = new RegExp(`(?<![\\(\\[])(${domainOrRelative}(?:\\/${safeS}+\\.(?:jpg|jpeg|png|gif|webp)(?:\\?${safeS}+)?))(?![\\)\\]])`, 'gi');
            const rawVideoRegex = new RegExp(`(?<![\\(\\[])(${domainOrRelative}(?:\\/[^\\s\\[\\]\\(\\)]*\\.(?:mp4|webm|ogv|mov)(?:\\?[^\\s\\[\\]\\(\\)]+)?))`, 'gi');
            const rawAudioRegex = new RegExp(`(?<![\\(\\[])(${domainOrRelative}(?:\\/[^\\s\\[\\]\\(\\)]*\\.(?:mp3|ogg|wav|flac|aac|opus|m4a)(?:\\?[^\\s\\[\\]\\(\\)]+)?))`, 'gi');
            const mentionRegex = /(?<!\[)@([a-zA-Z0-9_\-\.]+)(?!\])|\[@([^\]]+)\]/g;

            // Line-by-line processing: handles quotes, mentions, images, and basic markdown safely
            const renderedLines = escaped.split('\n').map(line => {
                const trimmed = line.trimStart();

                // 1. Manual Greentext/Quote handling (avoids recursive blockquote parsing)
                // Exclude only the numeric context links (>>ID) so they can be handled as interactive links.
                // Multiple chevrons (>>text, >>>text) should still be greentext.
                if (trimmed.startsWith('>') && !trimmed.match(/^>>\d+/)) {
                    const quoteContent = line.substring(line.indexOf('>') + 1);
                    const quoteEmojis = window.f0ckSession?.quote_emojis === true;
                    const renderedContent = quoteEmojis
                        ? quoteContent.replace(/:([a-z0-9_]+):/g, (m, n) => this.renderEmoji(m, n))
                        : quoteContent;
                    return `<span class="greentext">&gt;${renderedContent}</span>`;
                }

                // 2. Per-line limit to prevent marked.parse recursion on single giant lines
                if (line.length > 10000) return line;

                if (!line.trim()) return '&nbsp;';

                // 3. Perform replacements on the single line (prevents regex stack overflow on huge strings)
                let processedLine = line;

                // Handle Mentions
                processedLine = processedLine.replace(mentionRegex, (match, g1, g2) => {
                    const user = g1 || g2;
                    return `<a href="/user/${encodeURIComponent(user)}" class="mention">@${user}</a>`;
                });

                // Handle Comment Context Links (>>ID)
                processedLine = processedLine.replace(/(?<!\w)>>(\d+)/g, (match, id) => {
                    return `<a href="#c${id}" class="comment-context-link" data-id="${id}">>>${id}</a>`;
                });

                // Handle Image Embeds
                processedLine = processedLine.replace(imageRegex, (match, url) => {
                    let fullUrl = url;
                    if (!url.startsWith('http') && !url.startsWith('//') && !url.startsWith('/')) {
                        fullUrl = '//' + url;
                    }
                    return `![image](${fullUrl})`;
                });

                // Handle Raw Video/Audio links so Marked converts them to <a>
                processedLine = processedLine.replace(rawVideoRegex, (match, url) => {
                    let fullUrl = url;
                    if (!url.startsWith('http') && !url.startsWith('//') && !url.startsWith('/')) fullUrl = '//' + url;
                    return `[video](${fullUrl})`;
                });

                processedLine = processedLine.replace(rawAudioRegex, (match, url) => {
                    let fullUrl = url;
                    if (!url.startsWith('http') && !url.startsWith('//') && !url.startsWith('/')) fullUrl = '//' + url;
                    return `[audio](${fullUrl})`;
                });

                // 3. Render Markdown for the line
                const escapedAsterisks = processedLine.replace(/\*/g, '\\*');
                let rendered = marked.parseInline
                    ? marked.parseInline(escapedAsterisks, { renderer: renderer })
                    : marked.parse(escapedAsterisks, { renderer: renderer }).replace(/<p>|<\/p>/g, '');

                // 4. Emojis
                rendered = rendered.replace(/:([a-z0-9_]+):/g, (m, n) => this.renderEmoji(m, n));

                return rendered;
            });

            let md = renderedLines.join('\n');

            // YouTube embed: replace anchor links pointing to YouTube with an embedded player
            // Respects per-user preference (session) when logged in; falls back to global config flag for guests.
            const embedYoutube = window.f0ckSession
                ? window.f0ckSession.embed_youtube_in_comments !== false
                : window.f0ckEmbedYoutubeInComments !== false;
            if (embedYoutube) {
                md = md.replace(
                    /<a\s[^>]*href="https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^"]*&(?:amp;)?)?v=|youtu\.be\/)([a-zA-Z0-9_\-]{11})[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
                    (match, videoId) => {
                        return `<span class="yt-embed-wrap"><iframe src="https://www.youtube.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></span>`;
                    }
                );
            }

            // Vocaroo embed
            md = md.replace(
                /<a\s[^>]*href="https?:\/\/(?:www\.)?(?:voca\.ro|vocaroo\.com)\/([a-zA-Z0-9_-]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
                (match, vocarooId) => {
                    if (['upload', 'contact', 'privacy', 'tos', 'about'].includes(vocarooId.toLowerCase())) return match;
                    return `<span class="vocaroo-embed-wrap"><iframe src="https://vocaroo.com/embed/${vocarooId}?autoplay=0" width="300" height="60" frameborder="0" allow="autoplay"></iframe></span>`;
                }
            );

            // Build regex for allowed media hosters (video/audio)
            const mediaHosts = [escapedSiteHost];
            if (window.f0ckAllowedImages && Array.isArray(window.f0ckAllowedImages)) {
                window.f0ckAllowedImages.forEach(h => {
                    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    mediaHosts.push(`(?:[a-z0-9-]+\\.)*${escaped}`);
                });
            }
            const mediaHostsPart = mediaHosts.join('|');
            const mediaDomainOrRelative = `(?:(?:https?:\\/\\/|\\/\\/)?(?:${mediaHostsPart})|(?=\\/[a-zA-Z0-9_\\-]))`;

            // Video embed: replace anchor links pointing to video files from allowed hosters with a video player
            const videoEmbedRegex = new RegExp(`<a\\s[^>]*href="(${mediaDomainOrRelative}(?:\\/[^\\s\\[\\]\\(\\)]+\\.(?:mp4|webm|ogv|mov)(?:\\?[^\\s\\[\\]\\(\\)]+)?))"[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
            md = md.replace(videoEmbedRegex, (match, url) => {
                return `<span class="video-embed-wrap"><video src="${url}" controls loop muted playsinline preload="metadata"></video></span>`;
            });

            // Audio embed: replace anchor links pointing to audio files from allowed hosters with an audio player
            const audioEmbedRegex = new RegExp(`<a\\s[^>]*href="(${mediaDomainOrRelative}(?:\\/[^\\s\\[\\]\\(\\)]+\\.(?:mp3|ogg|wav|flac|aac|opus|m4a)(?:\\?[^\\s\\[\\]\\(\\)]+)?))"[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
            md = md.replace(audioEmbedRegex, (match, url) => {
                return `<span class="audio-embed-wrap"><audio src="${url}" controls preload="metadata"></audio></span>`;
            });

            // Handle spoilers [spoiler]text[/spoiler] (supports nesting)
            let prevMd;
            let iterations = 0;
            const spoilerRegex = /\[spoiler\]((?:(?!\[spoiler\])[\s\S])*?)\[\/spoiler\]/gi;
            do {
                prevMd = md;
                md = md.replace(spoilerRegex, (match, content) => {
                    return `<span class="spoiler">${content}</span>`;
                });
                iterations++;
            } while (md !== prevMd && iterations < 10);

            // Handle blur [blur]text[/blur] (supports nesting)
            const blurRegex = /\[blur\]((?:(?!\[blur\])[\s\S])*?)\[\/blur\]/gi;
            iterations = 0;
            do {
                prevMd = md;
                md = md.replace(blurRegex, (match, content) => {
                    return `<span class="blur-text">${content}</span>`;
                });
                iterations++;
            } while (md !== prevMd && iterations < 10);

            // Restore protected code blocks
            md = md.replace(/BLOCKPORTALX(\d+)X/g, (match, index) => {
                return codeBlocks[index] || '';
            });

            if (window.Sanitizer && typeof Sanitizer.clean === 'function') {
                md = Sanitizer.clean(md);
            }

            // Append the "show full comment" button AFTER sanitization — the sanitizer
            // whitelist strips <button> elements for XSS safety, but this button is ours.
            if (truncated) {
                const btnLabel = (window.f0ckI18n?.sidebar_show_full_comment) || 'show full comment';
                md += `<span class="item-comment-truncated-notice"><button class="load-full-comment-btn" type="button">${btnLabel}</button></span>`;
            }

            return md;
        } catch (e) {
            console.error('Markdown error:', e);
            let fallback = this.escapeHtml(content);
            if (truncated) {
                const btnLabel = (window.f0ckI18n?.sidebar_show_full_comment) || 'show full comment';
                fallback += ` <span class="item-comment-truncated-notice"><button class="load-full-comment-btn" type="button">${btnLabel}</button></span>`;
            }
            return fallback;
        }
    }

    buildBacklinkMap(comments) {
        this.backlinkMap = {};
        const process = (c) => {
            if (!c.content) return;
            // Scan for >>ID patterns
            const matches = c.content.matchAll(/(?<!\w)>>(\d+)/g);
            for (const match of matches) {
                const targetId = match[1];
                if (!this.backlinkMap[targetId]) this.backlinkMap[targetId] = new Set();
                this.backlinkMap[targetId].add(c.id);
            }
            // Also treat parent_id as a direct reply
            if (c.parent_id) {
                const targetId = String(c.parent_id);
                if (!this.backlinkMap[targetId]) this.backlinkMap[targetId] = new Set();
                this.backlinkMap[targetId].add(c.id);
            }
        };

        const scan = (list) => {
            list.forEach(c => {
                process(c);
                if (c.replies && c.replies.length > 0) scan(c.replies);
            });
        };
        scan(comments);
    }

    renderEmoji(match, name) {
        if (this.customEmojis && this.customEmojis[name]) {
            return `<img src="${this.customEmojis[name]}" class="emoji" alt="${match}" title="${match}">`;
        }
        return match;
    }

    startLiveTimestamps() {
        // Update timestamps every 30 seconds
        setInterval(() => {
            const timestamps = this.container.querySelectorAll('.comment-time.timeago');
            timestamps.forEach(el => {
                const dateStr = el.getAttribute('tooltip');
                if (dateStr) {
                    el.textContent = this.timeAgo(dateStr);
                }
            });
        }, 30000);
    }

    updateCommentBacklinks(targetId, replierId) {
        if (!this.backlinkMap) this.backlinkMap = {};
        if (!this.backlinkMap[targetId]) this.backlinkMap[targetId] = new Set();
        this.backlinkMap[targetId].add(replierId);

        const targetEl = document.getElementById('c' + targetId);
        if (targetEl) {
            const headerLeft = targetEl.querySelector('.comment-header-left');
            if (headerLeft) {
                let span = headerLeft.querySelector('.comment-backlinks');
                if (!span) {
                    span = document.createElement('span');
                    span.className = 'comment-backlinks';
                    headerLeft.appendChild(span);
                }
                // Check if already present
                if (!span.querySelector(`a[data-id="${replierId}"]`)) {
                    const link = document.createElement('a');
                    link.href = `#c${replierId}`;
                    link.className = 'comment-context-link';
                    link.dataset.id = replierId;
                    link.textContent = `>>${replierId}`;
                    span.appendChild(document.createTextNode(' '));
                    span.appendChild(link);
                }
            }
        }
    }

    renderComment(comment, currentUserId, isReply = false, isLinear = false) {
        const isDeleted = comment.is_deleted;
        const isPinned = comment.is_pinned;

        // Add @mention prefix if this is a reply to a reply
        const content = isDeleted ? '<span class="deleted-msg">[deleted]</span>' : this.renderCommentContent(comment.content, comment.id);
        const date = new Date(comment.created_at).toLocaleString();

        // Admin buttons
        let adminButtons = '';
        if (this.isAdmin && !isDeleted) {
            const pinIcon = isPinned ? this.icons.unpin : this.icons.pin;
            adminButtons = `<button class="admin-pin-btn ${isPinned ? 'active' : ''}" data-id="${comment.id}" title="${isPinned ? 'Unpin' : 'Pin'}">${pinIcon}</button><button class="admin-edit-btn" data-id="${comment.id}" data-content="${this.escapeHtml(comment.content)}">${this.icons.edit}</button><button class="admin-delete-btn" data-id="${comment.id}">${this.icons.delete}</button>`;
        }

        const pinnedBadge = isPinned ? `<span class="pinned-badge" title="Pinned">${this.icons.pinned}</span>` : '';
        const commentClass = isReply ? 'comment reply' : 'comment';

        // Build replies HTML (only for root comments, max 1 level deep)
        let repliesHtml = '';
        if (!isReply && !isLinear && comment.replies && comment.replies.length > 0) {
            repliesHtml = `<div class="comment-replies">${comment.replies.map(r => this.renderComment(r, currentUserId, true)).join('')}</div>`;
        }

        const timeAgo = this.timeAgo(comment.created_at);
        const fullDate = new Date(comment.created_at).toISOString();

        // Parent context marker removed (redundant with back-references)
        let contextMarker = '';

        // Back-references (replies to this comment)
        let backlinkHtml = '';
        if (this.backlinkMap && this.backlinkMap[comment.id]) {
            const repliers = Array.from(this.backlinkMap[comment.id]);
            if (repliers.length > 0) {
                backlinkHtml = `<span class="comment-backlinks">${repliers.map(rid => `<a href="#c${rid}" class="comment-context-link" data-id="${rid}">>>${rid}</a>`).join(' ')}</span>`;
            }
        }

        return `
            <div class="${commentClass} ${isDeleted ? 'deleted' : ''} ${isPinned ? 'pinned' : ''}" id="c${comment.id}">
                <div class="comment-avatar">
                    ${comment.username ? `<a href="/user/${comment.username}">` : ''}
                    <img src="${comment.avatar_file ? `/a/${comment.avatar_file}` : (comment.avatar ? `/t/${comment.avatar}.webp` : '/a/default.png')}" alt="av">
                    ${comment.username ? `</a>` : ''}
                </div>
                <div class="comment-body">
                    <div class="comment-header">
                        <div class="comment-header-left">
                            ${pinnedBadge}${comment.username ? `<a href="/user/${comment.username}" class="comment-author" tooltip="ID: ${comment.user_id}" ${comment.username_color ? `style="color: ${comment.username_color}"` : ''}>${this.escapeHtml(comment.display_name || comment.username)}</a>` : '<span class="comment-author">System</span>'}
                            ${contextMarker}
                            ${backlinkHtml}
                        </div>
                        <a href="#c${comment.id}" class="comment-time timeago" title="${fullDate}" data-id="${comment.id}" data-username="${comment.username}" data-display="${this.escapeHtml(comment.display_name || '')}">${timeAgo}</a>
                    </div>
                    <div class="comment-content" data-raw="${this.escapeHtml(comment.content)}">${content}</div>
                    ${this.renderCommentAttachments(comment.files)}
                    <div class="comment-footer">
                        <div class="comment-footer-right">
                            <div class="comment-actions">
                                ${!isDeleted && currentUserId ? `<button class="reply-btn" data-id="${comment.id}" data-username="${comment.username}" data-display="${this.escapeHtml(comment.display_name || '')}" title="Reply"><i class="fa-solid fa-reply"></i></button><button class="quote-btn" data-id="${comment.id}" data-username="${comment.username}" data-display="${this.escapeHtml(comment.display_name || '')}" title="Quote with Text"><i class="fa-solid fa-quote-left"></i></button><button class="report-comment-btn" data-id="${comment.id}" title="Report Comment" style="background:none;border:none;color:inherit;cursor:pointer;opacity:0.75;padding:0;"><i class="fa-solid fa-triangle-exclamation"></i></button>` : ''}
                                ${adminButtons}
                            </div>
                        </div>
                    </div>
                </div>
                <a href="#c${comment.id}" class="comment-permalink" title="Permalink" data-id="${comment.id}" data-username="${comment.username}" data-display="${this.escapeHtml(comment.display_name || '')}">#${comment.id}</a>
            </div>
            ${repliesHtml}
        `;
    }

    timeAgo(date) {
        if (window.f0ckTimeAgo) return window.f0ckTimeAgo(date);
        const seconds = Math.floor((new Date() - new Date(date)) / 1000);
        if (seconds < 5) return 'just now';
        const intervals = [
            { label: 'year', seconds: 31536000 },
            { label: 'month', seconds: 2592000 },
            { label: 'day', seconds: 86400 },
            { label: 'hour', seconds: 3600 },
            { label: 'minute', seconds: 60 },
            { label: 'second', seconds: 1 }
        ];
        for (const interval of intervals) {
            const count = Math.floor(seconds / interval.seconds);
            if (count >= 1) {
                return `${count} ${interval.label}${count !== 1 ? 's' : ''} ago`;
            }
        }
        return 'just now';
    }

    escapeHtml(unsafe) {
        if (!unsafe) return '';
        const div = document.createElement('div');
        div.textContent = unsafe;
        return div.innerHTML;
    }

    renderCommentAttachments(files) {
        if (!files || files.length === 0) return '';
        const items = files.map(f => {
            const url = `/c/${f.dest}`;
            if (f.mime.startsWith('image/')) {
                return `<a href="${url}" target="_blank" class="cf-attachment cf-image"><img src="${url}" alt="${this.escapeHtml(f.original_filename || 'image')}" loading="lazy"></a>`;
            } else if (f.mime.startsWith('video/')) {
                return `<div class="cf-attachment cf-video"><video src="${url}" controls preload="metadata"></video></div>`;
            } else if (f.mime.startsWith('audio/')) {
                return `<div class="cf-attachment cf-audio"><audio src="${url}" controls preload="metadata"></audio></div>`;
            }
            return '';
        }).join('');
        return items ? `<div class="comment-attachments">${items}</div>` : '';
    }

    renderInput(parentId = null) {
        const i18n = window.f0ckI18n || {};
        const session = window.f0ckSession || {};
        const placeholder = i18n.write_comment || 'Write a comment...';
        const postLabel = i18n.post || 'Post';
        const cancelLabel = i18n.cancel || 'Cancel';
        const attachLabel = i18n.attach_file || 'Attach file';
        const maxLen = session.comment_max_length;
        const maxLenAttr = (maxLen !== null && maxLen !== undefined) ? ` maxlength="${maxLen}"` : '';
        const counter = (maxLen !== null && maxLen !== undefined)
            ? `<span class="char-counter" data-max="${maxLen}">0 / ${maxLen}</span>`
            : '';
        const fileUploadEnabled = session.logged_in && session.allow_fileupload_comments;
        const multiFile = session.fileupload_comments_multifile;
        const attachBtn = fileUploadEnabled
            ? `<button class="comment-attach-btn" title="${attachLabel}" type="button"><i class="fa-solid fa-paperclip"></i></button><input type="file" class="comment-file-input" accept="image/*,video/*,audio/*" ${multiFile ? 'multiple' : ''} style="display:none;">`
            : '';
        return `
            <div class="comment-input ${parentId ? 'reply-input' : 'main-input'}" ${parentId ? `data-parent="${parentId}"` : ''}>
                <textarea placeholder="${placeholder}"${maxLenAttr}></textarea>
                <div class="comment-file-preview"></div>
                <div class="input-actions">
                    ${counter}
                    ${attachBtn}
                    ${parentId ? `<button class="cancel-reply" title="${cancelLabel}"><i class="fa-solid fa-xmark"></i></button>` : ''}
                    <button class="submit-comment">${postLabel}</button>
                </div>
            </div>
        `;
    }

    setupHoverPreviews() {
        if (CommentSystem.hoverPreviewsAttached) return;
        CommentSystem.hoverPreviewsAttached = true;

        // Hover for Comment Context Links (>>ID) - Global delegation for nested previews (inception)
        this.mouseCurrentLevel = -1;
        this.currentHoverLink = null;
        document.addEventListener('mouseover', (e) => {
            const contextLink = e.target.closest('.comment-context-link');
            const popup = e.target.closest('.comment-preview-popup');

            if (contextLink || popup) {
                if (this.previewCloseTimer) {
                    clearTimeout(this.previewCloseTimer);
                    this.previewCloseTimer = null;
                }
            }

            if (contextLink) {
                // Ignore mouseover for previews on mobile touch devices to prevent tap-to-preview
                // We handle mobile previews via the touchstart timer instead.
                if (window.matchMedia('(pointer: coarse)').matches) return;

                if (this.currentHoverLink === contextLink) return;
                this.currentHoverLink = contextLink;

                if (this.previewOpenTimer) clearTimeout(this.previewOpenTimer);
                this.previewOpenTimer = setTimeout(() => {
                    this.showCommentPreview(contextLink, e);
                }, 150); // 150ms dwell time to prevent flickering while moving mouse
            } else {
                if (this.previewOpenTimer) {
                    clearTimeout(this.previewOpenTimer);
                    this.previewOpenTimer = null;
                }
                this.currentHoverLink = null;

                const level = popup ? parseInt(popup.dataset.level || 0) : -1;

                // If we move back to a parent level or blank area of a popup, close its children
                // but use a delay so the user can reach the child popup if they are moving towards it.
                if (popup && !contextLink) {
                    this.previewCloseTimer = setTimeout(() => {
                        this.closePreviewsAboveLevel(level);
                    }, 400);
                }

                this.mouseCurrentLevel = level;
            }
        });

        document.addEventListener('mouseout', (e) => {
            const contextLink = e.target.closest('.comment-context-link');
            const popup = e.target.closest('.comment-preview-popup');

            if (contextLink) {
                if (this.previewOpenTimer) {
                    clearTimeout(this.previewOpenTimer);
                    this.previewOpenTimer = null;
                }
                this.currentHoverLink = null;
            }

            if (contextLink || popup) {
                if (this.previewCloseTimer) clearTimeout(this.previewCloseTimer);
                this.previewCloseTimer = setTimeout(() => {
                    this.closePreviewsAboveLevel(-1);
                    this.mouseCurrentLevel = -1;
                }, 400);
            }
        });

        // Mobile Touch Support: Touch-and-hold to preview
        let touchPreviewTimer = null;
        document.addEventListener('touchstart', (e) => {
            const contextLink = e.target.closest('.comment-context-link');
            if (contextLink) {
                if (touchPreviewTimer) clearTimeout(touchPreviewTimer);
                touchPreviewTimer = setTimeout(() => {
                    this.showCommentPreview(contextLink, e);
                }, 150); // 150ms hold to trigger preview on mobile
            }
        }, { passive: true });

        document.addEventListener('touchmove', () => {
            if (touchPreviewTimer) {
                clearTimeout(touchPreviewTimer);
                touchPreviewTimer = null;
            }
        }, { passive: true });

        document.addEventListener('touchend', () => {
            if (touchPreviewTimer) {
                clearTimeout(touchPreviewTimer);
                touchPreviewTimer = null;
            }
        }, { passive: true });

        // Global click listener to close popups (useful for mobile dismissal)
        document.addEventListener('click', (e) => {
            const isLink = e.target.closest('.comment-context-link');
            const isPopup = e.target.closest('.comment-preview-popup');

            if (!isLink && !isPopup) {
                this.closePreviewsAboveLevel(-1);
            }
        });
    }

    setupDelegatedEvents() {
        _f0ckDebug('[DEBUG] Setting up delegated events for container:', this.container);
        if (!this.container) return;

        // Ctrl+Enter to submit comment
        this.container.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
                const textarea = e.target.closest('textarea');
                if (!textarea) return;
                const wrap = textarea.closest('.comment-input');
                if (!wrap) return;
                const submitBtn = wrap.querySelector('.submit-comment');
                if (submitBtn) submitBtn.click();
            } else if (e.key === 'Escape') {
                const textarea = e.target.closest('textarea');
                if (textarea) textarea.blur();
            }
        });

        // Live character counter (only active when comment_max_length is set)
        this.container.addEventListener('input', (e) => {
            const textarea = e.target.closest('.comment-input textarea');
            if (!textarea) return;
            const counter = textarea.closest('.comment-input')?.querySelector('.char-counter');
            if (!counter) return;
            const max = parseInt(counter.dataset.max, 10);
            // Exclude quoted lines (starting with '>') from the count —
            // quoted context is capped at 200 chars and shouldn't eat into the user's limit.
            const nonQuotedLen = textarea.value
                .split('\n')
                .filter(line => !line.startsWith('>'))
                .join('\n')
                .length;
            counter.textContent = `${nonQuotedLen} / ${max}`;
            counter.classList.toggle('near-limit', nonQuotedLen >= max * 0.9);
            counter.classList.toggle('at-limit', nonQuotedLen >= max);
        });

        // Single Change Listener for Sort
        this.container.addEventListener('change', (e) => {
            if (e.target.id === 'comment-sort') {
                this.sort = e.target.value;
                this.loadComments();
            }
        });

        // Single Click Listener for Everything
        this.container.addEventListener('change', async (e) => {
            if (!e.target.matches('.comment-file-input')) return;
            const fileInput = e.target;
            const wrap = fileInput.closest('.comment-input');
            if (!wrap) return;
            const textarea = wrap.querySelector('textarea');
            if (!textarea) return;
            const previewArea = wrap.querySelector('.comment-file-preview');
            const session = window.f0ckSession || {};
            const maxSize = session.fileupload_comments_size || (10 * 1024 * 1024);
            const i18n = window.f0ckI18n || {};
            const removeLabel = i18n.remove_file || 'Remove file';

            const maxAttachments = session.fileupload_comments_max || 5;
            const currentCount = previewArea ? previewArea.querySelectorAll('.cf-preview-item').length : 0;
            const slotsLeft = maxAttachments - currentCount;

            if (fileInput.files.length > slotsLeft) {
                if (window.flashMessage) window.flashMessage(
                    `Maximum ${maxAttachments} attachments per comment exceeded`,
                    3000, 'error'
                );
                fileInput.value = '';
                return;
            }

            for (const file of fileInput.files) {
                if (file.size > maxSize) {
                    if (window.flashMessage) window.flashMessage((i18n.file_too_large || 'File too large') + `: ${file.name}`, 3000, 'error');
                    continue;
                }
                const fd = new FormData();
                fd.append('file', file);
                const csrf = session.csrf_token || '';
                const uploadingText = i18n.uploading_file || 'Uploading...';
                const submitBtn = wrap.querySelector('.submit-comment');

                // Track pending uploads
                wrap._pendingUploads = (wrap._pendingUploads || 0) + 1;
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.classList.add('uploading');
                }

                // Insert placeholder at cursor position
                const cursorPos = textarea.selectionStart;
                const before = textarea.value.substring(0, cursorPos);
                const after = textarea.value.substring(textarea.selectionEnd);
                const placeholder = `[${uploadingText} ${file.name}]`;
                const sep = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
                textarea.value = before + sep + placeholder + after;

                // Show uploading preview
                let previewItem = null;
                if (previewArea) {
                    previewItem = document.createElement('div');
                    previewItem.className = 'cf-preview-item cf-uploading';
                    const spinner = document.createElement('i');
                    spinner.className = 'fa-solid fa-spinner fa-spin';
                    previewItem.appendChild(spinner);
                    const nameEl = document.createElement('span');
                    nameEl.className = 'cf-filename';
                    nameEl.textContent = file.name;
                    previewItem.appendChild(nameEl);
                    previewArea.appendChild(previewItem);
                }

                try {
                    const res = await fetch('/api/v2/comments/upload', {
                        method: 'POST',
                        headers: { 'X-CSRF-Token': csrf },
                        body: fd
                    });
                    const json = await res.json();
                    if (json.success && json.files && json.files.length > 0) {
                        const fileData = json.files[0];
                        const url = `/c/${fileData.dest}`;
                        textarea.value = textarea.value.replace(placeholder, url);

                        // Update preview with actual thumbnail
                        if (previewItem) {
                            previewItem.classList.remove('cf-uploading');
                            previewItem.dataset.url = url;
                            previewItem.dataset.fileId = fileData.id;
                            previewItem.innerHTML = '';

                            if (fileData.mime.startsWith('image/')) {
                                const img = document.createElement('img');
                                img.src = url;
                                img.loading = 'lazy';
                                previewItem.appendChild(img);
                            } else if (fileData.mime.startsWith('video/')) {
                                const vid = document.createElement('video');
                                vid.src = url;
                                vid.muted = true;
                                vid.preload = 'metadata';
                                previewItem.appendChild(vid);
                            } else {
                                const icon = document.createElement('i');
                                icon.className = 'fa-solid fa-music';
                                previewItem.appendChild(icon);
                            }

                            const nameEl = document.createElement('span');
                            nameEl.className = 'cf-filename';
                            nameEl.textContent = file.name;
                            previewItem.appendChild(nameEl);

                            const removeBtn = document.createElement('button');
                            removeBtn.className = 'cf-remove-btn';
                            removeBtn.title = removeLabel;
                            removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                            previewItem.appendChild(removeBtn);
                        }
                    } else {
                        textarea.value = textarea.value.replace(placeholder, '');
                        if (previewItem) previewItem.remove();
                        if (window.flashMessage) window.flashMessage(json.msg || 'Upload error', 3000, 'error');
                    }
                } catch (err) {
                    textarea.value = textarea.value.replace(placeholder, '');
                    if (previewItem) previewItem.remove();
                    if (window.flashMessage) window.flashMessage('Upload failed: ' + err.message, 3000, 'error');
                } finally {
                    // Decrement pending uploads
                    wrap._pendingUploads = Math.max(0, (wrap._pendingUploads || 1) - 1);
                    if (wrap._pendingUploads === 0) {
                        const submitBtn = wrap.querySelector('.submit-comment');
                        if (submitBtn) {
                            submitBtn.disabled = false;
                            submitBtn.classList.remove('uploading');
                        }
                    }
                }
            }
            fileInput.value = '';
        });

        this.container.addEventListener('click', async (e) => {
            _f0ckDebug('[DEBUG] Click on container:', e.target);
            const target = e.target;


            // Toggling Scroll Action
            const scrollBtn = target.closest('.scroll-to-bottom');
            if (scrollBtn) {
                if (scrollBtn.classList.contains('is-at-bottom')) {
                    // Scroll to Top of the page
                    window.scrollTo({
                        top: 0,
                        behavior: 'smooth'
                    });
                } else {
                    // Scroll to Bottom of comments
                    const bottomElement = this.container.querySelector('.main-input') || this.container.querySelector('.lock-notice') || this.container.querySelector('.login-placeholder');
                    if (bottomElement) {
                        bottomElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    } else {
                        this.container.scrollIntoView({ behavior: 'smooth', block: 'end' });
                    }
                }
                return;
            }

            // Attach file button
            if (target.matches('.comment-attach-btn') || target.closest('.comment-attach-btn')) {
                const wrap = target.closest('.comment-input');
                const fileInput = wrap?.querySelector('.comment-file-input');
                if (fileInput) fileInput.click();
                return;
            }

            // Remove file preview + strip URL from textarea
            if (target.matches('.cf-remove-btn') || target.closest('.cf-remove-btn')) {
                const previewItem = target.closest('.cf-preview-item');
                if (previewItem) {
                    const url = previewItem.dataset.url;
                    if (url) {
                        const wrap = previewItem.closest('.comment-input');
                        const textarea = wrap?.querySelector('textarea');
                        if (textarea) {
                            // Remove the URL and any surrounding newline
                            textarea.value = textarea.value.replace(new RegExp('\\n?' + url.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\n?'), '\n').replace(/^\n|\n$/g, '');
                        }
                    }
                    previewItem.remove();
                }
                return;
            }

            // Submit Comment
            if (target.matches('.submit-comment')) {
                this.handleSubmit(e);
                return;
            }

            // Cancel Reply
            if (target.matches('.cancel-reply')) {
                const form = target.closest('.reply-input');
                if (form) form.remove();
                return;
            }

            // Load full comment (expand truncated)
            const loadFullBtn = target.closest('.load-full-comment-btn');
            if (loadFullBtn) {
                const contentEl = loadFullBtn.closest('.comment-content');
                if (contentEl) {
                    const fullContent = contentEl.dataset.raw;
                    if (fullContent) {
                        contentEl.innerHTML = this.renderCommentContent(fullContent, null, true);
                        // Append "see less" button after full content
                        const seeLessLabel = (window.f0ckI18n?.sidebar_see_less) || 'see less';
                        contentEl.insertAdjacentHTML('beforeend',
                            `<span class="item-comment-truncated-notice"><button class="collapse-comment-btn" type="button">${seeLessLabel}</button></span>`
                        );
                    }
                }
                return;
            }

            // Collapse full comment back to truncated view
            const collapseBtn = target.closest('.collapse-comment-btn');
            if (collapseBtn) {
                const contentEl = collapseBtn.closest('.comment-content');
                if (contentEl) {
                    const fullContent = contentEl.dataset.raw;
                    if (fullContent) {
                        contentEl.innerHTML = this.renderCommentContent(fullContent, null, false);
                    }
                }
                return;
            }

            // Comment Context Link (>>ID)
            const contextLink = target.closest('.comment-context-link');
            if (contextLink) {
                e.preventDefault();
                const targetId = contextLink.dataset.id;
                this.scrollToComment(targetId, 0, true);

                // Highlight effect
                const targetEl = document.getElementById('c' + targetId);
                if (targetEl) {
                    targetEl.classList.add('highlight-comment');
                    setTimeout(() => targetEl.classList.remove('highlight-comment'), 2000);
                }
                return;
            }

            // User Delete
            const delBtn = target.closest('.delete-btn');
            if (delBtn) {
                if (delBtn.dataset.confirming !== 'true') {
                    delBtn.dataset.confirming = 'true';
                    const originalText = delBtn.innerHTML;
                    delBtn.innerHTML = 'Sure?';
                    delBtn.classList.add('btn-danger'); // Optional styling
                    setTimeout(() => {
                        delBtn.dataset.confirming = 'false';
                        delBtn.innerHTML = originalText;
                        delBtn.classList.remove('btn-danger');
                    }, 3000);
                    return;
                }

                const id = delBtn.dataset.id;
                const res = await fetch(`/api/comments/${id}/delete`, {
                    method: 'POST',
                    headers: { 'X-CSRF-Token': window.f0ckSession?.csrf_token }
                });
                const json = await res.json();
                if (json.success) this.loadComments();
                else alert('Failed to delete: ' + (json.message || 'Error'));
                return;
            }

            // Admin Delete
            const adminDelBtn = target.closest('.admin-delete-btn');
            if (adminDelBtn) {
                if (typeof ModAction === 'undefined') return alert('Error: ModAction module not loaded. Are you a moderator?');

                const id = adminDelBtn.dataset.id;
                ModAction.confirm('Delete Comment', `Are you sure you want to delete comment <strong>${id}</strong>?`, async (reason) => {
                    const params = new URLSearchParams();
                    if (reason) params.append('reason', reason);

                    const res = await fetch(`/api/comments/${id}/delete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: params
                    });
                    const json = await res.json();
                    if (json.success) {
                        this.loadComments();
                    } else {
                        throw new Error(json.message || 'Failed to delete');
                    }
                }, { allowEmpty: window.f0ckSession?.is_admin });
                return;
            }

            // Admin Pin
            const adminPinBtn = target.closest('.admin-pin-btn');
            if (adminPinBtn) {
                const id = adminPinBtn.dataset.id;
                const res = await fetch(`/api/comments/${id}/pin`, {
                    method: 'POST',
                    headers: { 'X-CSRF-Token': window.f0ckSession?.csrf_token }
                });
                const json = await res.json();
                if (json.success) this.loadComments(id);
                else alert('Failed to pin: ' + (json.message || 'Error'));
                return;
            }

            // Admin Edit
            const adminEditBtn = target.closest('.admin-edit-btn');
            if (adminEditBtn) {
                const id = adminEditBtn.dataset.id;
                const currentContent = adminEditBtn.dataset.content;
                const commentEl = document.getElementById('c' + id);
                const contentEl = commentEl.querySelector('.comment-content');

                const originalHtml = contentEl.innerHTML;
                contentEl.innerHTML = `
                    <textarea class="edit-textarea">${currentContent}</textarea>
                    <div class="input-actions">
                        <button class="cancel-edit-btn" title="Cancel"><i class="fa-solid fa-comment-slash"></i></button>
                        <button class="save-edit-btn">Save</button>
                    </div>
                `;

                this.setupEmojiPicker(contentEl);

                // We don't need to bind events here because delegation handles the new buttons too!
                // But we need to store originalHtml somewhere or handle Cancel specifically?
                // Actually, for Cancel of edit, we need state? 
                // We can store original HTML in a dataset of the container or just re-render/reload?
                // Re-loading is safer for now, or we can use a closure if we attached listener here.
                // Since this is Delegation, "Cancel" needs to know what to restore.
                // Let's attach a "once" listener on the cancel button immediately here? 
                // NO, mixing strategies is confusing.
                // Let's put original HTML in dataset encoded? No, potentially large.
                // Simpler: On Cancel, just reload the comment (fetch or just re-render whole list).
                // Or: Attach a specialized listener strictly for this temporary element.

                const cancelBtn = contentEl.querySelector('.cancel-edit-btn');
                cancelBtn.onclick = () => { contentEl.innerHTML = originalHtml; };

                const saveBtn = contentEl.querySelector('.save-edit-btn');
                saveBtn.onclick = async () => {
                    const newContent = contentEl.querySelector('.edit-textarea').value;
                    if (!newContent.trim()) return alert('Cannot be empty');
                    const params = new URLSearchParams();
                    params.append('content', newContent);
                    const res = await fetch(`/api/comments/${id}/edit`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: params
                    });
                    const json = await res.json();
                    if (json.success) this.loadComments(id);
                    else alert('Failed to edit: ' + (json.message || 'Error'));
                };
                return;
            }

            // Reply
            // Reply Button (ID only)
            const replyBtn = target.closest('.reply-btn');
            if (replyBtn) {
                const id = replyBtn.dataset.id;
                const commentEl = replyBtn.closest('[id^="c"]');
                const body = commentEl ? commentEl.querySelector('.comment-body') : null;

                if (body) {
                    // Check if any reply input is ALREADY open
                    let textarea = document.querySelector('.comment-input.reply-input textarea');

                    // If none open, open the local one for this comment
                    if (!textarea && !body.querySelector('.reply-input')) {
                        const div = document.createElement('div');
                        div.innerHTML = this.renderInput(id);
                        body.appendChild(div.firstElementChild);
                        const newForm = body.querySelector('.reply-input');
                        this.setupEmojiPicker(newForm);
                        textarea = newForm.querySelector('textarea');
                    } else if (!textarea) {
                        textarea = body.querySelector('.reply-input textarea');
                    }

                    if (textarea) {
                        const quote = `>>${id} `;
                        const start = textarea.selectionStart;
                        const end = textarea.selectionEnd;
                        const val = textarea.value;
                        textarea.value = val.substring(0, start) + quote + val.substring(end);
                        textarea.focus({ preventScroll: true });
                        textarea.selectionStart = textarea.selectionEnd = start + quote.length;
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
                return;
            }

            // Quote Button (Full Text Quote - Old Style)
            const quoteBtn = target.closest('.quote-btn');
            if (quoteBtn) {
                const id = quoteBtn.dataset.id;
                const body = quoteBtn.closest('.comment-body');
                if (body) {
                    this.quoteComment(id, quoteBtn, body);
                }
                return;
            }

            // Subscribe
            const subBtn = target.closest('#subscribe-btn');
            if (subBtn) {
                const isSubscribed = subBtn.textContent === 'Subscribed';
                subBtn.textContent = 'Wait...';
                try {
                    const res = await fetch(`/api/subscribe/${this.itemId}`, {
                        method: 'POST',
                        headers: { 'X-CSRF-Token': window.f0ckSession?.csrf_token }
                    });
                    const json = await res.json();
                    if (json.success) {
                        this.syncSubscribeButton(json.subscribed);
                        window.flashMessage((window.f0ckI18n && (json.subscribed ? window.f0ckI18n.subscribed_thread : window.f0ckI18n.unsubscribed_thread)) || (json.subscribed ? 'SUBSCRIBED TO THREAD' : 'UNSUBSCRIBED FROM THREAD'));
                    } else {
                        subBtn.textContent = isSubscribed ? 'Subscribed' : 'Subscribe';
                        alert('Failed to toggle subscription');
                    }
                } catch (e) {
                    subBtn.textContent = isSubscribed ? 'Subscribed' : 'Subscribe';
                }
                return;
            }

            // Lock
            const lockBtn = target.closest('#lock-thread-btn');
            if (lockBtn) {
                const action = this.isLocked ? 'unlock' : 'lock';
                lockBtn.disabled = true;
                const res = await fetch(`/api/comments/${this.itemId}/lock`, {
                    method: 'POST',
                    headers: { 'X-CSRF-Token': window.f0ckSession?.csrf_token }
                });
                const json = await res.json();
                lockBtn.disabled = false;
                if (json.success) {
                    this.isLocked = json.is_locked;
                    lockBtn.title = this.isLocked ? 'Unlock Thread' : 'Lock Thread';
                    window.flashMessage(this.isLocked ? 'THREAD LOCKED' : 'THREAD UNLOCKED');
                    this.loadComments();
                } else {
                    window.flashMessage(json.msg || 'Failed to lock/unlock', 3000, 'error');
                }
                return;
            }

            // Permalinks & Timestamp clicks
            if (target.classList.contains('comment-permalink') || target.closest('.comment-time')) {
                const el = target.closest('.comment-permalink, .comment-time');
                if (el) {
                    const id = el.dataset.id;
                    const commentEl = el.closest('[id^="c"]');
                    const body = commentEl ? commentEl.querySelector('.comment-body') : null;
                    if (body) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        this.quoteComment(id, el, body);
                    }
                }
                return;
            }
        });
    }

    async handleSubmit(e) {
        const wrap = e.target.closest('.comment-input');
        const submitBtn = wrap.querySelector('.submit-comment');
        const textarea = wrap.querySelector('textarea');
        const text = textarea.value.trim();
        const parentId = wrap.dataset.parent || null;

        if (!text.trim()) return;
        if (submitBtn.classList.contains('loading')) return;
        if (wrap._pendingUploads > 0) return;

        // Start loading state
        submitBtn.classList.add('loading');
        const originalBtnHtml = submitBtn.innerHTML;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

        // Mark as pending to prevent state restoration while in flight
        if (parentId) {
            this.pendingSubmissions.add(parentId);
        } else {
            this.isMainSubmitting = true;
        }

        let retryCount = 0;
        const maxRetries = 20; // Allow several minutes of retrying during restart

        const attemptSubmit = async () => {
            try {
                // Capture video timecode at the moment of submission
                const videoEl = document.querySelector('.v0ck video, .v0ck audio');
                const videoTime = (videoEl && isFinite(videoEl.duration) && videoEl.currentTime > 0)
                    ? videoEl.currentTime
                    : null;

                const params = new URLSearchParams();
                params.append('item_id', this.itemId);
                if (parentId) params.append('parent_id', parentId);
                params.append('content', text);
                if (videoTime !== null) params.append('video_time', videoTime.toFixed(3));

                const res = await fetch('/api/comments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params
                });

                if (!res.ok) {
                    if (res.status >= 500) {
                        throw new Error(`Server returned ${res.status}`);
                    }
                    // For 4xx errors, we stop and show the error to user (likely validation or auth)
                    const json = await res.json().catch(() => ({}));
                    alert('Error: ' + (json.message || `Status ${res.status}`));
                    this._finishSubmit(submitBtn, originalBtnHtml, parentId);
                    return;
                }

                const json = await res.json();
                if (json.success) {
                    // Success cleanup
                    if (parentId) {
                        const formRow = wrap.closest('.reply-input');
                        if (formRow) formRow.remove();
                    } else {
                        if (textarea) textarea.value = '';
                        const counter = wrap.querySelector('.char-counter');
                        if (counter) {
                            counter.textContent = `0 / ${counter.dataset.max}`;
                            counter.classList.remove('near-limit', 'at-limit');
                        }
                        const fpArea = wrap.querySelector('.comment-file-preview');
                        if (fpArea) fpArea.innerHTML = '';
                    }

                    // Notify the right sidebar that a new comment was posted (silent refresh)
                    document.dispatchEvent(new CustomEvent('f0ck:commentPosted', {
                        detail: { item_id: this.itemId, comment_id: json.comment?.id, content: text }
                    }));

                    // ── Optimistic DOM inject ──────────────────────────────────────────
                    // Build a minimal comment object from known session + server data so we
                    // can insert the comment directly without replacing the entire container.
                    const session = window.f0ckSession || {};
                    const currentUsername = session.user || this.user;
                    let resolvedAvatar = null;
                    let resolvedAvatarFile = null;

                    if (session.avatar_file) resolvedAvatarFile = session.avatar_file;
                    else if (session.avatar) resolvedAvatar = session.avatar;

                    if (!resolvedAvatar && !resolvedAvatarFile && this.lastData && currentUsername) {
                        const existingByMe = this.lastData.find(c =>
                            c.username && c.username.toLowerCase() === currentUsername.toLowerCase()
                        );
                        if (existingByMe) {
                            resolvedAvatar = existingByMe.avatar || null;
                            resolvedAvatarFile = existingByMe.avatar_file || null;
                        }
                    }

                    if (!resolvedAvatar && !resolvedAvatarFile && currentUsername) {
                        const existingCommentEl = this.container.querySelector(`.comment-author[href="/user/${currentUsername}"]`);
                        if (existingCommentEl) {
                            const avatarImg = existingCommentEl.closest('.comment-body')?.previousElementSibling?.querySelector('img');
                            if (avatarImg) {
                                const src = avatarImg.getAttribute('src') || '';
                                if (src.startsWith('/a/')) resolvedAvatarFile = src.slice(3);
                                else if (src.startsWith('/t/') && src.endsWith('.webp')) resolvedAvatar = src.slice(3, -5);
                            }
                        }
                    }

                    const newComment = {
                        id: json.comment.id,
                        item_id: this.itemId,
                        parent_id: parentId ? parseInt(parentId, 10) : null,
                        content: text,
                        created_at: json.comment.created_at || new Date().toISOString(),
                        username: currentUsername,
                        user_id: session.id || null,
                        display_name: session.display_name || null,
                        avatar: resolvedAvatar,
                        avatar_file: resolvedAvatarFile,
                        username_color: session.username_color || null,
                        is_deleted: false,
                        is_pinned: false,
                        video_time: json.comment.video_time ?? null,
                        replies: [],
                        replyTo: null
                    };

                    // Danmaku: fire immediately (one-shot) + add to future rotation
                    if (window.danmakuInstance) {
                        window.danmakuInstance.fire(
                            text,
                            session.display_name || currentUsername || '?',
                            session.username_color || null
                        );
                        window.danmakuInstance.addItem({
                            content: text,
                            video_time: newComment.video_time ?? null,
                            display_name: session.display_name || currentUsername || '?',
                            username_color: session.username_color || null
                        });
                    }

                    if (!this.lastData) this.lastData = [];
                    if (this.sort === 'new') this.lastData.unshift(newComment);
                    else this.lastData.push(newComment);

                    if (parentId) {
                        const existingReply = document.getElementById('c' + newComment.id);
                        if (existingReply) {
                            requestAnimationFrame(() => {
                                existingReply.classList.add('comment-entering', 'new-item-fade');
                                existingReply.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            });
                        } else {
                            const parentEl = document.getElementById('c' + parentId);
                            if (parentEl) {
                                let repliesEl = parentEl.nextElementSibling;
                                if (!repliesEl || !repliesEl.classList.contains('comment-replies')) {
                                    repliesEl = document.createElement('div');
                                    repliesEl.className = 'comment-replies';
                                    parentEl.insertAdjacentElement('afterend', repliesEl);
                                }
                                const commentHtml = this.renderComment(newComment, this.lastUserId, true);
                                const tmp = document.createElement('div');
                                tmp.innerHTML = commentHtml;
                                const commentEl = tmp.firstElementChild;
                                if (commentEl) {
                                    repliesEl.appendChild(commentEl);
                                    this._ensureTruncationButton(commentEl, newComment.content);
                                    requestAnimationFrame(() => {
                                        commentEl.classList.add('comment-entering', 'new-item-fade');
                                        commentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                    });
                                }
                            }
                        }
                    } else {
                        const existingTop = document.getElementById('c' + newComment.id);
                        if (existingTop) {
                            requestAnimationFrame(() => {
                                existingTop.classList.add('comment-entering', 'new-item-fade');
                                existingTop.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            });
                        } else {
                            const list = this.container.querySelector('.comments-list');
                            if (list) {
                                const commentHtml = this.renderComment(newComment, this.lastUserId, false);
                                const tmp = document.createElement('div');
                                tmp.innerHTML = commentHtml;
                                const commentEl = tmp.firstElementChild;
                                if (commentEl) {
                                    if (this.sort === 'new') {
                                        const scrollNav = list.querySelector('.scroll-nav-wrapper');
                                        if (scrollNav) scrollNav.insertAdjacentElement('afterend', commentEl);
                                        else list.prepend(commentEl);
                                    } else {
                                        list.appendChild(commentEl);
                                    }
                                    this._ensureTruncationButton(commentEl, newComment.content);
                                    requestAnimationFrame(() => {
                                        commentEl.classList.add('comment-entering', 'new-item-fade');
                                        commentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                    });
                                }
                            }
                        }
                    }

                    if (json.is_new_subscription) {
                        if (window.flashMessage) window.flashMessage((window.f0ckI18n && window.f0ckI18n.subscribed_thread) || 'SUBSCRIBED TO THREAD');
                        this.syncSubscribeButton(true);
                    }

                    // Update xD score badge immediately from the POST response —
                    // faster and more reliable than waiting for the SSE NOTIFY.
                    if (typeof json.xd_score === 'number' && typeof window.updateXdBadgeFromScore === 'function') {
                        window.updateXdBadgeFromScore(this.itemId, json.xd_score);
                    }

                    this._silentSync();
                    this._finishSubmit(submitBtn, originalBtnHtml, parentId);
                } else {
                    alert('Error: ' + json.message);
                    this._finishSubmit(submitBtn, originalBtnHtml, parentId);
                }
            } catch (err) {
                console.warn(`[CommentSystem] Submit attempt ${retryCount + 1} failed:`, err);
                if (retryCount < maxRetries) {
                    retryCount++;
                    // Randomized exponential backoff
                    const delay = Math.min(1000 * Math.pow(1.5, retryCount) + (Math.random() * 1000), 10000);
                    _f0ckDebug(`[CommentSystem] Retrying in ${Math.round(delay)}ms...`);
                    setTimeout(attemptSubmit, delay);
                } else {
                    alert('Failed to send comment after multiple attempts. Please check your connection.');
                    this._finishSubmit(submitBtn, originalBtnHtml, parentId);
                }
            }
        };

        attemptSubmit();
    }

    // Defensive: ensure the "show full comment" button is present in a rendered comment
    // element whenever the raw content exceeds ITEM_VIEW_MAX_CHARS. Called after every
    // optimistic DOM insert to guarantee the button regardless of rendering path.
    _ensureTruncationButton(commentEl, rawContent) {
        console.log('[ensureBtn] called, rawContent.length:', rawContent?.length, 'threshold:', CommentSystem.ITEM_VIEW_MAX_CHARS);
        if (!rawContent || rawContent.length <= CommentSystem.ITEM_VIEW_MAX_CHARS) {
            console.log('[ensureBtn] below threshold, skipping');
            return;
        }
        const contentEl = commentEl.querySelector('.comment-content');
        if (!contentEl) { console.log('[ensureBtn] no .comment-content found'); return; }
        if (contentEl.querySelector('.load-full-comment-btn')) {
            console.log('[ensureBtn] button already present');
            return;
        }
        console.log('[ensureBtn] injecting button');
        const btnLabel = (window.f0ckI18n?.sidebar_show_full_comment) || 'show full comment';
        contentEl.insertAdjacentHTML('beforeend',
            `<span class="item-comment-truncated-notice"><button class="load-full-comment-btn" type="button">${btnLabel}</button></span>`
        );
        contentEl.dataset.raw = rawContent;
        console.log('[ensureBtn] done, button in DOM:', !!contentEl.querySelector('.load-full-comment-btn'));
    }

    _finishSubmit(btn, originalHtml, parentId) {
        if (btn) {
            btn.classList.remove('loading');
            btn.innerHTML = originalHtml;
        }
        if (parentId) {
            this.pendingSubmissions.delete(parentId);
        } else {
            this.isMainSubmitting = false;
        }
    }


    // Silently fetch fresh comment data from the server and update lastData
    // without touching the DOM — used after optimistic inserts to stay in sync.
    async _silentSync() {
        if (!this.itemId) return;
        try {
            const res = await fetch(`/api/comments/${this.itemId}?sort=${this.sort}`);
            const data = await res.json();
            if (data.success) {
                this.lastData = data.comments;
                this.lastUserId = data.user_id;
                this.lastIsSubscribed = data.is_subscribed;
                if (data.is_admin !== undefined) this.isAdmin = data.is_admin;
                if (data.is_locked !== undefined) this.isLocked = data.is_locked;
            }
        } catch (e) {
            // Non-critical: local cache may be slightly stale until next full refresh
            console.warn('[CommentSystem] Silent sync failed:', e);
        }
    }

    setupGlobalListeners() {
        if (CommentSystem.globalListenersAttached) return;
        CommentSystem.globalListenersAttached = true;

        // Refresh comments when the tab becomes visible again (e.g. switching back from another tab).
        // This handles cases where SSE events were missed while the tab was backgrounded,
        // and covers guests where NotificationSystem (which also does this) is absent.
        // Guard: ensure the current commentSystem's container is still in the live DOM
        // (avoids writing to detached nodes left behind by PJAX navigation).
        // Skip if the user is actively typing to avoid clobbering their draft.
        // Note: The visibility listener was moved to f0ckm.js NotificationSystem to centralize
        // tab-activation polling and avoid redundant network requests.

        window.addEventListener('hashchange', () => {
            if (window.commentSystem && location.hash && location.hash.startsWith('#c')) {
                const id = location.hash.substring(2);
                window.commentSystem.scrollToComment(id);
            }
        });

        window.addEventListener('f0ck:emojis_updated', () => {
            const cs = window.commentSystem;
            if (!cs) return;
            CommentSystem.emojiCache = null;
            CommentSystem.loadingEmojis = false;
            cs.loadEmojis();
        });

        // Shortcut 'c' to toggle comments
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
            const tag = e.target.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

            if (e.key.toLowerCase() === 'c') {
                if (window.commentSystem) window.commentSystem.toggleComments();
            }
        });

        // Ctrl+. — focus the comment input
        document.addEventListener('keydown', (e) => {
            if (!e.ctrlKey || e.altKey || e.metaKey) return;
            if (e.key !== '.') return;

            const cs = window.commentSystem;
            if (!cs || !cs.container) return;

            e.preventDefault();

            // If comments are hidden, show them first
            const isHidden = cs.container.classList.contains('faded-out') || cs.container.style.display === 'none';
            if (isHidden) cs.toggleComments();

            // Legacy layout: comments are in the normal page flow under .item-main-content
            // Modern layout: comments are in a fixed-height sidebar column
            const isLegacyLayout = !!cs.container.closest('.item-main-content');

            // Wait a tick so the container is visible before trying to focus
            setTimeout(() => {
                const textarea = cs.container.querySelector('.main-input textarea');
                if (textarea) {
                    // In legacy layout, scroll page to bottom first so the box is fully visible
                    if (isLegacyLayout) {
                        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                    }
                    textarea.focus();
                    if (!isLegacyLayout) {
                        textarea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                }
            }, isHidden ? 320 : 0); // 320ms matches the CSS fade-in transition
        });

        // Global subscribe button listener
        document.addEventListener('click', async (e) => {
            const subBtn = e.target.closest('#subscribe-btn');
            if (subBtn) {
                e.preventDefault();
                if (subBtn.style.opacity === '0.5') return;

                const itemId = subBtn.dataset.itemId || (window.commentSystem ? window.commentSystem.itemId : null);
                if (!itemId) return;

                subBtn.style.opacity = '0.5';
                try {
                    const res = await fetch(`/api/subscribe/${itemId}`, {
                        method: 'POST',
                        headers: { 'X-CSRF-Token': window.f0ckSession?.csrf_token }
                    });
                    const json = await res.json();
                    if (json.success && window.commentSystem) {
                        window.commentSystem.syncSubscribeButton(json.subscribed);
                        window.flashMessage((window.f0ckI18n && (json.subscribed ? window.f0ckI18n.subscribed_thread : window.f0ckI18n.unsubscribed_thread)) || (json.subscribed ? 'SUBSCRIBED TO THREAD' : 'UNSUBSCRIBED FROM THREAD'));
                    } else if (!json.success) {
                        alert('Failed to toggle subscription');
                    }
                } catch (e) {
                    console.error(e);
                } finally {
                    subBtn.style.opacity = '1';
                }
            }
        });
    }

    toggleComments() {
        if (!this.container) return;

        const layout = this.container.closest('.item-layout-container');

        // Check if currently hidden (or fading out)
        const isHidden = this.container.classList.contains('faded-out') || this.container.style.display === 'none';

        if (isHidden) {
            // SHOW
            this.container.style.display = 'block';
            if (layout) layout.classList.remove('sidebar-hidden');
            localStorage.setItem('comments_hidden', 'false');
            // Force reflow to enable transition
            void this.container.offsetWidth;
            this.container.classList.remove('faded-out');
        } else {
            // HIDE
            localStorage.setItem('comments_hidden', 'true');
            this.container.classList.add('faded-out');
            if (layout) layout.classList.add('sidebar-hidden');
            // Wait for transition, then set display none
            setTimeout(() => {
                if (this.container.classList.contains('faded-out')) {
                    this.container.style.display = 'none';
                }
            }, 300);
        }
    }



    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }



    setupEmojiPicker(container) {
        const textarea = container.querySelector('textarea');
        if (!textarea) return;
        if (container.querySelector('.emoji-trigger')) return;

        // Attach mentions
        if (window.MentionAutocomplete) window.MentionAutocomplete.attach(textarea);

        // ── Inline emoji autocomplete ─────────────────────────────────────────
        // Portaled to <body> so it escapes parent stacking contexts (overflow,
        // z-index scopes) and always renders on top of tags/badges.
        const autocomplete = document.createElement('div');
        autocomplete.className = 'emoji-autocomplete';
        autocomplete.style.display = 'none';
        autocomplete.style.overscrollBehavior = 'contain';
        document.body.appendChild(autocomplete);

        let acActiveIdx = -1;
        let acMatches = [];
        let acDisplayedCount = 0;
        const BATCH_SIZE = 20;

        const positionAC = () => {
            const rect = textarea.getBoundingClientRect();
            autocomplete.style.position = 'fixed';
            autocomplete.style.left = rect.left + 'px';
            autocomplete.style.width = rect.width + 'px';
            // layout-modern: input is near the top of the sidebar → open downward
            if (document.body.classList.contains('layout-modern')) {
                autocomplete.style.top = rect.bottom + 'px';
                autocomplete.style.bottom = 'auto';
            } else {
                autocomplete.style.bottom = (window.innerHeight - rect.top) + 'px';
                autocomplete.style.top = 'auto';
            }
        };

        const hideAC = () => {
            autocomplete.style.display = 'none';
            autocomplete.innerHTML = '';
            acActiveIdx = -1;
            acMatches = [];
            acDisplayedCount = 0;
        };

        const getColon = () => {
            const pos = textarea.selectionStart;
            const text = textarea.value.slice(0, pos);
            const match = text.match(/:([a-z0-9_]{0,})$/i);
            if (!match) return null;
            return { query: match[1].toLowerCase(), colonPos: pos - match[0].length };
        };

        const appendMoreItems = () => {
            if (acDisplayedCount >= acMatches.length) return;
            const nextBatch = acMatches.slice(acDisplayedCount, acDisplayedCount + BATCH_SIZE);
            nextBatch.forEach((name, i) => {
                const idx = acDisplayedCount + i;
                const item = document.createElement('div');
                item.className = 'emoji-ac-item';
                item.dataset.idx = idx;
                const img = document.createElement('img');
                img.src = this.customEmojis[name];
                img.alt = name;
                img.loading = 'lazy';
                const label = document.createElement('span');
                label.textContent = `:${name}:`;
                item.appendChild(img);
                item.appendChild(label);
                item.addEventListener('mousedown', ev => {
                    ev.preventDefault(); // don't blur textarea
                    insertEmoji(name);
                });
                autocomplete.appendChild(item);
            });
            acDisplayedCount += nextBatch.length;
        };

        const renderAC = () => {
            const hit = getColon();
            if (!hit || !this.customEmojis) return hideAC();
            const { query } = hit;
            acMatches = Object.keys(this.customEmojis).filter(n => n.includes(query));
            if (!acMatches.length) return hideAC();

            autocomplete.innerHTML = '';
            acActiveIdx = -1;
            acDisplayedCount = 0;
            appendMoreItems(); // Initial batch

            positionAC();
            autocomplete.style.display = 'flex';
        };

        const setActive = (idx) => {
            const items = autocomplete.querySelectorAll('.emoji-ac-item');
            items.forEach(el => el.classList.remove('active'));
            if (idx >= 0 && idx < items.length) {
                items[idx].classList.add('active');
                items[idx].scrollIntoView({ block: 'nearest' });
            }
            acActiveIdx = idx;
        };

        const insertEmoji = (name) => {
            const hit = getColon();
            if (!hit) return;
            const before = textarea.value.slice(0, hit.colonPos);
            const after = textarea.value.slice(textarea.selectionStart);
            const insert = `:${name}:`;
            textarea.value = before + insert + after;
            const newPos = hit.colonPos + insert.length;
            textarea.setSelectionRange(newPos, newPos);
            textarea.focus();
            hideAC();
        };

        textarea.addEventListener('input', () => renderAC());
        textarea.addEventListener('keydown', (e) => {
            if (autocomplete.style.display === 'none') return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                // Load more if we are at the end of current displayed items
                if (acActiveIdx === acDisplayedCount - 1 && acDisplayedCount < acMatches.length) {
                    appendMoreItems();
                }
                const nextIdx = (acActiveIdx + 1) % acMatches.length;
                setActive(nextIdx);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const nextIdx = (acActiveIdx <= 0) ? acMatches.length - 1 : acActiveIdx - 1;
                // If jumping to the end, we must load everything (or enough)
                if (nextIdx > acDisplayedCount - 1) {
                    while (acDisplayedCount < acMatches.length) appendMoreItems();
                }
                setActive(nextIdx);
            } else if ((e.key === 'Enter' || e.key === 'Tab') && acActiveIdx >= 0) {
                e.preventDefault();
                insertEmoji(acMatches[acActiveIdx]);
            } else if (e.key === 'Escape') {
                hideAC();
            }
        });

        // Lazy load on scroll
        autocomplete.addEventListener('scroll', () => {
            const threshold = 50;
            if (autocomplete.scrollHeight - autocomplete.scrollTop - autocomplete.clientHeight < threshold) {
                appendMoreItems();
            }
        });

        // Delay so mousedown on an item fires before blur removes the dropdown
        textarea.addEventListener('blur', () => setTimeout(hideAC, 150));
        textarea.addEventListener('click', () => { if (getColon()) renderAC(); });

        // Reposition when textarea is resized (user drags handle) or window resizes
        const ro = new ResizeObserver(() => {
            if (autocomplete.style.display !== 'none') positionAC();
        });
        ro.observe(textarea);
        const onWinResize = () => { if (autocomplete.style.display !== 'none') positionAC(); };
        window.addEventListener('resize', onWinResize);

        // Clean up portal element when this comment system is destroyed
        const _origDestroy = this.destroy?.bind(this);
        this.destroy = () => {
            if (typeof _origDestroy === 'function') _origDestroy();
            if (autocomplete && autocomplete.parentNode) autocomplete.parentNode.removeChild(autocomplete);
            window.removeEventListener('resize', onWinResize);
            ro.disconnect();
        };

        const trigger = document.createElement('button');
        trigger.innerHTML = '<i class="fa-regular fa-face-smile"></i>';
        trigger.className = 'emoji-trigger';

        const actions = container.querySelector('.input-actions');
        if (actions) {
            // Add spoiler button
            const spoilerBtn = document.createElement('button');
            spoilerBtn.innerText = '[S]';
            spoilerBtn.className = 'spoiler-trigger';
            spoilerBtn.title = 'Insert spoiler tag';
            spoilerBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const val = textarea.value;
                const selected = val.substring(start, end);

                if (selected) {
                    const tagStart = '[spoiler]';
                    const tagEnd = '[/spoiler]';
                    textarea.value = val.substring(0, start) + tagStart + selected + tagEnd + val.substring(end);
                    const newPos = start + tagStart.length + selected.length + tagEnd.length;
                    textarea.setSelectionRange(newPos, newPos);
                } else {
                    const tagStart = '[spoiler]';
                    textarea.value = val.substring(0, start) + '[spoiler][/spoiler]' + val.substring(start);
                    const newPos = start + tagStart.length;
                    textarea.setSelectionRange(newPos, newPos);
                }
                textarea.focus();
            });
            const referenceNode = actions.querySelector('.cancel-reply') ||
                actions.querySelector('.cancel-edit-btn') ||
                actions.querySelector('.submit-comment') ||
                actions.querySelector('.save-edit-btn');
            actions.insertBefore(trigger, referenceNode);
            actions.insertBefore(spoilerBtn, trigger);
            if (this.isAdmin) {
                const lockBtn = document.createElement('button');
                lockBtn.id = 'lock-thread-btn';
                lockBtn.title = this.isLocked ? 'Unlock Thread' : 'Lock Thread';
                lockBtn.innerHTML = this.isLocked ? this.icons.lock : this.icons.unlock;
                lockBtn.className = 'admin-lock-btn';
                actions.insertBefore(lockBtn, spoilerBtn);
            }

            // Create picker once and cache it
            let picker = null;
            let closeHandler = null;

            trigger.addEventListener('click', (e) => {
                e.preventDefault();

                // If picker already exists, toggle visibility
                if (picker) {
                    const isVisible = picker.style.display !== 'none';
                    if (isVisible) {
                        picker.style.display = 'none';
                        if (closeHandler) {
                            document.removeEventListener('click', closeHandler);
                            closeHandler = null;
                        }
                    } else {
                        picker.style.display = ''; // Reset to CSS default (flex)
                        requestAnimationFrame(() => picker.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
                        closeHandler = (ev) => {
                            if (!picker.contains(ev.target) && ev.target !== trigger) {
                                picker.style.display = 'none';
                                document.removeEventListener('click', closeHandler);
                                closeHandler = null;
                            }
                        };
                        setTimeout(() => document.addEventListener('click', closeHandler), 0);
                    }
                    return;
                }

                // Create picker only once
                picker = document.createElement('div');
                picker.className = 'emoji-picker';

                if (this.customEmojis && Object.keys(this.customEmojis).length > 0) {
                    Object.keys(this.customEmojis).forEach(name => {
                        const url = this.customEmojis[name];
                        const img = document.createElement('img');
                        img.src = url;
                        img.title = `:${name}:`;
                        img.loading = 'lazy'; // Use native lazy loading

                        // Add error handling for failed loads
                        img.onerror = () => {
                            console.warn(`Failed to load emoji: ${name}`);
                            img.style.display = 'none';
                        };

                        img.onclick = (ev) => {
                            ev.stopPropagation();
                            const pos = textarea.selectionStart ?? textarea.value.length;
                            const val = textarea.value;
                            textarea.value = val.slice(0, pos) + `:${name}:` + val.slice(pos);
                            textarea.focus();
                            // Move cursor after the inserted emoji
                            const newPos = pos + name.length + 2;
                            textarea.setSelectionRange(newPos, newPos);
                        };
                        picker.appendChild(img);
                    });
                } else {
                    picker.innerHTML = '<div style="padding:5px;color:white;font-size:0.8em;">No emojis found</div>';
                }

                container.appendChild(picker);
                requestAnimationFrame(() => picker.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));

                // Set up close handler
                // Set up close handler
                closeHandler = (ev) => {
                    if (!picker.contains(ev.target) && ev.target !== trigger) {
                        picker.style.display = 'none';
                        document.removeEventListener('click', closeHandler);
                        closeHandler = null;
                    }
                };
                setTimeout(() => document.addEventListener('click', closeHandler), 0);
            });
        }
    }
}

// Initial load
window.commentSystem = new CommentSystem();

// Re-init on navigation
document.addEventListener('f0ck:contentLoaded', () => {
    if (window.commentSystem && typeof window.commentSystem.destroy === 'function') {
        window.commentSystem.destroy();
    }
    window.commentSystem = new CommentSystem();
});

// If f0ck.js uses custom navigation without valid events, we might need MutationObserver or hook into `getContent`
// Looking at f0ck.js, it seems to just replace innerHTML.
