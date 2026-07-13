(function () {
    let customEmojis = {};
    let loading = false;
    let loadingMore = false;
    let currentPage = 1;
    let hasMore = true;
    let ioSentinel = null; // persistent sentinel element for IntersectionObserver
    // Shared cache for activity across AJAX loads
    if (!window._sidebarActivityCache) window._sidebarActivityCache = [];

    const loadEmojis = async () => {
        if (Object.keys(customEmojis).length > 0) return;
        try {
            const res = await fetch('/api/v2/emojis');
            const data = await res.json();
            if (data.success) {
                data.emojis.forEach(e => {
                    customEmojis[e.name] = e.url;
                });
            }
        } catch (e) {
            console.error("Sidebar Activity: Failed to load emojis", e);
        }
    };

    const renderEmoji = (match, name) => {
        if (customEmojis[name]) {
            return `<img class="sidebar-comment-img emoji" src="${customEmojis[name]}" alt="${name}" title=":${name}:" loading="lazy">`;
        }
        return match;
    };

    const escapeHtml = (unsafe) => {
        if (!unsafe) return '';
        const div = document.createElement('div');
        div.textContent = unsafe;
        return div.innerHTML;
    };

    const ytOembedCache = new Map(); // videoId -> meta object
    const ytOembedPending = new Map(); // videoId -> Promise


    const fetchSidebarYoutubeTitles = async (container) => {
        const links = container.querySelectorAll('.sidebar-video-link[data-yt-id]');
        if (links.length === 0) return;

        for (const link of links) {
            const videoId = link.dataset.ytId;
            if (!videoId) continue;

            const titleSpan = link.querySelector('.yt-title');
            if (!titleSpan || titleSpan.dataset.loaded === 'true') continue;

            let meta = ytOembedCache.get(videoId);
            if (!meta) {
                if (ytOembedPending.has(videoId)) {
                    meta = await ytOembedPending.get(videoId);
                } else {
                    const promise = (async () => {
                        try {
                            const ytUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
                            const r = await fetch(`/api/v2/meta/fetch?url=${encodeURIComponent(ytUrl)}`);
                            if (r.ok) {
                                const data = await r.json();
                                if (data.success && data.meta) {
                                    ytOembedCache.set(videoId, data.meta);
                                    return data.meta;
                                }
                            }
                        } catch (e) { }
                        return null;
                    })();
                    ytOembedPending.set(videoId, promise);
                    meta = await promise;
                    ytOembedPending.delete(videoId);
                }
            }

            if (meta && meta.title) {
                titleSpan.textContent = meta.title;
            } else {
                // If title fails, just leave it blank or use a generic label
                titleSpan.textContent = 'YouTube Video';
            }
            titleSpan.dataset.loaded = 'true';
        }
    };

    // Maximum characters to render in the sidebar per comment
    const SIDEBAR_CONTENT_TRUNCATE = 200;

    const renderCommentContent = (content, commentId = null, itemId = null) => {
        if (!content) return '';

        // Truncate extremely long comments before any processing to keep the sidebar
        // fast and the DOM lean, regardless of markdown / regex complexity.
        if (content.length > SIDEBAR_CONTENT_TRUNCATE) {
            content = content.substring(0, SIDEBAR_CONTENT_TRUNCATE) + '\u2026';
        }

        if (typeof marked === 'undefined') {
            return escapeHtml(content)
                .replace(/:([a-z0-9_]+):/g, (m, n) => renderEmoji(m, n));
        }

        try {
            // Extract and protect code blocks (```...```) before escaping
            const codeBlocks = [];
            let processed = content.replace(/```([\s\S]*?)```/g, (match) => {
                const placeholder = `BLOCKPORTALX${codeBlocks.length}X`;
                codeBlocks.push(marked.parse(match));
                return placeholder;
            });

            let escaped = escapeHtml(processed)
                .replace(/&gt;/g, ">"); // Restore > for markdown markers

            // Handle Image Embeds (Client-side)
            const siteOrigin = window.location.origin;
            const escapedSiteUrl = siteOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const allowedHosts = [escapedSiteUrl];
            if (window.f0ckAllowedImages && Array.isArray(window.f0ckAllowedImages)) {
                window.f0ckAllowedImages.forEach(h => {
                    const escapedHost = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    allowedHosts.push(`(?:[a-z0-9-]+\\.)*${escapedHost}`);
                });
            }
            const hostsRegexPart = allowedHosts.join('|');
            // "Safe non-whitespace" stops at protocol boundaries so concatenated URLs aren't merged.
            const safeS = `(?:(?!https?:\\/\\/)\\S)`;
            const domainOrRelative = `(?:(?:https?:\\/\\/|\\/\\/)?(?:${hostsRegexPart})|(?:(?<!\\S)|(?<=\\]))(?=\\/[a-zA-Z0-9_\\-]))`;
            const imageRegex = new RegExp(`(?<![\\(\\[])(${domainOrRelative}(?:\\/${safeS}+\\.(?:jpg|jpeg|png|gif|webp)(?:\\?${safeS}+)?))(?![\\)\\]])`, 'gi');
            const rawVideoRegex = new RegExp(`(?<![\\(\\[])(${domainOrRelative}(?:\\/[^\\s\\[\\]\\(\\)]*\\.(?:mp4|webm|ogv|mov)(?:\\?[^\\s\\[\\]\\(\\)]+)?(?:#gif)?))`, 'gi');
            const mentionRegex = /(?<!\[)@([a-zA-Z0-9_\-\.]+)(?!\])|\[@([^\]]+)\]/g;

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
                    } catch (e) { }
                }

                let displayText = text;
                if (isSameSite && (text === href || text === href.replace(/^https?:\/\//, '') || text === href.replace(siteOrigin, ''))) {
                    try {
                        const urlToParse = href.startsWith('//') ? window.location.protocol + href : href;
                        const url = new URL(urlToParse.startsWith('http') ? urlToParse : siteOrigin + (urlToParse.startsWith('/') ? '' : '/') + urlToParse);
                        displayText = url.pathname + url.search + url.hash;
                    } catch (e) { }
                }

                const isMention = href.startsWith('/user/') && text.startsWith('@');
                if (isExternal && !isSameSite) {
                    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${displayText}<i class="fa-solid fa-arrow-up-right-from-square external-link-icon"></i></a>${extraSuffix}`;
                }
                return `<a href="${href}"${titleAttr}${isMention ? ' class="mention"' : ''}>${displayText}</a>${extraSuffix}`;
            };
            renderer.image = function (href, title, text) {
                const src = (typeof href === 'object' && href !== null) ? (href.href || '') : (href || '');
                const alt = text || '';
                const ttl = title ? ` title="${title}"` : '';
                return `<img class="sidebar-comment-img" src="${src}" alt="${alt}"${ttl} loading="lazy">`;
            };

            // Line-by-line rendering to avoid paragraph collapsing and recursion
            const renderedLines = escaped.split('\n').map(line => {
                const trimmed = line.trimStart();
                if (trimmed.startsWith('>') && !trimmed.match(/^>>\d+/)) {
                    // Manual greentext handling — apply emoji if the user preference allows it
                    const quoteContent = line.substring(line.indexOf('>') + 1);
                    const quoteEmojis = window.f0ckSession?.quote_emojis === true;
                    const rendered = quoteEmojis
                        ? quoteContent.replace(/:([a-z0-9_]+):/g, (m, n) => renderEmoji(m, n))
                        : quoteContent;
                    return `<span class="greentext">&gt;${rendered}</span>`;
                }

                // Per-line limit to prevent marked.parse recursion on single giant lines
                if (line.length > 10000) return line;

                if (!line.trim()) return '&nbsp;';

                // Perform replacements on the single line
                let processedLine = line;

                // Handle Mentions
                processedLine = processedLine.replace(mentionRegex, (match, g1, g2) => {
                    const user = g1 || g2;
                    return `<a href="/user/${encodeURIComponent(user)}" class="mention">@${user}</a>`;
                });

                // Handle Comment Context Links (>>ID)
                processedLine = processedLine.replace(/(?<!\w)>>(\d+)/g, (match, id) => {
                    const targetHref = itemId ? `/${itemId}#c${id}` : `#c${id}`;
                    return `<a href="${targetHref}" class="comment-context-link" data-id="${id}">>>${id}</a>`;
                });

                processedLine = processedLine.replace(imageRegex, (match, url) => {
                    let fullUrl = url;
                    if (!url.startsWith('http') && !url.startsWith('//') && !url.startsWith('/')) {
                        fullUrl = '//' + url;
                    }
                    return `![image](${fullUrl})`;
                });

                processedLine = processedLine.replace(rawVideoRegex, (match, url) => {
                    let fullUrl = url;
                    if (!url.startsWith('http') && !url.startsWith('//') && !url.startsWith('/')) fullUrl = '//' + url;
                    return `[video](${fullUrl})`;
                });

                // Use marked for each line individually.
                // Protect URLs and already-formed Markdown link/image tokens from the
                // italic-prevention pass so that underscores in query params
                // (e.g. ?v=_FcvmypiHg4) are never turned into ?v=\_FcvmypiHg4.
                const mdProtected = [];
                // Match [text](url) / ![alt](url) tokens AND bare http(s) URLs
                let mdSafe = processedLine.replace(
                    /(!?\[[^\]]*\]\([^)]*\))|https?:\/\/\S+/g,
                    (match) => {
                        const idx = mdProtected.length;
                        mdProtected.push(match);
                        return `\x02MDURL${idx}\x03`;
                    }
                );
                // Escape * and _ only in the non-URL portions
                mdSafe = mdSafe
                    .replace(/\\/g, '\\\\')
                    .replace(/\*/g, '\\*')
                    .replace(/_/g, '\\_');
                // Restore protected URLs/tokens
                mdSafe = mdSafe.replace(/\x02MDURL(\d+)\x03/g, (_, i) => mdProtected[+i]);

                let rendered = marked.parseInline ? marked.parseInline(mdSafe, { renderer: renderer }) : marked.parse(mdSafe, { renderer: renderer }).replace(/<p>|<\/p>/g, '');

                // Render emojis ONLY if this is NOT a quote line OR if the user prefers it
                const quoteEmojis = window.f0ckSession?.quote_emojis === true;
                if (!trimmed.startsWith('>') || quoteEmojis) {
                    rendered = rendered.replace(/:([a-z0-9_]+):/g, (m, n) => renderEmoji(m, n));
                }

                return rendered;
            });

            let md = renderedLines.join('\n');

            // YouTube label replacement: show icon + labeled link
            md = md.replace(
                /<a\s[^>]*href="https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:[^"]*&(?:amp;)?)?v=|youtu\.be\/)([a-zA-Z0-9_\-]{11})[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
                (match, videoId) => {
                    const hrefMatch = match.match(/href="([^"]+)"/i);
                    const ytHref = hrefMatch ? hrefMatch[1] : '#';
                    const targetHref = (itemId && commentId) ? `/${itemId}#c${commentId}` : (commentId ? `#sc${commentId}` : ytHref);
                    const externalAttr = (itemId && commentId) || commentId ? '' : ' target="_blank" rel="noopener noreferrer"';
                    return `<a href="${targetHref}"${externalAttr} class="sidebar-video-link" data-yt-id="${videoId}"><i class="fa-brands fa-youtube"></i> <span class="yt-title"></span></a>`;
                }
            );

            // Vocaroo label replacement
            md = md.replace(
                /<a\s[^>]*href="https?:\/\/(?:www\.)?(?:voca\.ro|vocaroo\.com)\/([a-zA-Z0-9_-]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
                (match, vocarooId) => {
                    if (['upload', 'contact', 'privacy', 'tos', 'about'].includes(vocarooId.toLowerCase())) return match;
                    const hrefMatch = match.match(/href="([^"]+)"/i);
                    const vocaHref = hrefMatch ? hrefMatch[1] : '#';
                    const targetHref = (itemId && commentId) ? `/${itemId}#c${commentId}` : (commentId ? `#sc${commentId}` : vocaHref);
                    const externalAttr = (itemId && commentId) || commentId ? '' : ' target="_blank" rel="noopener noreferrer"';
                    return `<a href="${targetHref}"${externalAttr} class="sidebar-video-link"><i class="fa-solid fa-microphone"></i> <span>Vocaroo Audio</span></a>`;
                }
            );

            // Abyss label replacement
            md = md.replace(
                /<a\s[^>]*href="(?:https?:\/\/[^\/]+)?\/abyss(?:#|\/)(\d+)"[^>]*>([\s\S]*?)<\/a>/gi,
                (match, abyssId) => {
                    return `<a href="/abyss/${abyssId}" class="sidebar-abyss-link" data-abyss-id="${abyssId}"><i class="fa-solid fa-dice-d6"></i> /abyss/${abyssId}</a>`;
                }
            );

            // Build regex for allowed media hosters (video/audio)
            const escapedSiteHost = window.location.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const mediaHosts = [escapedSiteHost];
            if (window.f0ckAllowedImages && Array.isArray(window.f0ckAllowedImages)) {
                window.f0ckAllowedImages.forEach(h => {
                    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    mediaHosts.push(`(?:[a-z0-9-]+\\.)*${escaped}`);
                });
            }
            const mediaHostsPart = mediaHosts.join('|');
            const mediaDomainOrRelative = `(?:(?:https?:\\/\\/|\\/\\/)?(?:${mediaHostsPart})|(?=\\/[a-zA-Z0-9_\\-]))`;

            // Video label replacement: instead of embedding, show a link
            const videoEmbedRegex = new RegExp(`<a\\s[^>]*href="(${mediaDomainOrRelative}(?:\\/[^\\s\\[\\]\\(\\)]+\\.(?:mp4|webm|ogv|mov)(?:\\?[^\\s\\[\\]\\(\\)]+)?(?:#gif)?))"[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
            md = md.replace(videoEmbedRegex, (match, url) => {
                const isConvertedGif = url.endsWith('#gif');
                const cleanUrl = url.replace(/#gif$/, '');
                // Converted GIFs → inline autoplay in sidebar too
                if (isConvertedGif) {
                    return `<span class="video-embed-wrap"><video src="${cleanUrl}" class="sidebar-comment-img autoplay-gif" loop muted playsinline preload="auto"></video></span>`;
                }
                let isSameSite = false;
                try {
                    const urlToParse = cleanUrl.startsWith('//') ? window.location.protocol + cleanUrl : cleanUrl;
                    const urlObj = new URL(urlToParse, siteOrigin);
                    isSameSite = (urlObj.hostname === window.location.hostname);
                } catch (e) {
                    isSameSite = cleanUrl.startsWith(siteOrigin) || (cleanUrl.startsWith('/') && !cleanUrl.startsWith('//'));
                }
                const label = isSameSite ? 'Video Link' : 'External Video Link';
                const targetHref = (itemId && commentId) ? `/${itemId}#c${commentId}` : (commentId ? `#sc${commentId}` : cleanUrl);
                const externalAttr = (itemId && commentId) || commentId ? '' : ' target="_blank" rel="noopener noreferrer"';
                return `<a href="${targetHref}"${externalAttr} class="sidebar-video-link"><i class="fa-solid fa-film"></i> ${label} &raquo;</a>`;
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

            if (window.Sanitizer && typeof window.Sanitizer.clean === 'function') {
                md = window.Sanitizer.clean(md);
            }

            // Strip #gif from final text if it leaked through
            return md.replace(/#gif/g, '');
        } catch (e) {
            return content;
        }
    };

    const SIDEBAR_MAX_CHARS = 200;
    const SIDEBAR_MAX_EMOJIS = 12;

    const renderCommentAttachments = (files, content = '') => {
        if (!files || files.length === 0) return '';
        const items = files.map(f => {
            const url = `/c/${f.dest}`;
            if (content.includes(url)) return ''; // Skip if already rendered in content
            if (f.mime.startsWith('image/')) {
                return `<a href="${url}" target="_blank" class="cf-attachment cf-image"><img src="${url}" class="sidebar-comment-img" alt="${escapeHtml(f.original_filename || 'image')}" loading="lazy"></a>`;
            } else if (f.mime.startsWith('video/')) {
                return `<div class="cf-attachment cf-video"><video src="${url}" class="sidebar-comment-img" controls preload="metadata"></video></div>`;
            } else if (f.mime.startsWith('audio/')) {
                return `<div class="cf-attachment cf-audio"><audio src="${url}" controls preload="metadata"></audio></div>`;
            }
            return '';
        }).join('');
        return items ? `<div class="comment-attachments">${items}</div>` : '';
    };

    const renderSidebarPoll = (poll, commentId, itemId) => {
        if (!poll) return '';
        const href = (itemId && commentId) ? `/${itemId}#c${commentId}` : (commentId ? `#sc${commentId}` : '#');
        return `<a class="sidebar-poll-preview" href="${href}"><i class="fa-solid fa-chart-bar"></i> ${escapeHtml(poll.question)}</a>`;
    };

    const renderActivityItem = (c) => {
        const rawContent = c.content || c.body || '';
        const displayContent = renderCommentContent(rawContent, c.id, c.item_id);
        const attachmentsHtml = renderCommentAttachments(c.files, rawContent);
        const pollHtml = renderSidebarPoll(c.poll, c.id, c.item_id);

        // Build avatar URL — same priority as the rest of the app
        let avatarSrc = '/a/default.png';
        if (c.avatar_file) {
            avatarSrc = `/a/${c.avatar_file}`;
        } else if (c.avatar) {
            avatarSrc = `/t/${c.avatar}.webp`;
            if (window.applyThumbCacheBust) avatarSrc = window.applyThumbCacheBust(avatarSrc);
        }

        const timeStr = c.created_at
            ? (window.f0ckTimeAgo ? window.f0ckTimeAgo(c.created_at) : (c.timeago || c.created_at))
            : (c.timeago || 'just now');
        const tsAttr = c.created_at ? ` data-ts="${escapeHtml(c.created_at)}" data-iso="${escapeHtml(c.created_at)}"` : '';
        const fullDate = c.created_at
            ? (window.f0ckFormatDateFull ? window.f0ckFormatDateFull(c.created_at) : new Date(c.created_at).toISOString())
            : '';

        let itemPreview = '';
        if (c.item_id) {
            let mediaHtml = '';
            const rClass = c.item_rating_class || 'untagged';
            const blurNsfw = localStorage.getItem('blurNsfw') === 'true';
            const blurNsfl = localStorage.getItem('blurNsfl') === 'true';
            const blurSfw = localStorage.getItem('blurSfw') === 'true';
            const blurUntagged = localStorage.getItem('blurUntagged') === 'true';

            let isBlurred = false;
            if (rClass === 'nsfw' && blurNsfw) isBlurred = true;
            else if (rClass === 'nsfl' && blurNsfl) isBlurred = true;
            else if (rClass === 'sfw' && blurSfw) isBlurred = true;
            else if (rClass === 'untagged' && blurUntagged) isBlurred = true;

            let thumbUrl = `/t/${c.item_id}.webp`;
            if (isBlurred) {
                thumbUrl = `/t/${c.item_id}_blur.webp`;
            }

            if (window.applyThumbCacheBust) thumbUrl = window.applyThumbCacheBust(thumbUrl);

            mediaHtml = `<img src="${thumbUrl}" style="width: 32px; height: 32px; object-fit: cover; border-radius: 2px;" loading="lazy" onerror="this.style.display='none'" />`;

            itemPreview = `
                <div class="item-preview">
                    <a href="/${c.item_id}" class="sidebar-thumb-link" data-mode="${rClass}">${mediaHtml}</a>
                    <a href="/${c.item_id}#c${c.id}" style="font-size: 0.8em; color: var(--accent); text-decoration: none;">${(window.f0ckI18n && window.f0ckI18n.sidebar_view) || 'View'} &raquo;</a>
                </div>`;
        }

        return `
            <div class="comment" id="sc${c.id}">
                <div class="comment-body">
                    <div class="comment-header">
                        <div class="comment-header-left">
                            <a href="/user/${c.username.toLowerCase()}" class="sidebar-avatar-link">
                                <img src="${avatarSrc}" class="sidebar-avatar" loading="eager" onload="this.classList.add('loaded')" onerror="this.classList.add('loaded');this.src='/a/default.png'" />
                            </a>
                            <a href="/user/${c.username.toLowerCase()}" class="comment-author" ${c.username_color ? `style="color: ${c.username_color}"` : ''}>${escapeHtml(c.display_name || c.username)}</a>
                        </div>
                        <span class="comment-time timeago" tooltip="${fullDate}" style="font-size: 0.75em;"${tsAttr}>${timeStr}</span>
                    </div>
                    <div class="comment-content"><div class="comment-content-inner">${displayContent}${attachmentsHtml}${pollHtml}</div><button class="read-more-btn">${window.f0ckI18n?.sidebar_read_more || 'read more'}</button></div>
                    ${itemPreview}
                </div>
            </div>`;
    };


    const checkOverflow = () => {
        document.querySelectorAll('.sidebar-activity .comment-content-inner').forEach(inner => {
            const container = inner.parentElement;
            const btn = container.querySelector('.read-more-btn');
            if (!btn) return;

            // If expanded, always show "see less"
            if (container.classList.contains('expanded')) {
                btn.style.display = 'block';
                btn.textContent = window.f0ckI18n?.sidebar_see_less || 'see less';
                return;
            }

            if (inner.scrollHeight > inner.clientHeight + 2) { // 2px buffer for rounding
                btn.style.display = 'block';
                btn.textContent = window.f0ckI18n?.sidebar_read_more || 'read more';
                container.classList.add('has-overflow');
            } else {
                btn.style.display = 'none';
                container.classList.remove('has-overflow');
            }
        });
    };

    const attachMediaLoadListeners = (element) => {
        element.querySelectorAll('img, video').forEach(media => {
            if (media.dataset.loadListenerBound) return;
            media.dataset.loadListenerBound = 'true';

            media.addEventListener('load', checkOverflow, { once: true });
            media.addEventListener('loadedmetadata', checkOverflow, { once: true });
        });
    };

    // Event delegation — read-more expands, see-less collapses
    document.addEventListener('click', (e) => {
        // Read more / See less
        const readBtn = e.target.closest('.read-more-btn');
        if (readBtn) {
            const contentDiv = readBtn.closest('.comment-content');
            if (contentDiv) {
                contentDiv.classList.toggle('expanded');
                checkOverflow(); // Re-sync button text and visibility
            }
            return;
        }
    });

    const SIDEBAR_SKELETON_COUNT = 15;

    const showSkeletons = () => {
        const container = document.getElementById('sidebar-activity-container');
        if (!container) return;
        container.innerHTML = `
            <div class="sidebar-loading-state">
                <i class="fa-solid fa-circle-notch fa-spin"></i>
                <span>${window.f0ckI18n?.sidebar_loading_activity || 'Loading activity...'}</span>
            </div>
        `;
    };

    const renderFromCache = () => {
        const container = document.getElementById('sidebar-activity-container');
        if (!container || window._sidebarActivityCache.length === 0) return false;

        let html = '';
        window._sidebarActivityCache.forEach(c => {
            html += renderActivityItem(c);
        });

        container.innerHTML = html;
        // Re-append IO sentinel so the scroll observer keeps working after re-renders
        if (ioSentinel) {
            container.appendChild(ioSentinel);
        }
        attachMediaLoadListeners(container);
        checkOverflow();
        fetchSidebarYoutubeTitles(container);
        // Auto-play converted GIF videos
        container.querySelectorAll('video.autoplay-gif').forEach(v => { v.autoplay = true; v.muted = true; v.play().catch(() => { v.addEventListener('canplay', () => v.play().catch(() => { }), { once: true }); }); });
        return true;
    };

    const SIDEBAR_PAGE_LIMIT = 15;
    const SIDEBAR_INITIAL_LIMIT = 15;

    const loadActivity = async (silent = false) => {
        const container = document.getElementById('sidebar-activity-container');
        if (!container || loading) return;

        const hasCache = renderFromCache();
        // If no cache and not silent: show skeletons while we fetch.
        // On the very first page load the server-rendered skeletons are already there;
        // on subsequent loads (e.g. mode change) we inject them programmatically.
        if (!hasCache && !silent) {
            showSkeletons();
        }


        loading = true;
        currentPage = 1;
        hasMore = true;
        try {
            const mode = typeof window.activeMode !== 'undefined' ? window.activeMode : '';
            const res = await fetch(`/activity?json=true&page=1&limit=${SIDEBAR_INITIAL_LIMIT}&mode=${mode}`, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            const data = await res.json();

            if (data.success && data.comments && data.comments.length > 0) {
                window._sidebarActivityCache = data.comments.map(c => ({
                    ...c,
                    body: c.content || c.body
                }));
                hasMore = data.hasMore === true || data.comments.length === SIDEBAR_INITIAL_LIMIT;
                renderFromCache();
                // Also check after a delay to account for image/emoji loading shifts
                setTimeout(checkOverflow, 500);
            } else if (!hasCache) {
                container.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">' + (window.f0ckI18n?.sidebar_no_activity || 'No recent activity.') + '</div>';
                hasMore = false;
            }
        } catch (e) {
            console.error("Sidebar Activity: Failed to load activity", e);
            if (!hasCache) {
                container.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">' + (window.f0ckI18n?.sidebar_failed_to_load || 'Failed to load.') + '</div>';
            }
            hasMore = false;
        } finally {
            loading = false;
        }
    };


    const loadMoreActivity = async () => {
        const container = document.getElementById('sidebar-activity-container');
        if (!container || loading || loadingMore || !hasMore) return;

        loadingMore = true;
        // Use the current cache length as the exact offset so there's never a gap,
        // regardless of the initial fetch limit.
        const nextOffset = window._sidebarActivityCache.length;

        // Show a subtle loading row at the bottom
        const sentinel = document.createElement('div');
        sentinel.id = 'sidebar-load-more-sentinel';
        sentinel.style.cssText = 'text-align:center;padding:8px 0;font-size:0.78em;color:#666;';
        sentinel.textContent = window.f0ckI18n?.sidebar_loading_more || 'Loading…';
        container.appendChild(sentinel);

        try {
            const mode = typeof window.activeMode !== 'undefined' ? window.activeMode : '';
            const res = await fetch(`/activity?json=true&offset=${nextOffset}&limit=${SIDEBAR_PAGE_LIMIT}&mode=${mode}`, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            const data = await res.json();

            // Remove sentinel before inserting real content
            const s = document.getElementById('sidebar-load-more-sentinel');
            if (s) s.remove();

            if (data.success && data.comments && data.comments.length > 0) {
                currentPage++;
                hasMore = data.hasMore === true;

                // Append only comments not already in the cache
                const existingIds = new Set(window._sidebarActivityCache.map(c => String(c.id)));
                const newComments = data.comments.filter(c => !existingIds.has(String(c.id))).map(c => ({
                    ...c,
                    body: c.content || c.body
                }));

                window._sidebarActivityCache.push(...newComments);

                // Append new items to DOM
                let html = '';
                newComments.forEach(c => { html += renderActivityItem(c); });
                if (html) {
                    const temp = document.createElement('div');
                    temp.innerHTML = html;
                    while (temp.firstElementChild) {
                        container.appendChild(temp.firstElementChild);
                    }
                    // Keep the IO sentinel at the very end so it triggers on the next scroll
                    if (ioSentinel) container.appendChild(ioSentinel);
                    attachMediaLoadListeners(container);
                    checkOverflow();
                    fetchSidebarYoutubeTitles(container);
                    // Auto-play converted GIF videos
                    container.querySelectorAll('video.autoplay-gif').forEach(v => { v.autoplay = true; v.muted = true; v.play().catch(() => { v.addEventListener('canplay', () => v.play().catch(() => { }), { once: true }); }); });
                }
            } else {
                hasMore = false;
                // Show end-of-feed indicator
                const end = document.createElement('div');
                end.style.cssText = 'text-align:center;padding:8px 0;font-size:0.75em;color:#444;';
                end.textContent = window.f0ckI18n?.sidebar_end_of_activity || '─ end of activity ─';
                container.appendChild(end);
            }
        } catch (e) {
            console.error("Sidebar Activity: Failed to load more", e);
            const s = document.getElementById('sidebar-load-more-sentinel');
            if (s) s.remove();
        } finally {
            loadingMore = false;
        }
    };

    const handleNewActivity = (data) => {
        const container = document.getElementById('sidebar-activity-container');

        // 1. Deduplicate: check if this comment ID is already in the cache
        if (window._sidebarActivityCache.some(c => parseInt(c.id) === parseInt(data.id))) {
            window.f0ckDebug("Sidebar Activity: Duplicate comment ignored", data.id);
            return;
        }

        // 2. Update cache (prepend, no hard cap — infinite scroll handles depth)
        const newItem = {
            ...data,
            body: data.body || data.content,
            timeago: (window.f0ckI18n && window.f0ckI18n.timeago_just_now) || 'just now'
        };
        window._sidebarActivityCache.unshift(newItem);

        // Update DOM if visible
        if (container) {
            const html = renderActivityItem(newItem);
            const temp = document.createElement('div');
            temp.innerHTML = html;
            const node = temp.firstElementChild;
            if (node) {
                node.classList.add('new-item-fade');
                container.prepend(node);
                attachMediaLoadListeners(node);
                checkOverflow();
                fetchSidebarYoutubeTitles(container);
            }
        }
    };

    const init = async () => {
        // Run emoji loading and activity fetching in parallel — avatars appear
        // immediately without waiting for the emoji API to respond first.
        // After both settle, if emojis finished after the initial render, re-render
        // from cache so custom emoji images show on first page load.
        const emojiPromise = loadEmojis();
        const activityPromise = loadActivity();
        await activityPromise;
        await emojiPromise;
        // If emojis were not yet available when activity first rendered, re-render now.
        if (Object.keys(customEmojis).length > 0 && window._sidebarActivityCache.length > 0) {
            renderFromCache();
        }
    };

    // Listen for live activity from f0ckm.js
    document.addEventListener('f0ck:activityReceived', (e) => {
        window.f0ckDebug("Sidebar Activity: Live update received", e.detail);
        handleNewActivity(e.detail);
    });

    const handleLiveEdit = (data) => {
        const container = document.getElementById('sidebar-activity-container');

        // 1. Update cache
        if (window._sidebarActivityCache) {
            const comment = window._sidebarActivityCache.find(c => String(c.id) === String(data.comment_id));
            if (comment) {
                comment.content = data.content;
                comment.body = data.content;
            }
        }

        // 2. Update DOM if visible
        if (container) {
            const el = document.getElementById('sc' + data.comment_id);
            if (el) {
                const inner = el.querySelector('.comment-content-inner');
                if (inner) {
                    const comment = window._sidebarActivityCache.find(c => String(c.id) === String(data.comment_id));
                    inner.innerHTML = renderCommentContent(data.content, data.comment_id, comment ? comment.item_id : null);
                    el.classList.remove('new-item-fade');
                    void el.offsetWidth;
                    el.classList.add('new-item-fade');
                    attachMediaLoadListeners(inner);
                    checkOverflow();
                    fetchSidebarYoutubeTitles(el);
                    // Auto-play converted GIF videos
                    inner.querySelectorAll('video.autoplay-gif').forEach(v => { v.autoplay = true; v.muted = true; v.play().catch(() => { v.addEventListener('canplay', () => v.play().catch(() => { }), { once: true }); }); });
                }
            }
        }
    };

    window.addEventListener('f0ck:comment_edited', (e) => {
        window.f0ckDebug("Sidebar Activity: Live edit received", e.detail);
        handleLiveEdit(e.detail);
    });

    let lastBoundMode = typeof window.activeMode !== 'undefined' ? window.activeMode : null;

    // Handle AJAX item loads
    document.addEventListener('f0ck:contentLoaded', () => {
        const currentMode = typeof window.activeMode !== 'undefined' ? window.activeMode : null;
        const modeChanged = lastBoundMode !== null && lastBoundMode !== currentMode;
        lastBoundMode = currentMode;

        window.f0ckDebug("Sidebar Activity: Page transition detected", modeChanged ? "(Mode changed)" : "");

        if (modeChanged) {
            window._sidebarActivityCache = [];
            currentPage = 1;
            hasMore = true;
            loadActivity(false); // Force reload with loading state
        } else {
            // Immediately render from cache to avoid flicker
            renderFromCache();
            // Background sync
            loadActivity(true);
        }
    });

    // Sync sidebar and comments-list layout on initial page load (Legacy View Only)
    if (typeof syncSidebarAndComments === 'function') {
        syncSidebarAndComments();
    }

    // Handle explicit mode changes (e.g. from item page where full transition doesn't occur)
    document.addEventListener('f0ck:modeChanged', (e) => {
        window.f0ckDebug("Sidebar Activity: Mode change detected", e.detail.mode);
        lastBoundMode = e.detail.mode;
        window._sidebarActivityCache = [];
        currentPage = 1;
        hasMore = true;
        loadActivity(false);
    });

    // When the current user posts a comment, silently refresh sidebar to show it
    document.addEventListener('f0ck:commentPosted', () => {
        window.f0ckDebug("Sidebar Activity: Own comment posted, refreshing...");
        loadActivity(true);
    });

    // Infinite scroll: load older comments when scrolling near the bottom
    const bindScrollListener = () => {
        const container = document.getElementById('sidebar-activity-container');
        if (!container) return;

        // Use IntersectionObserver if available (performant), fallback to scroll event
        if (typeof IntersectionObserver !== 'undefined') {
            // Create the sentinel once at module level so re-renders can re-append the same node
            if (!ioSentinel) {
                ioSentinel = document.createElement('div');
                ioSentinel.id = 'sidebar-io-sentinel';
                ioSentinel.style.height = '1px';
                container.appendChild(ioSentinel);
            }

            const observer = new IntersectionObserver((entries) => {
                if (entries[0].isIntersecting && hasMore && !loadingMore && !loading) {
                    loadMoreActivity();
                }
            }, { root: container, rootMargin: '0px 0px 80px 0px', threshold: 0 });

            observer.observe(ioSentinel);
        } else {
            container.addEventListener('scroll', () => {
                if (loading || loadingMore || !hasMore) return;
                const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 100;
                if (nearBottom) loadMoreActivity();
            }, { passive: true });
        }
    };

    // Initial load
    const _origInit = init;
    const initWithScroll = async () => {
        await _origInit();
        bindScrollListener();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWithScroll);
    } else {
        initWithScroll();
    }

    // Live updates are handled via SSE (f0ck:activityReceived event)
})();
