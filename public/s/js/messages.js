/**
 * messages.js — End-to-End Encrypted Private Messaging
 *
 * Encryption: ECDH P-256 key exchange → AES-GCM message encryption
 * Key storage: localStorage (private key as JWK)
 * Key backup: PBKDF2-wrapped export file (.f0ckkey) for multi-device support
 * Everything runs in the browser; the server only sees ciphertext.
 *
 * INIT GUARD: this IIFE checks window.__dmLoaded to prevent double-init
 * when the script is accidentally loaded twice (e.g. during development).
 */

if (window.__dmLoaded) {
    console.warn('[DM] messages.js already loaded — skipping duplicate init');
} else {
    window.__dmLoaded = true;

(function () {
    'use strict';

    const DM_KEY_NAME      = 'f0ck_dm_privkey';
    const DM_PUBKEY_NAME  = 'f0ck_dm_pubkey';
    const DM_KEY_VERSION  = 'f0ck_dm_keyver';
    const CURRENT_VERSION = 3; // v3 = force-wipe all pre-vault localStorage keys

    // ─────────────────────────────────────────────────────────────────────────
    // Crypto helpers
    // ─────────────────────────────────────────────────────────────────────────

    const subtle = crypto.subtle;

    async function generateKeyPair() {
        return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    }

    async function exportKey(key) {
        return JSON.stringify(await subtle.exportKey('jwk', key));
    }

    async function importPublicKey(jwkString) {
        return subtle.importKey('jwk', typeof jwkString === 'string' ? JSON.parse(jwkString) : jwkString, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    }

    async function importPrivateKey(jwkString) {
        return subtle.importKey('jwk', typeof jwkString === 'string' ? JSON.parse(jwkString) : jwkString, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    }

    async function deriveSharedKey(privateKey, theirPublicKey) {
        return subtle.deriveKey({ name: 'ECDH', public: theirPublicKey }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    async function encryptMessage(sharedKey, plaintext) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const buf = await subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, new TextEncoder().encode(plaintext));
        return { ciphertext: toB64u(buf), iv: toB64u(iv) };
    }

    async function decryptMessage(sharedKey, ciphertext, iv) {
        const buf = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(iv) }, sharedKey, fromB64u(ciphertext));
        return new TextDecoder().decode(buf);
    }

    // ── Seed-phrase vault crypto ───────────────────────────────────────────────

    function generateMnemonic() {
        const list = window.DM_WORDLIST;
        if (!list || list.length < 2) throw new Error('Wordlist not loaded');
        const indices = new Uint32Array(12);
        crypto.getRandomValues(indices);
        return Array.from(indices).map(i => list[i % list.length]);
    }

    async function deriveWrapKey(mnemonic, saltBytes, usage) {
        const enc = new TextEncoder();
        const base = await subtle.importKey('raw', enc.encode(mnemonic.join(' ')), 'PBKDF2', false, ['deriveKey']);
        return subtle.deriveKey(
            { name: 'PBKDF2', salt: saltBytes, iterations: 600000, hash: 'SHA-256' },
            base,
            { name: 'AES-GCM', length: 256 },
            false,
            [usage]
        );
    }

    async function encryptPrivkeyForVault(privkeyJwk, mnemonic) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv   = crypto.getRandomValues(new Uint8Array(12));
        const wrapKey = await deriveWrapKey(mnemonic, salt, 'encrypt');
        const cipher  = await subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, new TextEncoder().encode(privkeyJwk));
        return { salt: toB64u(salt), iv: toB64u(iv), ciphertext: toB64u(cipher) };
    }

    async function decryptPrivkeyFromVault(vault, mnemonic) {
        const saltBytes = new Uint8Array(fromB64u(vault.salt));
        const wrapKey   = await deriveWrapKey(mnemonic, saltBytes, 'decrypt');
        const plain     = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(vault.iv) }, wrapKey, fromB64u(vault.ciphertext));
        return new TextDecoder().decode(plain);
    }

    // ── base64url ─────────────────────────────────────────────────────────────

    function toB64u(buf) {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        let s = ''; for (const b of u8) s += String.fromCharCode(b);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }
    function fromB64u(s) {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(b64); const buf = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
        return buf.buffer;
    }

    async function sha256Hex(str) {
        const buf = await subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Key management
    // ─────────────────────────────────────────────────────────────────────────

    let _privateKey   = null;
    let _publicKeyJwk = null;

    /**
     * Load key from localStorage (v2 only).
     * Returns: 'local' | 'vault' | 'new'
     *   'local' — key is ready in memory
     *   'vault' — server has a vault blob, caller must show recovery modal
     *   'new'   — no key anywhere, fresh pair generated, caller must show setup modal
     */
    async function loadOrCreateKeyPair() {
        // ── Version gate: wipe any pre-v2 key material ──────────────────────
        const ver = parseInt(localStorage.getItem(DM_KEY_VERSION) || '0', 10);
        if (ver < CURRENT_VERSION) {
            localStorage.removeItem(DM_KEY_NAME);
            localStorage.removeItem(DM_PUBKEY_NAME);
            localStorage.removeItem(DM_KEY_VERSION);
        }

        // ── Try localStorage first (fast path) ──────────────────────────────
        const storedPriv = localStorage.getItem(DM_KEY_NAME);
        const storedPub  = localStorage.getItem(DM_PUBKEY_NAME);
        if (storedPriv && storedPub) {
            try {
                _privateKey   = await importPrivateKey(storedPriv);
                _publicKeyJwk = storedPub;
                return 'local';
            } catch {
                localStorage.removeItem(DM_KEY_NAME);
                localStorage.removeItem(DM_PUBKEY_NAME);
            }
        }

        // ── Check server vault ───────────────────────────────────────────────
        try {
            const vdata = await dmFetch('GET', '/api/dm/keyvault');
            if (vdata.success && vdata.vault) return 'vault';
        } catch { /* offline or no vault */ }

        // ── Generate fresh key pair ──────────────────────────────────────────
        const pair    = await generateKeyPair();
        const privJwk = await exportKey(pair.privateKey);
        const pubJwk  = await exportKey(pair.publicKey);
        localStorage.setItem(DM_KEY_NAME, privJwk);
        localStorage.setItem(DM_PUBKEY_NAME, pubJwk);
        localStorage.setItem(DM_KEY_VERSION, String(CURRENT_VERSION));
        _privateKey   = pair.privateKey;
        _publicKeyJwk = pubJwk;
        return 'new';
    }

    async function uploadPublicKey() {
        if (!_publicKeyJwk) return;
        const fingerprint = await sha256Hex(_publicKeyJwk);
        await dmFetch('POST', '/api/dm/pubkey', { pubkey: _publicKeyJwk, fingerprint });
    }

    /** Store key in localStorage from a raw JWK string (after vault recovery). */
    async function storeKeyFromJwk(privJwk) {
        const privObj = JSON.parse(privJwk);
        const pubJwk  = JSON.stringify({ kty: privObj.kty, crv: privObj.crv, x: privObj.x, y: privObj.y, key_ops: [], ext: true });
        _privateKey   = await importPrivateKey(privJwk);
        _publicKeyJwk = pubJwk;
        localStorage.setItem(DM_KEY_NAME, privJwk);
        localStorage.setItem(DM_PUBKEY_NAME, pubJwk);
        localStorage.setItem(DM_KEY_VERSION, String(CURRENT_VERSION));
        pubkeyCache.clear();
    }

    function hasKey() { return _privateKey !== null; }

    // ─────────────────────────────────────────────────────────────────────────
    // API helpers
    // ─────────────────────────────────────────────────────────────────────────

    const csrfToken = () => window.f0ckSession?.csrf_token || '';

    async function dmFetch(method, url, body = null) {
        const opts = { method, headers: { 'X-CSRF-Token': csrfToken() } };
        if (body && method !== 'GET') {
            opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            opts.body = new URLSearchParams(body).toString();
        }
        const res = await fetch(url, opts);
        return res.json();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public key cache
    // ─────────────────────────────────────────────────────────────────────────

    const pubkeyCache = new Map(); // userId → CryptoKey (public)

    async function getRemotePublicKey(userId) {
        if (pubkeyCache.has(userId)) return pubkeyCache.get(userId);
        const data = await dmFetch('GET', `/api/dm/pubkey/${userId}`);
        if (!data.success) return null; // null = no key yet
        const key = await importPublicKey(data.pubkey);
        pubkeyCache.set(userId, key);
        return key;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Inbox Page
    // ─────────────────────────────────────────────────────────────────────────

    async function initInbox() {
        const container = document.getElementById('dm-inbox-list');
        if (!container) return;
        await renderInbox(container);
    }

    async function renderInbox(container) {
        container.innerHTML = '<div class="dm-loading">Loading conversations…</div>';
        try {
            const data = await dmFetch('GET', '/api/dm/conversations');
            if (!data.success || !data.conversations.length) {
                container.innerHTML = '<div class="dm-empty">No conversations yet.<br><span style="font-size:0.85em;color:#888;">Visit a user profile and click "✉ Message" to start one.</span></div>';
                return;
            }
            container.innerHTML = '';
            for (const c of data.conversations) container.appendChild(buildConvoCard(c));
        } catch (e) {
            container.innerHTML = `<div class="dm-error">Failed to load: ${escHtml(e.message)}</div>`;
        }
    }

    function buildConvoCard(c) {
        const el  = document.createElement('a');
        el.href   = `/messages/${encodeURIComponent(c.username.toLowerCase())}`;
        const unread = Number(c.unread_count) || 0;
        el.className = 'dm-convo-card' + (unread > 0 ? ' dm-convo-unread' : '');
        el.dataset.userId = c.user_id;
        const avatarSrc = c.avatar_file ? `/a/${c.avatar_file}` : (c.avatar ? `/t/${c.avatar}.webp` : '/a/default.png');
        const color = c.username_color ? `color:${escHtml(c.username_color)}` : '';
        el.innerHTML = `
            <img class="dm-convo-avatar" src="${escHtml(avatarSrc)}" alt="" onerror="this.src='/a/default.png'">
            <div class="dm-convo-info">
                <span class="dm-convo-name" style="${color}">${escHtml(c.display_name || c.username)}</span>
                <span class="dm-convo-time" data-ts="${escHtml(c.last_message_at)}">${escHtml(timeAgo(c.last_message_at))}</span>
            </div>
            ${unread > 0 ? `<span class="dm-convo-badge">${unread}</span>` : ''}
            <button class="dm-convo-delete" title="Delete conversation" data-id="${c.user_id}">×</button>
        `;

        el.querySelector('.dm-convo-delete').onclick = async (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!confirm(`Close conversation with ${c.username}? History will be preserved.`)) return;
            const res = await dmFetch('POST', `/api/dm/conversation/${c.user_id}/delete`);
            if (res.success) el.remove();
        };

        // When the user explicitly clicks an unread conversation card,
        // mark it as read immediately and sync the navbar badge.
        // This is the intentional "I'm reading this" action — we do NOT
        // auto-mark on thread load so the badge persists until they choose to open it.
        if (unread > 0) {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.dm-convo-delete')) return; // let delete handler handle it
                dmFetch('POST', `/api/dm/read/${c.user_id}`)
                    .then(() => refreshDmBadge())
                    .catch(() => {});
                // Optimistically remove the unread indicator on this card
                el.classList.remove('dm-convo-unread');
                const badge = el.querySelector('.dm-convo-badge');
                if (badge) badge.remove();
            });
        }

        return el;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Conversation / Thread Page
    // ─────────────────────────────────────────────────────────────────────────

    let currentOtherId   = null;
    let currentOtherPubKey = null; // CryptoKey or null (if recipient has no key yet)
    let myId             = null;
    let latestMsgId      = 0;
    let oldestMsgId      = null;
    let threadHasMore    = false;
    const renderedIds    = new Set();
    let threadMessages   = []; // Cache for re-rendering (e.g. emojis)

    // Title management — global across all pages
    let _dmTitleCount  = 0;

    function applyDmTitleBadge() {
        const stripped = document.title.replace(/^\[\d+\]\s*/, '');
        document.title = _dmTitleCount > 0 ? `[${_dmTitleCount}] ${stripped}` : stripped;
    }

    // Re-apply prefix after SPA navigation changes the title (poll is safe, observer causes loops)
    setInterval(() => {
        if (_dmTitleCount > 0 && !document.title.match(/^\[\d+\]/)) applyDmTitleBadge();
    }, 1000);



    async function initConversation() {
        const thread = document.getElementById('dm-thread');
        if (!thread) return;

        currentOtherId  = parseInt(thread.dataset.otherId, 10);
        myId            = parseInt(thread.dataset.myId,    10);

        // Update page title to reflect the conversation
        const otherName = thread.dataset.otherName || '';
        document.title  = otherName ? `DM with ${otherName}` : 'Messages';
        applyDmTitleBadge(); // Re-apply any pending [N] prefix

        // Try to get recipient's key — but don't block if they don't have one yet
        currentOtherPubKey = await getRemotePublicKey(currentOtherId);

        if (!currentOtherPubKey) {
            // Recipient has no key — clearly block sending
            const notice = document.getElementById('dm-key-notice');
            if (notice) {
                notice.style.display = 'flex';
                notice.innerHTML = '⚠️ This user hasn\'t set up their encryption key yet. ';
            }
            // Disable the send form so nothing can be submitted
            const input = document.getElementById('dm-input');
            const btn   = document.getElementById('dm-send-btn');
            if (input) { input.disabled = true; input.placeholder = 'Waiting for recipient to set up encryption…'; }
            if (btn)   { btn.disabled = true; }
        }

        // Pre-fetch emojis so :name: syntax renders correctly even on first /messages load.
        // This mirrors CommentSystem.loadEmojis() but works without a comment system instance.
        (async () => {
            if ((typeof CommentSystem !== 'undefined' && CommentSystem.emojiCache)
                || window.commentSystem?.customEmojis) {
                // Already loaded — dispatch so the re-render handler can fire if needed
                const cached = (typeof CommentSystem !== 'undefined' && CommentSystem.emojiCache)
                             || window.commentSystem.customEmojis;
                window.dispatchEvent(new CustomEvent('f0ck:emojis_ready', { detail: cached }));
                return;
            }
            try {
                const res  = await fetch('/api/v2/emojis');
                const data = await res.json();
                if (data.success && data.emojis?.length) {
                    const map = {};
                    data.emojis.forEach(e => { map[e.name] = e.url; });
                    if (typeof CommentSystem !== 'undefined') CommentSystem.emojiCache = map;
                    window.dispatchEvent(new CustomEvent('f0ck:emojis_ready', { detail: map }));
                }
            } catch { /* non-critical — emojis can fall back to :name: text */ }
        })();

        await loadThread(thread, false);
        setupDmEmojiPicker();
        setupSendForm();

        // Live timestamp ticker — clear any previous one and start fresh
        if (window._dmTimestampTicker) clearInterval(window._dmTimestampTicker);
        const tickTimestamps = () =>
            document.querySelectorAll('[data-ts]').forEach(el =>
                (el.textContent = timeAgo(el.dataset.ts)));
        tickTimestamps(); // Run immediately so values are fresh
        window._dmTimestampTicker = setInterval(tickTimestamps, 10_000);
    }

    async function loadThread(thread, prepend = false) {
        const url = prepend
            ? `/api/dm/thread/${currentOtherId}?before=${oldestMsgId}`
            : `/api/dm/thread/${currentOtherId}`;

        const data = await dmFetch('GET', url);
        if (!data.success) { thread.innerHTML = `<div class="dm-error">${escHtml(data.msg || 'Failed to load messages')}</div>`; return; }

        threadHasMore = data.hasMore;

        if (!data.messages.length) {
            if (!prepend) thread.innerHTML = '<div class="dm-empty" style="margin:auto;">No messages yet.</div>';
            return;
        }

        const decrypted = await decryptBatch(data.messages);
        if (!prepend) {
            thread.innerHTML = '';
        }

        const prevHeight = thread.scrollHeight;

        for (const m of decrypted) {
            if (renderedIds.has(m.id)) continue;
            renderedIds.add(m.id);
            if (prepend) {
                threadMessages.unshift(m);
            } else {
                threadMessages.push(m);
            }

            if (m.id > latestMsgId) latestMsgId = m.id;
            if (oldestMsgId === null || m.id < oldestMsgId) oldestMsgId = m.id;

            if (prepend) {
                thread.insertBefore(buildMessageBubble(m), thread.firstChild);
            } else {
                thread.appendChild(buildMessageBubble(m));
            }
        }

        if (prepend) {
            // Maintain scroll position when loading older history
            thread.scrollTop = thread.scrollHeight - prevHeight;
        } else {
            // Initial load: jump to most recent message
            snapToBottom(thread, true);
            snapToBottomSticky(thread, 1200);
        }
    }

    /**
     * Fetch messages newer than latestMsgId and append them.
     * Called when we receive an SSE 'dm:incoming' event.
     */
    async function appendNewMessages(thread) {
        if (!latestMsgId) { await loadThread(thread, false); return; }

        const data = await dmFetch('GET', `/api/dm/thread/${currentOtherId}?after=${latestMsgId}`);
        if (!data.success || !data.messages.length) return;

        const decrypted = await decryptBatch(data.messages);
        let appended = false;

        for (const m of decrypted) {
            if (renderedIds.has(m.id)) continue;
            renderedIds.add(m.id);
            threadMessages.push(m);
            if (m.id > latestMsgId) latestMsgId = m.id;
            thread.appendChild(buildMessageBubble(m));
            appended = true;
        }

        if (appended) snapToBottom(thread); // Soft scroll (only if near bottom)
    }

    async function decryptBatch(messages) {
        if (!messages.length) return [];
        if (!currentOtherPubKey) return messages.map(m => ({ ...m, plaintext: null }));

        // Derive shared key ONCE for the whole batch — ECDH is expensive, don't repeat per message
        let sharedKey;
        try {
            sharedKey = await deriveSharedKey(_privateKey, currentOtherPubKey);
        } catch (e) {
            return messages.map(m => ({ ...m, plaintext: null }));
        }

        const result = [];
        for (const m of messages) {
            try {
                const plaintext = await decryptMessage(sharedKey, m.ciphertext, m.iv);
                result.push({ ...m, plaintext });
            } catch (e) {
                result.push({ ...m, plaintext: null });
            }
        }
        return result;
    }

    function renderDmEmojis(text) {
        // Prefer instance cache (comment system active on this page),
        // then fall back to the static class cache (populated by the DM picker fetch).
        const emojis = window.commentSystem?.customEmojis
                    || (typeof CommentSystem !== 'undefined' && CommentSystem.emojiCache)
                    || null;
        if (!emojis || !Object.keys(emojis).length) return text;
        return text.replace(/:([a-z0-9_]+):/g, (match, name) => {
            const url = emojis[name];
            if (!url) return match;
            return `<img src="${url}" class="emoji" alt="${match}" title="${match}" loading="lazy">`;
        });
    }

    function renderDmContent(plaintext) {
        if (!plaintext) return '';

        // Anti-recursion / Performance safeguard for extremely long messages
        if (plaintext.length > 50000) {
            console.warn('[DM] Message too long, skipping markdown');
            return `<pre style="white-space: pre-wrap; font-family: inherit; margin: 0; padding: 0; background: none; border: none; font-size: inherit; color: inherit;">${escHtml(plaintext)}</pre>`;
        }

        const cs = window.commentSystem;
        if (cs && typeof cs.renderCommentContent === 'function') {
            return cs.renderCommentContent(plaintext);
        }

        if (typeof marked === 'undefined') {
            return renderDmEmojis(escHtml(plaintext));
        }

        try {
            // 1. Pre-normalize: If the line is JUST a YouTube URL, wrap it in a markdown link
            let normalized = plaintext.split('\n').map(line => {
                const trimmed = line.trim();
                const ytMatch = trimmed.match(/^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^\s<"]*&)?v=|youtu\.be\/)([a-zA-Z0-9_\-]{11})[^\s<"]*$/);
                if (ytMatch) return `[${trimmed}](${trimmed})`;
                return line;
            }).join('\n');

            // 2. Initial escaping using native method. Restore > for markdown markers.
            let escaped = escHtml(normalized).replace(/&gt;/g, ">");

            // 3. Mentions
            const mentionRegex = /(?<!\[)@([a-zA-Z0-9_\-\.]+)(?!\])|\[@([^\]]+)\]/g;

            const siteOrigin = window.location.origin;
            const renderer = new marked.Renderer();

            // 4. Link renderer
            renderer.link = function (href, title, text) {
                if (typeof href === 'object' && href !== null) {
                    title = href.title; text = href.text || text; href = href.href;
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

                if (href.startsWith(siteOrigin) || (href.startsWith('/') && !href.startsWith('//'))) {
                    isSameSite = true;
                } else {
                    try {
                        const urlToParse = href.startsWith('//') ? window.location.protocol + href : href;
                        const urlObj = new URL(urlToParse, siteOrigin);
                        isSameSite = (urlObj.hostname === window.location.hostname);
                    } catch(e) {}
                }

                // Shorten internal links if text matches the URL
                let displayText = text;
                if (isSameSite && (text === href || text === href.replace(/^https?:\/\//, '') || text === href.replace(siteOrigin, ''))) {
                    try {
                        const urlToParse = href.startsWith('//') ? window.location.protocol + href : href;
                        const url = new URL(urlToParse.startsWith('http') ? urlToParse : siteOrigin + (urlToParse.startsWith('/') ? '' : '/') + urlToParse);
                        displayText = url.pathname + url.search + url.hash;
                    } catch (e) {
                         // silently fall back if parsing fails
                    }
                }

                const isMention = href.startsWith('/user/') && text.startsWith('@');
                if (isExternal && !isSameSite) {
                    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${displayText}<i class="fa-solid fa-arrow-up-right-from-square external-link-icon"></i></a>${extraSuffix}`;
                }
                return `<a href="${href}"${titleAttr}${isMention ? ' class="mention"' : ''}>${displayText}</a>${extraSuffix}`;
            };

            // 5. Blockquote
            renderer.blockquote = function (quote) {
                let text = (typeof quote === 'string') ? quote : (quote.text || '');
                text = text.replace(/<p>|<\/p>/g, '');
                return text.split('\n').map(line => {
                    if (!line.trim()) return '';
                    return `<span class="greentext">&gt;${line}</span>`;
                }).join('\n');
            };

            // 6. Line-by-line rendering to avoid paragraph collapsing and recursion
            const renderedLines = escaped.split('\n').map(line => {
                const trimmed = line.trimStart();
                if (trimmed.startsWith('>')) {
                    const quoteContent = line.substring(line.indexOf('>') + 1);
                    return `<span class="greentext">&gt;${quoteContent}</span>`;
                }
                
                // Per-line limit
                if (line.length > 10000) return line;
                if (!line.trim()) return '&nbsp;';

                let processedLine = line.replace(mentionRegex, (match, g1, g2) => {
                    const user = g1 || g2;
                    return `<a href="/user/${encodeURIComponent(user)}" class="mention">@${user}</a>`;
                });
                
                const escapedSiteHost = window.location.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const rawVideoRegex = new RegExp(`(?<![\\(\\[])((?:(?:https?:\\/\\/|\\/\\/)?${escapedSiteHost}|(?=\\/[a-zA-Z0-9_\\-]))(?:\\/[^\\s\\[\\]\\(\\)]+\\.(?:mp4|webm|ogv|mov)(?:\\?[^\\s\\[\\]\\(\\)]+)?))`, 'gi');
                processedLine = processedLine.replace(rawVideoRegex, (match, url) => {
                    let fullUrl = url;
                    if (!url.startsWith('http') && !url.startsWith('//') && !url.startsWith('/')) fullUrl = '//' + url;
                    return `[video](${fullUrl})`;
                });
                
                const escapedAsterisks = processedLine.replace(/\*/g, '\\*');
                let rendered = marked.parseInline ? marked.parseInline(escapedAsterisks, { renderer: renderer }) : marked.parse(escapedAsterisks, { renderer: renderer }).replace(/<p>|<\/p>/g, '');
                
                return rendered;
            });

            let html = renderedLines.join('\n');

            // Handle spoilers [spoiler]text[/spoiler] (supports nesting)
            let lastHtml;
            let iterations = 0;
            const spoilerRegex = /\[spoiler\]((?:(?!\[spoiler\])[\s\S])*?)\[\/spoiler\]/gi;
            do {
                lastHtml = html;
                html = html.replace(spoilerRegex, (match, content) => {
                    return `<span class="spoiler">${content}</span>`;
                });
                iterations++;
            } while (html !== lastHtml && iterations < 10);

            // Handle blur [blur]text[/blur] (supports nesting)
            const blurRegex = /\[blur\]((?:(?!\[blur\])[\s\S])*?)\[\/blur\]/gi;
            iterations = 0;
            do {
                lastHtml = html;
                html = html.replace(blurRegex, (match, content) => {
                    return `<span class="blur-text">${content}</span>`;
                });
                iterations++;
            } while (html !== lastHtml && iterations < 10);

            // 7. YouTube embed logic
            const ytEmbedRegex = /(?:<p>)?\s*<a\s+[^>]*href="https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^"]*&(?:amp;)?)?v=|youtu\.be\/)([a-zA-Z0-9_\-]{11})[^"]*"[^>]*>([\s\S]*?)<\/a>\s*(?:<\/p>)?/gi;
            html = html.replace(ytEmbedRegex, (match, videoId) => {
                return `<span class="yt-embed-wrap"><iframe src="https://www.youtube.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></span>`;
            });

            // 8. Same-site video embed logic
            const escapedSiteHost = window.location.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const mediaDomainOrRelative = `(?:(?:https?:\\/\\/|\\/\\/)?${escapedSiteHost}|(?=\\/[a-zA-Z0-9_\\-]))`;
            const videoEmbedRegex = new RegExp(`(?:<p>)?\\s*<a\\s+[^>]*href="(${mediaDomainOrRelative}(?:\\/[^\\s\\[\\]\\(\\)]+\\.(?:mp4|webm|ogv|mov)))"[^>]*>([\\s\\S]*?)<\\/a>\\s*(?:<\\/p>)?`, 'gi');
            html = html.replace(videoEmbedRegex, (match, url) => {
                return `<span class="video-embed-wrap"><video src="${url}" controls loop muted playsinline preload="metadata"></video></span>`;
            });

            // 9. Site Sanitizer
            if (window.Sanitizer && typeof Sanitizer.clean === 'function') {
                html = Sanitizer.clean(html);
            }

            return renderDmEmojis(html);
        } catch (e) {
            console.error('[DM Render] ERROR:', e);
            return renderDmEmojis(escHtml(plaintext));
        }
    }

    function buildMessageBubble(m) {
        const div    = document.createElement('div');
        const isMine = m.sender_id === myId;

        const content = m.plaintext !== null
            ? renderDmContent(m.plaintext).trimEnd()
            : '<span class="dm-unreadable">[Unable to decrypt — key mismatch]</span>';

        const hasEmbed = content.includes('yt-embed-wrap');
        div.className = `dm-msg ${isMine ? 'dm-msg-mine' : 'dm-msg-theirs'}${hasEmbed ? ' dm-has-embed' : ''}`;
        div.dataset.msgId = m.id;

        const time = timeAgo(m.created_at);
        div.innerHTML = `<div class="dm-bubble comment-content">${content}</div><span class="dm-msg-time" data-ts="${escHtml(m.created_at)}">${escHtml(time)}</span>`;
        return div;
    }

    let sendInFlight = false; // debounce guard against double-submit

    function setupDmEmojiPicker() {
        const form = document.getElementById('dm-send-form');
        if (!form) return;

        const textarea = form.querySelector('#dm-input');
        const actions  = form.querySelector('.input-actions');
        if (!textarea || !actions || actions.querySelector('.emoji-trigger')) return;

        // Attach mentions
        if (window.MentionAutocomplete) window.MentionAutocomplete.attach(textarea);

        // Spoiler button
        const spoilerBtn = document.createElement('button');
        spoilerBtn.type = 'button';
        spoilerBtn.innerText = '[spoiler]';
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

        // Trigger button
        const trigger = document.createElement('button');
        trigger.type      = 'button';
        trigger.innerText = '☺';
        trigger.className = 'emoji-trigger';
        
        // Put them in: spoiler then emoji
        actions.prepend(trigger);
        actions.prepend(spoilerBtn);

        // Picker lives inside the form — CSS positions it above via position:absolute + bottom:100%
        const picker = document.createElement('div');
        picker.className    = 'emoji-picker dm-emoji-picker';
        picker.style.display = 'none';
        form.appendChild(picker);

        // ── Inline emoji autocomplete ─────────────────────────────────────────
        const autocomplete = document.createElement('div');
        autocomplete.className = 'emoji-autocomplete';
        autocomplete.style.display = 'none';
        autocomplete.style.overscrollBehavior = 'contain';
        document.body.appendChild(autocomplete);

        let acActiveIdx = -1;
        let acMatches = [];
        let acDisplayedCount = 0;
        const BATCH_SIZE = 20;

        const getEmojiMap = () => {
            return (typeof CommentSystem !== 'undefined' && CommentSystem.emojiCache)
                || window.commentSystem?.customEmojis
                || null;
        };

        const positionAC = () => {
            const rect = textarea.getBoundingClientRect();
            autocomplete.style.position = 'fixed';
            autocomplete.style.left = rect.left + 'px';
            autocomplete.style.width = rect.width + 'px';
            autocomplete.style.bottom = (window.innerHeight - rect.top) + 'px';
            autocomplete.style.top = 'auto';
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

        const insertEmojiCode = (name) => {
            const hit = getColon();
            if (!hit) return;
            const before = textarea.value.slice(0, hit.colonPos);
            const after = textarea.value.slice(textarea.selectionStart);
            const insert = `:${name}: `;
            textarea.value = before + insert + after;
            const newPos = hit.colonPos + insert.length;
            textarea.setSelectionRange(newPos, newPos);
            textarea.focus();
            hideAC();
            // Trigger input event for auto-resize
            textarea.dispatchEvent(new Event('input'));
        };

        const appendMoreItems = () => {
            const emojiMap = getEmojiMap();
            if (!emojiMap || acDisplayedCount >= acMatches.length) return;
            const nextBatch = acMatches.slice(acDisplayedCount, acDisplayedCount + BATCH_SIZE);
            nextBatch.forEach((name, i) => {
                const idx = acDisplayedCount + i;
                const item = document.createElement('div');
                item.className = 'emoji-ac-item';
                item.dataset.idx = idx;
                const img = document.createElement('img');
                img.src = emojiMap[name];
                img.alt = name;
                img.loading = 'lazy';
                const label = document.createElement('span');
                label.textContent = `:${name}:`;
                item.appendChild(img);
                item.appendChild(label);
                item.addEventListener('mousedown', ev => {
                    ev.preventDefault();
                    insertEmojiCode(name);
                });
                autocomplete.appendChild(item);
            });
            acDisplayedCount += nextBatch.length;
        };

        const renderAC = () => {
            const hit = getColon();
            const emojiMap = getEmojiMap();
            if (!hit || !emojiMap) return hideAC();
            const { query } = hit;
            acMatches = Object.keys(emojiMap).filter(n => n.includes(query));
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

        textarea.addEventListener('input', () => renderAC());
        textarea.addEventListener('keydown', (e) => {
            if (autocomplete.style.display === 'none') return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (acActiveIdx === acDisplayedCount - 1 && acDisplayedCount < acMatches.length) {
                    appendMoreItems();
                }
                const nextIdx = (acActiveIdx + 1) % acMatches.length;
                setActive(nextIdx);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const nextIdx = (acActiveIdx <= 0) ? acMatches.length - 1 : acActiveIdx - 1;
                if (nextIdx > acDisplayedCount - 1) {
                    while (acDisplayedCount < acMatches.length) appendMoreItems();
                }
                setActive(nextIdx);
            } else if ((e.key === 'Enter' || e.key === 'Tab') && acActiveIdx >= 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                insertEmojiCode(acMatches[acActiveIdx]);
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
        textarea.addEventListener('blur', () => setTimeout(hideAC, 150));
        textarea.addEventListener('click', () => { if (getColon()) renderAC(); });

        const ro = new ResizeObserver(() => {
            if (autocomplete.style.display !== 'none') positionAC();
        });
        ro.observe(textarea);
        window.addEventListener('resize', () => { if (autocomplete.style.display !== 'none') positionAC(); });
        // ─────────────────────────────────────────────────────────────────────

        function renderEmojisIntoPicker(emojis) {
            picker.innerHTML = '';
            Object.entries(emojis).forEach(([name, url]) => {
                const img = document.createElement('img');
                img.src     = url;
                img.title   = `:${name}:`;
                img.loading = 'lazy';
                img.onerror = () => { img.style.display = 'none'; };
                img.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const pos = textarea.selectionStart ?? textarea.value.length;
                    const val = textarea.value;
                    textarea.value = val.slice(0, pos) + ` :${name}: ` + val.slice(pos);
                    textarea.focus();
                    textarea.selectionStart = textarea.selectionEnd = pos + name.length + 4;
                });
                picker.appendChild(img);
            });
        }

        function populatePicker() {
            if (picker.querySelector('img')) return; // already populated

            // Prefer CommentSystem static cache (filled on any item page in this session)
            const cached = (typeof CommentSystem !== 'undefined' && CommentSystem.emojiCache)
                        || window.commentSystem?.customEmojis;

            if (cached && Object.keys(cached).length) {
                renderEmojisIntoPicker(cached);
                return;
            }

            // No cache — fetch directly (happens when /messages is the first page visited)
            picker.innerHTML = '<div style="padding:8px;color:#aaa;font-size:0.82em;">Loading…</div>';
            fetch('/api/v2/emojis')
                .then(r => r.json())
                .then(data => {
                    if (data.success && data.emojis?.length) {
                        const map = {};
                        data.emojis.forEach(e => { map[e.name] = e.url; });
                        // Populate CommentSystem cache for future use
                        if (typeof CommentSystem !== 'undefined') CommentSystem.emojiCache = map;
                        renderEmojisIntoPicker(map);
                    } else {
                        picker.innerHTML = '<div style="padding:8px;color:#aaa;font-size:0.82em;">No emojis yet</div>';
                    }
                })
                .catch(() => {
                    picker.innerHTML = '<div style="padding:8px;color:#aaa;font-size:0.82em;">Failed to load emojis</div>';
                });
        }

        let closeHandler = null;
        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            const isHidden = picker.style.display === 'none';
            if (isHidden) {
                populatePicker();
                picker.style.display = '';
                closeHandler = (ev) => {
                    if (!picker.contains(ev.target) && ev.target !== trigger) {
                        picker.style.display = 'none';
                        document.removeEventListener('click', closeHandler);
                        closeHandler = null;
                    }
                };
                setTimeout(() => document.addEventListener('click', closeHandler), 0);
            } else {
                picker.style.display = 'none';
                if (closeHandler) document.removeEventListener('click', closeHandler);
            }
        });

        // Ensure the emoji picker is updated when emojis are ready
        window.addEventListener('f0ck:emojis_ready', populatePicker);
    }

    function setupSendForm() {
        const form  = document.getElementById('dm-send-form');
        if (!form) return;

        const input = form.querySelector('#dm-input');
        const btn   = form.querySelector('#dm-send-btn');

        // Auto-resize textarea
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 140) + 'px';
        });

        // Pre-fill from ?share=URL — set by the scroller share panel
        const shareUrl = new URLSearchParams(window.location.search).get('share');
        if (shareUrl && !input.value) {
            input.value = shareUrl;
            // Trigger resize
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 140) + 'px';
            // Enable send button
            if (btn) btn.disabled = false;
            // Move cursor to end and focus
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }

        // Enter sends; Shift+Enter inserts newline; Ctrl+Enter also sends
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                form.requestSubmit();
            }
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (sendInFlight) return; // prevent double-submit
            const text = input.value.trim();
            if (!text) return;

            // If recipient has no key, block sending — we cannot encrypt for them
            if (!currentOtherPubKey) {
                // Re-check in case they registered since page load
                currentOtherPubKey = await getRemotePublicKey(currentOtherId);
            }
            if (!currentOtherPubKey) {
                showFlashMsg('This user hasn\'t set up their encryption key yet. Sending is not possible until they do.', 'error');
                return;
            }

            sendInFlight = true;
            btn.disabled = true;
            try {
                const sharedKey = await deriveSharedKey(_privateKey, currentOtherPubKey);
                const { ciphertext, iv } = await encryptMessage(sharedKey, text);
                const res = await dmFetch('POST', `/api/dm/send/${currentOtherId}`, { ciphertext, iv });
                if (res.success) {
                    input.value = '';
                    input.style.height = '';

                    // Optimistic render with the real server ID so dedup works
                    const thread = document.getElementById('dm-thread');
                    if (thread && !renderedIds.has(res.id)) {
                        renderedIds.add(res.id);
                        if (res.id > latestMsgId) latestMsgId = res.id;
                        const msg = { id: res.id, sender_id: myId, plaintext: text, created_at: res.created_at || new Date().toISOString() };
                        thread.appendChild(buildMessageBubble(msg));
                        snapToBottom(thread, true); // Force scroll for your own sent message
                    }
                } else {
                    showFlashMsg(res.msg || 'Failed to send', 'error');
                }
            } catch (err) {
                showFlashMsg('Encryption error: ' + err.message, 'error');
            } finally {
                sendInFlight = false;
                btn.disabled = false;
                input.focus();
            }
        });
    }


    // ─────────────────────────────────────────────────────────────────────────
    // Global key init — runs on every page for logged-in users
    // so keys are always registered before someone tries to DM them.
    // ─────────────────────────────────────────────────────────────────────────

    async function ensureKeyReady() {
        const status = await loadOrCreateKeyPair();
        // Always re-upload public key silently (on every page, so recipients can find us)
        uploadPublicKey().catch(e => console.warn('[DM] pubkey upload failed:', e));

        // Modals only on /messages — don't interrupt the user elsewhere
        const onMessagesPage = window.location.pathname.startsWith('/messages');
        if (!onMessagesPage) return;

        if (status === 'vault') {
            // Blocking: must recover key from seed phrase before anything works
            await showRecoveryModal();
        } else if (status === 'new') {
            // Blocking: must back up new key before sending messages
            await showSeedSetupModal();
        } else if (status === 'local') {
            // Key is in LS — but verify the server vault also exists.
            // If not, the user hasn't backed up yet (e.g. modal failed on first load).
            try {
                const vdata = await dmFetch('GET', '/api/dm/keyvault');
                if (!vdata.success) await showSeedSetupModal();
            } catch { /* offline — skip */ }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Seed phrase setup modal (shown once on key generation — cannot be dismissed)
    // ─────────────────────────────────────────────────────────────────────────

    function showSeedSetupModal() {
        return new Promise(resolve => {
            // Wait up to 2s for the wordlist to be available
            const MAX_WAIT = 2000;
            const POLL = 50;
            let waited = 0;
            const tryBuild = () => {
                const list = window.DM_WORDLIST;
                if ((!list || list.length < 100) && waited < MAX_WAIT) {
                    waited += POLL;
                    return setTimeout(tryBuild, POLL);
                }
                let words;
                try { words = generateMnemonic(); }
                catch (e) {
                    console.error('[DM] generateMnemonic failed:', e);
                    // Don't silently resolve — show a fallback error notice
                    const notice = document.createElement('div');
                    notice.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#d94f4f;color:#fff;padding:12px 20px;border-radius:8px;z-index:20001;font-size:0.9em';
                    notice.textContent = '⚠️ Recovery phrase wordlist failed to load. Please refresh the page.';
                    document.body.appendChild(notice);
                    return; // leave Promise pending so page is blocked
                }
                buildSeedModal(words, resolve);
            };
            setTimeout(tryBuild, 0);
        });
    }

    function buildSeedModal(words, resolve) {

            const modal = document.createElement('div');
            modal.id = 'dm-seed-modal';
            modal.className = 'dm-modal-overlay dm-modal-blocking';
            modal.innerHTML = `
                <div class="dm-modal">
                    <h2>🔑 Secure your messages</h2>
                    <p class="dm-modal-sub">Your messages are end-to-end encrypted. Write down the following 12 words — they are your only way to regain access on a new device.</p>
                    <div class="dm-seed-grid" id="dm-seed-words"></div>
                    <button class="dm-key-btn dm-copy-seed" id="dm-copy-seed-btn">📋 Copy words</button>
                    <div class="dm-seed-confirm">
                        <label>
                            <input type="checkbox" id="dm-seed-ack">
                            <span>I have written down all 12 words and stored them safely.</span>
                        </label>
                    </div>
                    <div class="dm-key-msg" id="dm-seed-msg"></div>
                    <button class="dm-key-btn dm-key-btn-primary" id="dm-seed-continue" disabled>Continue →</button>
                    <hr style="border-color:rgba(255,255,255,0.1);margin:16px 0">
                    <p style="font-size:0.82em;color:#888">Already have a recovery phrase from a previous session?</p>
                    <button class="dm-key-btn" id="dm-seed-switch-recover" style="background:rgba(255,255,255,0.07);border:1px solid #444;color:var(--fg,#ddd);width:100%">🔓 Enter existing recovery phrase</button>
                </div>
            `;

            // Prevent any dismiss (ESC, overlay click) — this is forced
            modal.addEventListener('click', e => e.stopPropagation());
            document.addEventListener('keydown', trapEsc, true);
            function trapEsc(e) { if (e.key === 'Escape') e.stopImmediatePropagation(); }

            const grid = modal.querySelector('#dm-seed-words');
            words.forEach((w, i) => {
                const el = document.createElement('div');
                el.className = 'dm-seed-word';
                el.innerHTML = `<span class="dm-seed-num">${i + 1}</span><span class="dm-seed-val">${escHtml(w)}</span>`;
                grid.appendChild(el);
            });

            modal.querySelector('#dm-copy-seed-btn').onclick = () => {
                navigator.clipboard.writeText(words.join(' ')).then(() => {
                    setMsg(modal.querySelector('#dm-seed-msg'), '✅ Words copied to clipboard.', 'ok');
                });
            };

            modal.querySelector('#dm-seed-ack').onchange = (e) => {
                modal.querySelector('#dm-seed-continue').disabled = !e.target.checked;
            };

            modal.querySelector('#dm-seed-continue').onclick = async () => {
                const btn = modal.querySelector('#dm-seed-continue');
                btn.disabled = true;
                btn.textContent = 'Saving…';
                try {
                    const privJwk = localStorage.getItem(DM_KEY_NAME);
                    const vault   = await encryptPrivkeyForVault(privJwk, words);
                    const res     = await dmFetch('POST', '/api/dm/keyvault', vault);
                    if (!res.success) throw new Error(res.msg || 'Save failed');
                    document.removeEventListener('keydown', trapEsc, true);
                    modal.remove();
                    resolve();
                } catch (err) {
                    setMsg(modal.querySelector('#dm-seed-msg'), '❌ ' + err.message, 'err');
                    btn.disabled = false;
                    btn.textContent = 'Continue →';
                }
            };

            // Switch to recovery flow instead of setting up a new key
            modal.querySelector('#dm-seed-switch-recover').onclick = async () => {
                document.removeEventListener('keydown', trapEsc, true);
                modal.remove();
                // Clean up the freshly generated key — recovery will replace it
                localStorage.removeItem(DM_KEY_NAME);
                localStorage.removeItem(DM_PUBKEY_NAME);
                localStorage.removeItem(DM_KEY_VERSION);
                _privateKey = null; _publicKeyJwk = null;
                await showRecoveryModal();
                resolve();
            };

            document.body.appendChild(modal);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Recovery modal (shown when vault exists but no local key)
    // ─────────────────────────────────────────────────────────────────────────

    function showRecoveryModal() {
        return new Promise(resolve => {
            const modal = document.createElement('div');
            modal.id = 'dm-recovery-modal';
            modal.className = 'dm-modal-overlay dm-modal-blocking';
            modal.innerHTML = `
                <div class="dm-modal">
                    <h2>🔑 Restore your key</h2>
                    <p class="dm-modal-sub">Enter your 12 recovery words to regain access to your messages.</p>
                    <div class="dm-recovery-grid" id="dm-recovery-inputs"></div>
                    <div class="dm-key-msg" id="dm-recovery-msg"></div>
                    <button class="dm-key-btn dm-key-btn-primary" id="dm-recovery-btn">🔓 Restore key</button>
                    <hr style="border-color:rgba(255,255,255,0.1);margin:16px 0">
                    <p style="font-size:0.82em;color:#888">Forgot your words? You can create a new key — <strong>all old messages will become unreadable.</strong></p>
                    <button class="dm-key-btn dm-key-btn-danger" id="dm-recovery-reset">⚠️ Start fresh (lose old messages)</button>
                </div>
            `;

            modal.addEventListener('click', e => e.stopPropagation());
            document.addEventListener('keydown', trapEsc2, true);
            function trapEsc2(e) { if (e.key === 'Escape') e.stopImmediatePropagation(); }

            const grid = modal.querySelector('#dm-recovery-inputs');
            for (let i = 0; i < 12; i++) {
                const wrap = document.createElement('div');
                wrap.className = 'dm-seed-word dm-seed-input-wrap';
                wrap.innerHTML = `<span class="dm-seed-num">${i + 1}</span><input type="text" class="dm-recovery-word" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Word ${i + 1}">`;
                grid.appendChild(wrap);
            }

            const attemptRecovery = async () => {
                const inputs = [...modal.querySelectorAll('.dm-recovery-word')];
                const words  = inputs.map(i => i.value.trim().toLowerCase()).filter(Boolean);
                const msg    = modal.querySelector('#dm-recovery-msg');
                const btn    = modal.querySelector('#dm-recovery-btn');
                if (words.length < 12) { setMsg(msg, 'Please enter all 12 words.', 'err'); return; }

                btn.disabled = true; btn.textContent = 'Decrypting…';
                try {
                    const vdata = await dmFetch('GET', '/api/dm/keyvault');
                    if (!vdata.success) throw new Error('No vault found');
                    const privJwk = await decryptPrivkeyFromVault(vdata.vault, words);
                    await storeKeyFromJwk(privJwk);
                    await uploadPublicKey();
                    document.removeEventListener('keydown', trapEsc2, true);
                    modal.remove();
                    resolve();
                } catch {
                    setMsg(msg, '❌ Wrong words or corrupted vault. Please try again.', 'err');
                    btn.disabled = false; btn.textContent = '🔓 Restore key';
                }
            };

            modal.querySelector('#dm-recovery-btn').onclick = attemptRecovery;

            const allInputs = [...modal.querySelectorAll('.dm-recovery-word')];

            allInputs.forEach((inp, idx) => {
                // Enter key → attempt recovery
                inp.addEventListener('keydown', e => { if (e.key === 'Enter') attemptRecovery(); });

                // Helper: distribute word list across inputs starting at idx
                const distributeWords = (parts, startIdx) => {
                    parts.forEach((word, i) => {
                        if (allInputs[startIdx + i]) allInputs[startIdx + i].value = word.toLowerCase();
                    });
                    const nextEmpty = allInputs.find(f => !f.value.trim());
                    if (nextEmpty) nextEmpty.focus();
                    else modal.querySelector('#dm-recovery-btn').focus();
                };

                // Paste event: works on desktop and some mobile browsers
                inp.addEventListener('paste', e => {
                    const clip = e.clipboardData || window.clipboardData;
                    const text = clip?.getData('text/plain') || clip?.getData('text') || '';
                    const parts = text.trim().split(/\s+/).filter(Boolean);
                    if (parts.length > 0) {
                        e.preventDefault(); // Block native paste — we handle it
                        if (parts.length > 1) {
                            distributeWords(parts, idx);
                        } else {
                            inp.value = parts[0].toLowerCase();
                            if (allInputs[idx + 1]) allInputs[idx + 1].focus();
                        }
                    }
                    // If clip was empty, fall through — `input` event below catches it
                });

                // Input event: catches keyboard-paste on mobile which skips the paste event.
                // Users only type one word per field, so multiple words → must be a paste.
                inp.addEventListener('input', () => {
                    const parts = inp.value.trim().split(/\s+/).filter(Boolean);
                    if (parts.length > 1) {
                        distributeWords(parts, idx);
                    }
                });

            });

            modal.querySelector('#dm-recovery-reset').onclick = async () => {
                if (!confirm('Really start fresh? All old messages will become unreadable.')) return;
                await dmFetch('DELETE', '/api/dm/keyvault');
                await dmFetch('DELETE', '/api/dm/all'); // wipe own messages
                const pair    = await generateKeyPair();
                const privJwk = await exportKey(pair.privateKey);
                const pubJwk  = await exportKey(pair.publicKey);
                localStorage.setItem(DM_KEY_NAME, privJwk);
                localStorage.setItem(DM_PUBKEY_NAME, pubJwk);
                localStorage.setItem(DM_KEY_VERSION, String(CURRENT_VERSION));
                _privateKey   = pair.privateKey;
                _publicKeyJwk = pubJwk;
                document.removeEventListener('keydown', trapEsc2, true);
                modal.remove();
                // Show seed setup for the new key
                await showSeedSetupModal();
                resolve();
            };

            document.body.appendChild(modal);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Key Manager Modal (simplified — shows vault status, allows regenerate)
    // ─────────────────────────────────────────────────────────────────────────

    function openKeyManager() {
        let modal = document.getElementById('dm-key-modal');
        if (!modal) { modal = buildKeyManagerModal(); document.body.appendChild(modal); }
        modal.style.display = 'flex';
    }

    function buildKeyManagerModal() {
        const modal = document.createElement('div');
        modal.id = 'dm-key-modal';
        modal.className = 'dm-modal-overlay';
        modal.innerHTML = `
            <div class="dm-modal">
                <button class="dm-modal-close" id="dm-key-modal-close">×</button>
                <h2>🔑 Encryption Key</h2>
                <p class="dm-modal-sub">Your private key is secured with your recovery phrase and stored encrypted on the server.</p>

                <div class="dm-key-status" id="dm-key-status">${hasKey() ? '✅ Key loaded and backed up.' : '❌ No key found.'}</div>

                <div class="dm-key-section">
                    <h3>🔓 Recover from phrase</h3>
                    <p>Already have a recovery phrase? Enter it here to restore access to previous messages on this device.</p>
                    <button class="dm-key-btn" id="dm-recover-phrase-btn" style="background:rgba(255,255,255,0.07);border:1px solid #444;color:var(--fg,#ddd);width:100%">Enter recovery phrase</button>
                    <div class="dm-key-msg" id="dm-recover-phrase-msg"></div>
                </div>

                <div class="dm-key-section dm-key-danger">
                    <h3>Create new key</h3>
                    <p>⚠️ Creates a new key pair. <strong>Old messages will become unreadable.</strong></p>
                    <button class="dm-key-btn dm-key-btn-danger" id="dm-regen-btn">🔄 Create new key</button>
                    <div class="dm-key-msg" id="dm-regen-msg"></div>
                </div>
            </div>
        `;

        modal.querySelector('#dm-key-modal-close').onclick = () => modal.style.display = 'none';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.style.display !== 'none') modal.style.display = 'none'; });

        // Recover from existing phrase
        modal.querySelector('#dm-recover-phrase-btn').onclick = async () => {
            modal.style.display = 'none';
            await showRecoveryModal();
            // Refresh status label on re-open
            const statusEl = modal.querySelector('#dm-key-status');
            if (statusEl) statusEl.textContent = hasKey() ? '✅ Key loaded and backed up.' : '❌ No key found.';
        };

        modal.querySelector('#dm-regen-btn').onclick = async () => {
            const msg = modal.querySelector('#dm-regen-msg');
            if (!confirm('Really create a new key? All old messages will become unreadable.')) return;
            try {
                await dmFetch('DELETE', '/api/dm/keyvault');
                localStorage.removeItem(DM_KEY_NAME);
                localStorage.removeItem(DM_PUBKEY_NAME);
                localStorage.removeItem(DM_KEY_VERSION);
                _privateKey = null; _publicKeyJwk = null; pubkeyCache.clear();
                modal.style.display = 'none';
                const status = await loadOrCreateKeyPair();
                uploadPublicKey().catch(() => {});
                if (status === 'new') await showSeedSetupModal();
            } catch (e) {
                setMsg(msg, '❌ Error: ' + e.message, 'err');
            }
        };

        return modal;
    }

    function setMsg(el, text, type) {
        el.textContent  = text;
        el.className    = `dm-key-msg dm-msg-${type}`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Navbar DM badge
    // ─────────────────────────────────────────────────────────────────────────

    function updateDmBadge(count) {
        const badge = document.getElementById('dm-badge');
        if (badge) {
            badge.textContent   = count > 99 ? '99+' : String(count);
            badge.style.display = count > 0 ? 'inline-flex' : 'none';
        }
        // Sync page title badge on every page
        _dmTitleCount = Math.max(0, count);
        applyDmTitleBadge();
    }

    function incrementDmBadge() {
        const badge = document.getElementById('dm-badge');
        if (!badge) return;
        const current = parseInt(badge.textContent, 10) || 0;
        updateDmBadge(current + 1);
    }

    async function refreshDmBadge() {
        try {
            const data = await dmFetch('GET', '/api/dm/unread');
            if (data.success) updateDmBadge(data.count);
        } catch (_) {}
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SSE integration (bridge from NotificationSystem in f0ckm.js)
    // ─────────────────────────────────────────────────────────────────────────

    function hookSSE() {
        // incrementDmBadge() is called directly from f0ckm.js SSE handler for instant update.
        // We only listen here to update chat thread live when we're in a conversation.
        // (badge refresh after conversation read is handled by initConversation)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User profile "Send DM" button
    // ─────────────────────────────────────────────────────────────────────────

    function setupProfileDmBtn() {
        const btn = document.getElementById('send-dm-btn');
        if (!btn) return;
        btn.onclick = () => {
            const username = btn.dataset.username;
            if (username) window.location.href = `/messages/${encodeURIComponent(username.toLowerCase())}`;
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────

    function escHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }


    function timeAgo(dateStr) {
        if (window.f0ckTimeAgo) return window.f0ckTimeAgo(dateStr);
        const sec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
        if (sec < 60)    return 'just now';
        if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
        if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
        return `${Math.floor(sec / 86400)}d ago`;
    }

    function showFlashMsg(msg, type) {
        if (window.showFlash) window.showFlash(msg, type === 'error' ? 'error' : 'success');
        else console.warn('[DM]', msg);
    }


    // ─────────────────────────────────────────────────────────────────────────
    // Tab Activation (Catch up on missed messages/badges)
    // ─────────────────────────────────────────────────────────────────────────

    const handleActivation = () => {
        if (document.hidden) return;

        const thread = document.getElementById('dm-thread');
        if (thread && currentOtherId && parseInt(thread.dataset.otherId) === currentOtherId) {
            console.log('[DM] Tab active: catching up on conversation...');
            appendNewMessages(thread).then(() => {
                dmFetch('POST', `/api/dm/read/${currentOtherId}`)
                    .then(() => refreshDmBadge()) // refreshDmBadge clears title via updateDmBadge(0)
                    .catch(() => {});
            });
        }
    };

    document.addEventListener('visibilitychange', handleActivation);
    window.addEventListener('focus', handleActivation);

    // ─────────────────────────────────────────────────────────────────────────
    // Init
    // ─────────────────────────────────────────────────────────────────────────


    async function init() {
        hookSSE();
        setupProfileDmBtn();

        // All .dm-manage-keys-btn hooks
        document.addEventListener('click', (e) => {
            if (e.target.closest('.dm-manage-keys-btn')) openKeyManager();
        });

        // Global DM listener for live updates.
        // We only mark as read if the user is actively viewing this specific thread.
        window.addEventListener('dm:incoming', async (e) => {
            const thread = document.getElementById('dm-thread');
            // Use Number() to avoid type mismatch between SSE string and local integer
            if (thread && currentOtherId && Number(e.detail.sender_id) === currentOtherId) {
                await appendNewMessages(thread);

                if (!document.hidden) {
                    // Tab is visible — mark as read immediately
                    dmFetch('POST', `/api/dm/read/${currentOtherId}`)
                        .then(() => refreshDmBadge())
                        .catch(() => {});
                }
                // Badge (and title) increment is handled by incrementDmBadge() in f0ckm.js
            }
        });

        // Re-render DMs when emojis are ready
        window.addEventListener('f0ck:emojis_ready', () => {
            const thread = document.getElementById('dm-thread');
            if (!thread || !threadMessages.length) return;

            console.log('[DM] Emojis ready, re-rendering thread...');
            const isAtBottom = (thread.scrollHeight - thread.scrollTop - thread.clientHeight) < 50;
            
            // Clear and re-render from cache
            renderedIds.clear();
            thread.innerHTML = '';
            
            // Re-render everyone
            for (const m of threadMessages) {
                renderedIds.add(m.id);
                thread.appendChild(buildMessageBubble(m));
            }

            if (isAtBottom) snapToBottom(thread, true);
        });

        // Generate + upload key silently for every logged-in user on every page.
        // This ensures that by the time someone tries to DM them, a key already exists.
        await ensureKeyReady();

        // Refresh badge
        if (document.getElementById('dm-badge')) {
            await refreshDmBadge();
        }

        // Page-specific init
        if (document.getElementById('dm-inbox-list')) await initInbox();
        if (document.getElementById('dm-thread'))     await initConversation();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AJAX re-init hook  (called by f0ckm.js after every AJAX navigation)
    // Resets page-level state so the inbox and conversation can re-initialize
    // cleanly without a full page reload.
    // ─────────────────────────────────────────────────────────────────────────

    async function initMessagesPage() {
        // Reset conversation-level state
        currentOtherId     = null;
        currentOtherPubKey = null;
        myId               = null;
        latestMsgId        = 0;
        oldestMsgId        = null;
        threadHasMore      = false;
        renderedIds.clear();
        threadMessages     = [];
        sendInFlight       = false;

        // Clear timestamp ticker on page reset
        if (window._dmTimestampTicker) {
            clearInterval(window._dmTimestampTicker);
            window._dmTimestampTicker = null;
        }

        // Restore base title on every messages page navigation then re-apply badge
        const stripped = document.title.replace(/^\[\d+\]\s*/, '');
        document.title = stripped || 'Messages';
        applyDmTitleBadge();

        // Show seed phrase setup / recovery modal if needed (AJAX navigation lands here)
        await ensureKeyReady();

        // Re-run page-specific init (initConversation sets its own title)
        if (document.getElementById('dm-inbox-list')) await initInbox();
        if (document.getElementById('dm-thread'))     await initConversation();

        // Refresh badge on any messages page
        await refreshDmBadge();
    }

    /**
     * Snap a container to the bottom.
     * Uses double requestAnimationFrame to ensure the browser has finished layout
     * (especially for newly appended images/emojis) before calculating scroll height.
     */
    function snapToBottom(el, force = false) {
        if (!el) return;

        // "Near bottom" threshold: 120px
        const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;

        if (force || isNearBottom) {
            // Double-kick ensures the DOM engine has calculated the new total height
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    el.scrollTop = el.scrollHeight;
                });
            });
        }
    }

    /**
     * Watch a thread container and keep snapping to bottom for `durationMs`.
     * This handles images, iframes, and emoji that load asynchronously and
     * push the scroll height upward after the initial snap has fired.
     */
    function snapToBottomSticky(el, durationMs = 1200) {
        if (!el || typeof ResizeObserver === 'undefined') {
            // Fallback: a single extra snap after a short delay
            setTimeout(() => snapToBottom(el, true), 250);
            return;
        }

        const deadline = Date.now() + durationMs;
        const ro = new ResizeObserver(() => {
            if (Date.now() > deadline) { ro.disconnect(); return; }
            // Only keep snapping if the user hasn't manually scrolled up
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (distanceFromBottom < 300) {
                el.scrollTop = el.scrollHeight;
            } else {
                // User scrolled up intentionally — stop sticky behaviour
                ro.disconnect();
            }
        });
        ro.observe(el);

        // Disconnect after deadline regardless
        setTimeout(() => ro.disconnect(), durationMs);

        // Also fire a plain timeout-based snap as an extra safety net
        setTimeout(() => snapToBottom(el, true), 150);
        setTimeout(() => snapToBottom(el, true), 400);
    }

    // Expose for external use (template inline scripts, f0ckm.js SSE handler, AJAX nav)
    window.DMSystem = { openKeyManager, updateDmBadge, incrementDmBadge, refreshDmBadge, setupProfileDmBtn };
    window.initMessagesPage = initMessagesPage;

    // ── Global DM Shortcuts ───────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (!e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key !== '.') return;
        
        const input = document.getElementById('dm-input');
        if (input && document.activeElement !== input) {
            e.preventDefault();
            input.focus();
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

} // end __dmLoaded guard
