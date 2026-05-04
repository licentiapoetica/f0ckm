class UserCommentSystem {
    constructor() {
        this.container = document.getElementById('user-comments-container');
        this.username = this.container ? this.container.dataset.user : null;
        this.page = 1;
        this.loading = false;
        this.finished = false;
        this.userColor = null;
        this.customEmojis = UserCommentSystem.emojiCache || {};

        this.icons = {
            reply: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"></polyline><path d="M4 4v7a4 4 0 0 0 4 4h12"></path></svg>`,
            link: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`
        };

        if (this.username) {
            this.init();
        }

        // Handle live updates for edited comments
        this.editListener = (e) => this.handleLiveEdit(e.detail);
        window.addEventListener('f0ck:comment_edited', this.editListener);
    }

    handleLiveEdit(data) {
        if (!this.container) return;
        const el = document.getElementById('c' + data.comment_id);
        if (el && this.container.contains(el)) {
            const contentEl = el.querySelector('.comment-content');
            if (contentEl) {
                contentEl.innerHTML = this.renderCommentContent(data.content, data.item_id);
                el.classList.remove('new-item-fade');
                void el.offsetWidth;
                el.classList.add('new-item-fade');
            }
        }
    }

    async init() {
        this.loadEmojis();
        this.loadMore();
        this.loadMore();
        this.bindEvents();
        this.startLiveTimestamps();
    }

    async loadEmojis() {
        if (UserCommentSystem.emojiCache) {
            this.customEmojis = UserCommentSystem.emojiCache;
            return;
        }
        try {
            const res = await fetch('/api/v2/emojis');
            const data = await res.json();
            if (data.success) {
                this.customEmojis = {};
                data.emojis.forEach(e => {
                    this.customEmojis[e.name] = e.url;
                });
                UserCommentSystem.emojiCache = this.customEmojis;
            }
        } catch (e) {
            console.error("Failed to load emojis", e);
        }
    }

    bindEvents() {
        window.addEventListener('scroll', () => {
            if (this.loading || this.finished) return;
            if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 500) {
                this.loadMore();
            }
        });

        // Listen for mode changes
        document.addEventListener('f0ck:modeChange', (e) => {
            // Check if this instance is still active
            if (!document.body.contains(this.container)) return;

            window.f0ckDebug('Mode changed, reloading comments...');
            this.container.innerHTML = '';
            this.page = 1;
            this.finished = false;
            this.loadMore();
        });
    }

    async loadMore() {
        if (this.loading || this.finished) return;
        this.loading = true;

        const loader = document.createElement('div');
        loader.className = 'loader-placeholder';
        loader.innerText = 'Loading...';
        loader.style.textAlign = 'center';
        loader.style.padding = '10px';
        this.container.appendChild(loader);

        try {
            const mode = window.activeMode || 'sfw';
            const res = await fetch('/user/' + encodeURIComponent(this.username) + '/comments?page=' + this.page + '&json=true&mode=' + mode);
            const json = await res.json();

            loader.remove();

            if (json.success && json.comments.length > 0) {
                if (json.user && json.user.username_color) {
                    this.userColor = json.user.username_color;
                }
                json.comments.forEach(c => {
                    window.f0ckDebug('Raw Comment Content (ID ' + c.id + '):', c.content);
                    const html = this.renderComment(c);
                    this.container.insertAdjacentHTML('beforeend', html);
                });
                this.page++;
            } else {
                this.finished = true;
                if (this.page === 1 && (!json.comments || json.comments.length === 0)) {
                    this.container.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">No comments found.</div>';
                }
            }
        } catch (e) {
            console.error(e);
            loader.remove();
        } finally {
            this.loading = false;
        }
    }

    renderEmoji(match, name) {
        if (this.customEmojis && this.customEmojis[name]) {
            return `<img src="${this.customEmojis[name]}" style="height:60px;vertical-align:middle;" alt="${name}">`;
        }
        return match;
    }

    renderCommentContent(content, itemId = null) {
        if (!content) return '';

        // Anti-recursion / Performance safeguard for extremely long comments
        if (content.length > 50000) {
            console.warn('UserComments: Comment too long, skipping markdown');
            return `<pre style="white-space: pre-wrap; font-family: inherit; margin: 0; padding: 0; background: none; border: none; font-size: inherit; color: inherit;">${this.escapeHtml(content)}</pre>`;
        }

        if (typeof marked === 'undefined') {
            return this.escapeHtml(content).replace(/:([a-z0-9_]+):/g, (m, n) => this.renderEmoji(m, n));
        }

        try {
            // 1. Initial escaping using native method. Restore > for markdown markers.
            let escaped = this.escapeHtml(content).replace(/&gt;/g, ">");

            // 2. Mentions
            const mentionRegex = /(?<!\[)@([a-zA-Z0-9_\-\.]+)(?!\])/g;

            const siteOrigin = window.location.origin;
            const renderer = new marked.Renderer();
            renderer.blockquote = function (quote) {
                let text = (typeof quote === 'string') ? quote : (quote.text || '');
                text = text.replace(/<p>|<\/p>/g, '');
                return text.split('\n').map(line => {
                    if (!line.trim()) return '';
                    return `<span class="greentext">&gt;${line}</span>`;
                }).join('\n');
            };
            renderer.paragraph = function (text) {
                return (typeof text === 'string') ? text : (text.text || '');
            };

            renderer.link = function (href, title, text) {
                if (typeof href === 'object' && href !== null) {
                    title = href.title; text = href.text || text; href = href.href;
                }
                if (!href) return text || '';
                const titleAttr = title ? ` title="${title}"` : '';
                const isExternal = href.startsWith('http://') || href.startsWith('https://');
                const isSameSite = href.startsWith(siteOrigin);

                let displayText = text;
                if (isSameSite && (text === href || text === href.replace(/^https?:\/\//, '') || text === href.replace(siteOrigin, ''))) {
                    try {
                        const url = new URL(href.startsWith('http') ? href : siteOrigin + (href.startsWith('/') ? '' : '/') + href);
                        displayText = url.pathname + url.search + url.hash;
                    } catch (e) {}
                }

                if (isExternal && !isSameSite) {
                    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${displayText}</a>`;
                }
                return `<a href="${href}"${titleAttr}>${displayText}</a>`;
            };

            // 3. Line-by-line rendering to avoid paragraph collapsing and recursion
            const renderedLines = escaped.split('\n').map(line => {
                const trimmed = line.trimStart();
                if (trimmed.startsWith('>') && !trimmed.match(/^>>\d+/)) {
                    const quoteContent = line.substring(line.indexOf('>') + 1);
                    return `<span class="greentext">&gt;${quoteContent}</span>`;
                }
                
                // Per-line limit
                if (line.length > 10000) return line;
                if (!line.trim()) return '&nbsp;';

                let processedLine = line.replace(mentionRegex, '[@$1](/user/$1)');

                // Handle Comment Context Links (>>ID)
                processedLine = processedLine.replace(/(?<!\w)>>(\d+)/g, (match, id) => {
                    const targetHref = itemId ? `/${itemId}#c${id}` : `#c${id}`;
                    return `<a href="${targetHref}" class="comment-context-link" data-id="${id}">>>${id}</a>`;
                });

                const escapedAsterisks = processedLine.replace(/\*/g, '\\*');
                let rendered = marked.parseInline ? marked.parseInline(escapedAsterisks, { renderer: renderer }) : marked.parse(escapedAsterisks, { renderer: renderer }).replace(/<p>|<\/p>/g, '');
                
                // Render emojis ONLY if this is NOT a quote line OR if the user prefers it
                const quoteEmojis = window.f0ckSession?.quote_emojis === true;
                if (!trimmed.startsWith('>') || quoteEmojis) {
                    rendered = rendered.replace(/:([a-z0-9_]+):/g, (m, n) => this.renderEmoji(m, n));
                }
                
                return rendered;
            });

            let html = renderedLines.join('\n');

            // Handle spoilers [spoiler]text[/spoiler] (supports nesting)
            let prevMd;
            let iterations = 0;
            const spoilerRegex = /\[spoiler\]((?:(?!\[spoiler\])[\s\S])*?)\[\/spoiler\]/gi;
            do {
                prevMd = html;
                html = html.replace(spoilerRegex, (match, content) => {
                    return `<span class="spoiler">${content}</span>`;
                });
                iterations++;
            } while (html !== prevMd && iterations < 10);

            // Handle blur [blur]text[/blur] (supports nesting)
            const blurRegex = /\[blur\]((?:(?!\[blur\])[\s\S])*?)\[\/blur\]/gi;
            iterations = 0;
            do {
                prevMd = html;
                html = html.replace(blurRegex, (match, content) => {
                    return `<span class="blur-text">${content}</span>`;
                });
                iterations++;
            } while (html !== prevMd && iterations < 10);

            if (window.Sanitizer && typeof Sanitizer.clean === 'function') {
                html = Sanitizer.clean(html);
            }

            return html;
        } catch (e) {
            console.error('UserCommentSystem Markdown Render Error:', e);
            return this.escapeHtml(content);
        }
    }

    renderComment(c) {
        const timeAgo = this.timeAgo(c.created_at);
        const fullDate = new Date(c.created_at).toISOString();
        const content = this.renderCommentContent(c.content, c.item_id);

        // Replicating the structure of comments.js but adapting for the list view
        // We add a header indicating which item this comment belongs to

        return `
        <div class="comment" id="c${c.id}">
            <div class="comment-avatar">
               <a href="/${c.item_id}">
                   <img src="/t/${c.item_id}.webp" alt="">
               </a>
            </div>
            <div class="comment-body">
                <div class="comment-header">
                    <div class="comment-header-left">
                        <span class="comment-author" tooltip="ID: ${c.user_id}" ${this.userColor ? `style="color: ${this.userColor}"` : ''}>${this.username}</span>
                    </div>
                    <span class="comment-time timeago" title="${fullDate}">${timeAgo}</span>
                </div>
                <div class="comment-content">${content}</div>
                <div class="comment-footer">
                    <div class="comment-footer-right">
                        <div class="comment-actions">
                            ${window.f0ckSession && window.f0ckSession.logged_in ? `<button class="report-comment-btn" data-id="${c.id}" title="Report Comment" style="background:none;border:none;color:inherit;cursor:pointer;opacity:0.75;padding:0;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 512 512" fill="currentColor"><path d="M506.3 417l-213.3-364c-16.3-28-57.5-28-73.8 0l-213.2 364C-10.6 445.1 9.7 480 42.7 480h426.6C502.5 480 522.6 445.1 506.3 417zM256 384c-14.1 0-25.6-11.5-25.6-25.6 0-14.1 11.5-25.6 25.6-25.6 14.1 0 25.6 11.5 25.6 25.6C281.6 372.5 270.1 384 256 384zM281.6 264.4c0 14.1-11.5 25.6-25.6 25.6-14.1 0-25.6-11.5-25.6-25.6v-96c0-14.1 11.5-25.6 25.6-25.6 14.1 0 25.6 11.5 25.6 25.6V264.4z"/></svg></button>` : ''}
                        </div>
                    </div>
                </div>
            </div>
            <a href="/${c.item_id}#c${c.id}" class="comment-permalink" title="Permalink">#${c.id}</a>
        </div>
        `;
    }

    startLiveTimestamps() {
        // Update timestamps every 30 seconds
        setInterval(() => {
            const timestamps = this.container ? this.container.querySelectorAll('.comment-time.timeago') : [];
            timestamps.forEach(el => {
                const dateStr = el.getAttribute('tooltip');
                if (dateStr) {
                    el.textContent = this.timeAgo(dateStr);
                }
            });
        }, 30000);
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
}

// Initializer for AJAX and standard load
window.initUserComments = () => {
    // Prevent multiple instances if already running on this container
    if (document.getElementById('user-comments-container')) {
        new UserCommentSystem();
    }
};

window.addEventListener('DOMContentLoaded', () => {
    window.initUserComments();
});
