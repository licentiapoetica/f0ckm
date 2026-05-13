window.escapeHtmlUpload = window.escapeHtmlUpload || ((unsafe) => {
    return (unsafe || '').toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
});

window.initUploadForm = (selector) => {
    const form = (typeof selector === 'string') ? document.querySelector(selector) : selector;
    if (!form) return;

    // Prevent double-init
    if (form._f0ckInit) return form._f0ckUploader;
    form._f0ckInit = true;

    // Use querySelector to find elements within this specific form instance
    const fileInput = form.querySelector('.file-input');
    const dropZone = form.querySelector('.drop-zone');
    const filePreview = form.querySelector('.file-preview');
    const dropZonePrompt = dropZone?.querySelector('.drop-zone-prompt');
    const fileName = form.querySelector('.file-name');
    const fileSize = form.querySelector('.file-size');
    const removeFile = form.querySelector('.btn-remove');
    const tagInput = form.querySelector('.tag-input');
    const tagsList = form.querySelector('.tags-list');
    const tagsHidden = form.querySelector('.tags-hidden');
    const tagCount = form.querySelector('.tag-count');
    const tagSuggestions = form.querySelector('.tag-suggestions');
    const submitBtn = form.querySelector('.btn-upload');
    const progressContainer = form.querySelector('.upload-progress');
    const progressFill = form.querySelector('.progress-fill');
    const progressText = form.querySelector('.progress-text');
    const statusDiv = form.querySelector('.upload-status');
    const thumbSection = form.querySelector('#custom-thumbnail-section');
    const thumbInput = form.querySelector('#upload-thumbnail-input');

    // Capture the SSR-translated initial button text so updateSubmitButton
    // always uses the correct language regardless of window.f0ckI18n state.
    const btnTextEl = submitBtn ? submitBtn.querySelector('.btn-text') : null;
    const ssrSelectFileText = btnTextEl ? btnTextEl.textContent.trim() : null;

    // Close modal when clicking a link in statusDiv (e.g. "View existing")
    if (statusDiv) {
        statusDiv.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (link) {
                const dragModal = form.closest('#upload-drag-modal');
                if (dragModal) {
                    dragModal.classList.remove('show');
                    document.body.classList.remove('modal-open');
                    if (form._f0ckUploader && typeof form._f0ckUploader.reset === 'function') {
                        form._f0ckUploader.reset();
                    }
                }
            }
        });
    }


    // URL mode elements
    const urlInput = form.querySelector('#url-upload-input');
    const urlBadge = form.querySelector('#url-type-badge');
    const modeTabs = form.querySelectorAll('.upload-mode-tab');
    const modeFile = form.querySelector('#mode-file');
    const modeUrl = form.querySelector('#mode-url');

    const ytRegex = /(?:youtube\.com\/\S*(?:(?:\/e(?:mbed))?\/|watch\/?\?(?:\S*?&?v\=))|youtu\.be\/)([a-zA-Z0-9_-]{6,11})/i;

    // Dynamically get min tags requirement from DOM
    const minTags = parseInt(form.getAttribute('data-min-tags') || '3');

    const isShitpost = form.classList.contains('shitpost-mode-active') || !!window.f0ckShitpostMode;
    let tags = [];
    let autoTags = []; // Track tags suggested from metadata
    let selectedFiles = []; // Array of files for shitpost_mode
    let activeMode = 'file'; // 'file' or 'url'

    // If shitpost mode is active, the global rating is hidden and per-item ratings are used.
    // We must remove the 'required' attribute from global radios to prevent browser from blocking submission.
    if (isShitpost) {
        form.querySelectorAll('input[name="rating"]').forEach(r => {
            r.required = false;
        });
    }

    // --- Emoji picker for upload comment ---
    const uploadCommentContainer = form.querySelector('.upload-comment-input');
    if (uploadCommentContainer) {
        const initUploadEmoji = async () => {
            // Reuse CommentSystem emoji picker if available
            if (window.commentSystem && typeof window.commentSystem.setupEmojiPicker === 'function') {
                // Ensure emojis are loaded (they won't be on upload page since no comments container)
                if (!CommentSystem.emojiCache || Object.keys(window.commentSystem.customEmojis).length === 0) {
                    await window.commentSystem.loadEmojis();
                }
                window.commentSystem.setupEmojiPicker(uploadCommentContainer);
                // Remove lock-thread button — doesn't belong on upload form
                const lockBtn = uploadCommentContainer.querySelector('#lock-thread-btn');
                if (lockBtn) lockBtn.remove();
            } else {
                // Standalone: load emojis and wire up trigger
                const textarea = uploadCommentContainer.querySelector('textarea');
                if (!textarea) return;

                let emojis = null;
                try {
                    const res = await fetch('/api/v2/emojis');
                    const data = await res.json();
                    if (data.success) {
                        emojis = {};
                        data.emojis.forEach(e => { emojis[e.name] = e.url; });
                    }
                } catch (e) { console.error('Failed to load emojis', e); }

                if (!emojis || Object.keys(emojis).length === 0) return;

                const actions = uploadCommentContainer.querySelector('.input-actions');
                if (!actions) return;

                const trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.innerText = '☺';
                trigger.className = 'emoji-trigger';
                actions.prepend(trigger);

                let picker = null;
                trigger.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (picker) {
                        picker.style.display = picker.style.display === 'none' ? '' : 'none';
                        return;
                    }
                    picker = document.createElement('div');
                    picker.className = 'emoji-picker';
                    Object.keys(emojis).forEach(name => {
                        const img = document.createElement('img');
                        img.src = emojis[name];
                        img.title = `:${name}:`;
                        img.loading = 'lazy';
                        img.onerror = () => { img.style.display = 'none'; };
                        img.onclick = (ev) => {
                            ev.stopPropagation();
                            textarea.value += ` :${name}: `;
                            textarea.focus();
                        };
                        picker.appendChild(img);
                    });
                    uploadCommentContainer.appendChild(picker);
                    const closeHandler = (ev) => {
                        if (!picker.contains(ev.target) && ev.target !== trigger) {
                            picker.style.display = 'none';
                            document.removeEventListener('click', closeHandler);
                        }
                    };
                    setTimeout(() => document.addEventListener('click', closeHandler), 0);
                });
            }
        };
        // Delay slightly to let CommentSystem init
        setTimeout(initUploadEmoji, 100);
    }

    // --- Mode tab switching ---
    if (modeTabs.length > 0) {
        modeTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const mode = tab.dataset.mode;
                if (mode === activeMode) return;
                activeMode = mode;

                modeTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                if (modeFile) modeFile.style.display = mode === 'file' ? '' : 'none';
                if (modeUrl) modeUrl.style.display = mode === 'url' ? '' : 'none';

                // Reset status
                if (statusDiv) {
                    statusDiv.textContent = '';
                    statusDiv.className = 'upload-status';
                }
                if (progressContainer) progressContainer.style.display = 'none';

                updateSubmitButton();
            });
        });
    }

    // --- Keyboard shortcuts for Upload Modal ---
    const handleUploadShortcuts = (e) => {
        // Only run if the modal is visible or if we are on the dedicated upload page
        const dragModal = form.closest('#upload-drag-modal');
        const isModalOpen = dragModal && dragModal.classList.contains('show');
        const isUploadPage = window.location.pathname === '/upload';
        
        if (!isModalOpen && !isUploadPage) return;

        // Don't trigger if user is typing in an input or textarea
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        // One cycle per press
        if (e.repeat) return;

        const key = e.key.toLowerCase();

        // 'p' cycles ratings: SFW -> NSFW -> (NSFL) -> SFW
        if (key === 'p') {
            e.preventDefault();
            e.stopPropagation();

            const ratings = Array.from(form.querySelectorAll('input[name="rating"]'));
            if (ratings.length > 0) {
                const checkedIndex = ratings.findIndex(r => r.checked);
                let nextIndex = (checkedIndex + 1) % ratings.length;
                if (checkedIndex === -1) nextIndex = 0; // Default to first if none checked
                ratings[nextIndex].checked = true;
                ratings[nextIndex].dispatchEvent(new Event('change'));
            }
        }

        // 't' toggles modes: File <-> URL
        if (key === 't') {
            e.preventDefault();
            e.stopPropagation();

            const currentActiveTab = form.querySelector('.upload-mode-tab.active');
            const tabs = Array.from(form.querySelectorAll('.upload-mode-tab'));
            if (tabs.length > 1) {
                const currentIndex = tabs.indexOf(currentActiveTab);
                const nextIndex = (currentIndex + 1) % tabs.length;
                tabs[nextIndex].click();
                
                // Focus URL input if we switched to URL mode
                if (tabs[nextIndex].dataset.mode === 'url' && urlInput) {
                    setTimeout(() => urlInput.focus(), 50);
                }
            }
        }

        // 'Ctrl + .' focuses the comment input
        if (e.key === '.' && (e.ctrlKey || e.metaKey)) {
            const commentInput = form.querySelector('.upload-comment');
            if (commentInput) {
                e.preventDefault();
                e.stopPropagation();
                commentInput.focus();
            }
        }

        // 'i' focuses the tag input
        if (key === 'i') {
            const tagInput = form.querySelector('.tag-input');
            if (tagInput) {
                e.preventDefault();
                e.stopPropagation();
                tagInput.focus();
            }
        }

        // Block 'z' (Random) from triggering in the background
        if (key === 'z') {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    window.addEventListener('keydown', handleUploadShortcuts, true); // Use capture phase to block theme cycling and rating toggle on the item page


    // --- URL type detection & Metadata extraction ---
    let metaDebounce = null;
    let lastFetchedUrl = '';

    if (urlInput) {
        const fetchMetadata = async (url) => {
            const currentVal = urlInput.value.trim();
            if (!currentVal || currentVal !== url) return;

            const isDirectMedia = /\.(mp4|webm|mp3|ogg|opus|flac|m4a|mkv|jpg|jpeg|png|gif|webp|swf)$/i.test(currentVal);
            if (isDirectMedia) return;

            lastFetchedUrl = currentVal;

            if (urlBadge) {
                const originalText = urlBadge.textContent;
                const originalClass = urlBadge.className;
                const originalDisplay = urlBadge.style.display;
                urlBadge.innerHTML = '<span class="loading-spinner"></span> Fetching...';
                urlBadge.className = 'url-type-badge fetching';
                urlBadge.style.display = 'flex';

                try {
                    const resp = await fetch(`/api/v2/meta/fetch?url=${encodeURIComponent(currentVal)}`);
                    const data = await resp.json();
                    if (data.success && data.meta) {
                        const meta = data.meta;
                        
                        const suggest = (v) => { if (v && typeof v === 'string' && v.trim()) addMetaSuggestion(v.trim()); };
                        const suggestArr = (arr) => { if (Array.isArray(arr)) arr.forEach(suggest); };

                        // Title (prefer og_title, strip site name suffix)
                        let bestTitle = meta.og_title || meta.twitter_title || meta.ld_headline || meta.title || null;
                        if (bestTitle && meta.site_name) {
                            const siteRegex = new RegExp(`\\s*[-|·]\\s*${meta.site_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
                            bestTitle = bestTitle.replace(siteRegex, '').trim();
                        }
                        suggest(bestTitle);

                        // Site / source
                        suggest(meta.site_name);

                        // Description / summary (og or standard — offer as single suggestion)
                        suggest(meta.og_desc || meta.description || meta.twitter_desc || meta.ld_desc);

                        // Author
                        suggest(meta.author || meta.article_author || meta.book_author || meta.music_musician || meta.ld_author || meta.ld_creator);
                        suggest(meta.profile_name);
                        suggest(meta.profile_username);

                        // Keywords (each separate)
                        suggestArr(meta.keywords);
                        suggestArr(meta.news_keywords);
                        suggestArr(meta.ld_keywords);

                        // Article / content classification
                        suggestArr(meta.article_tags);
                        suggest(meta.article_section);
                        suggest(meta.category);
                        suggest(meta.genre || meta.ld_genre);
                        suggest(meta.og_type);

                        // Video tags
                        suggestArr(meta.video_tags);

                        // Music
                        suggest(meta.music_album);
                        suggest(meta.music_song);

                        // Book tags
                        suggestArr(meta.book_tags);

                        // Twitter labels (e.g. "Rating: 5 stars")
                        suggestArr(meta.twitter_labels);

                        // Twitter handles
                        suggest(meta.twitter_creator);

                        // JSON-LD extras
                        suggest(meta.ld_name);
                        suggest(meta.ld_about);

                        // Price
                        if (meta.price_amount) suggest(`${meta.price_amount}${meta.price_currency ? ' ' + meta.price_currency : ''}`);

                        // Language
                        suggest(meta.language);

                        urlBadge.innerHTML = '✓ Metadata Fetched';
                        urlBadge.className = 'url-type-badge success';
                        urlBadge.style.display = 'block';
                        setTimeout(() => {
                            if (urlInput.value.trim() === currentVal) {
                                urlBadge.textContent = originalText;
                                urlBadge.className = originalClass;
                                urlBadge.style.display = originalDisplay;
                            }
                        }, 2500);
                    } else {
                        // Restore on fail
                        urlBadge.textContent = originalText;
                        urlBadge.className = originalClass;
                        urlBadge.style.display = originalDisplay;
                    }
                } catch (e) {
                    console.error('[META FETCH ERROR]', e);
                    urlBadge.textContent = originalText;
                    urlBadge.className = originalClass;
                    urlBadge.style.display = originalDisplay;
                }
            }
        };

        urlInput.addEventListener('input', () => {
            const val = urlInput.value.trim();
            if (!val) {
                if (urlBadge) urlBadge.style.display = 'none';
                lastFetchedUrl = '';
                updateSubmitButton();
                return;
            }

            // Update badge for URL type
            if (urlBadge) {
                if (ytRegex.test(val) && window.f0ckEnableYoutubeUpload !== false) {
                    urlBadge.textContent = '▶ YouTube';
                    urlBadge.className = 'url-type-badge youtube';
                    urlBadge.style.display = 'block';
                    urlBadge.title = 'Click to re-fetch metadata';
                } else if (/^https?:\/\//i.test(val)) {
                    urlBadge.textContent = 'URL';
                    urlBadge.className = 'url-type-badge direct';
                    urlBadge.style.display = 'block';
                    urlBadge.title = 'Click to re-fetch metadata';
                } else {
                    urlBadge.style.display = 'none';
                }
            }

            // Trigger metadata fetch if it looks like a valid URL and not already fetching/fetched
            const isDirectMedia = /\.(mp4|webm|mp3|ogg|opus|flac|m4a|mkv|jpg|jpeg|png|gif|webp|swf)$/i.test(val);
            if (/^https?:\/\//i.test(val) && val !== lastFetchedUrl && !isDirectMedia) {
                clearTimeout(metaDebounce);
                metaDebounce = setTimeout(() => fetchMetadata(val), 800);
            }

            updateSubmitButton();
        });

        // In shitpost mode: auto-commit each pasted URL to the list immediately
        urlInput.addEventListener('paste', (e) => {
            if (!isShitpost) return;
            e.preventDefault();
            const pasted = (e.clipboardData || window.clipboardData).getData('text');
            const lines = pasted.split(/[\n\r]+/).map(u => u.trim()).filter(u => /^https?:\/\//i.test(u));
            if (!lines.length) {
                // Not a URL — let the browser insert it normally into the input
                urlInput.value = pasted.trim();
                urlInput.dispatchEvent(new Event('input'));
                return;
            }
            lines.forEach(url => {
                if (!selectedFiles.some(item => item.type === 'url' && item.url === url)) {
                    selectedFiles.push({ type: 'url', url, rating: '', tags: [], comment: '', is_oc: false });
                }
            });
            urlInput.value = '';
            if (urlBadge) urlBadge.style.display = 'none';
            handleFile();
        });

        if (urlBadge) {
            urlBadge.addEventListener('click', () => {
                const val = urlInput.value.trim();
                if (val && /^https?:\/\//i.test(val)) {
                    lastFetchedUrl = ''; // Force retry
                    fetchMetadata(val);
                }
            });
        }

        // Add URL button (shitpost mode) — commits the typed/pasted URL to the list
        const addUrlFn = () => {
            const val = urlInput.value.trim();
            if (!val || !/^https?:\/\//i.test(val)) return;
            if (!selectedFiles.some(item => item.type === 'url' && item.url === val)) {
                selectedFiles.push({ type: 'url', url: val, rating: '', tags: [], comment: '', is_oc: false });
            }
            urlInput.value = '';
            if (urlBadge) urlBadge.style.display = 'none';
            handleFile();
        };

        const btnAddUrls = form.querySelector('.btn-add-urls');
        if (btnAddUrls) {
            btnAddUrls.addEventListener('click', addUrlFn);
        }

        // Also commit on Enter key inside the URL input in shitpost mode
        if (isShitpost) {
            urlInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); addUrlFn(); }
            });
        }

    }

    const formatSize = (bytes) => {
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        while (bytes >= 1024 && i < units.length - 1) {
            bytes /= 1024;
            i++;
        }
        return bytes.toFixed(2) + ' ' + units[i];
    };

    const updateSubmitButton = () => {
        const isShitpost = !!window.f0ckShitpostMode;
        const rating = form.querySelector('input[name="rating"]:checked');
        
        // In Shitpost Mode, ratings are per-item (optional) and tags are optional — just need files
        const hasRating = (isShitpost && activeMode === 'file') ? true : (rating !== null);
        
        let hasTags = true;
        if (!isShitpost) {
            hasTags = tags.length >= minTags;
        }
        // In shitpost file mode: hasTags is always true (untagged is allowed)

        // Toggle visibility of global rating/comment/tag sections
        const ratingSec = form.querySelector('.global-rating-section');
        const commentSec = form.querySelector('.global-comment-section');
        const tagsSec = form.querySelector('.global-tag-section');
        const ocSec = form.querySelector('.global-oc-section');
        const formActions = form.querySelector('.form-actions');
        if (isShitpost) {
            if (formActions) {
                formActions.style.display = activeMode === 'url' ? 'none' : 'block';
            }
            const hide = activeMode === 'file';
            const disp = hide ? 'none' : 'block';
            
            if (ratingSec) {
                ratingSec.style.display = disp;
                ratingSec.querySelectorAll('input').forEach(i => i.disabled = hide);
            }
            if (commentSec) {
                commentSec.style.display = disp;
                commentSec.querySelectorAll('textarea').forEach(i => i.disabled = hide);
            }
            if (tagsSec) {
                tagsSec.style.display = disp;
                tagsSec.querySelectorAll('input').forEach(i => i.disabled = hide);
            }
            if (ocSec) {
                ocSec.style.display = 'none';
                ocSec.querySelectorAll('input').forEach(i => i.disabled = true);
            }
        }

        let hasContent = false;
        if (activeMode === 'file') {
            hasContent = selectedFiles.length > 0;
        } else {
            hasContent = urlInput && urlInput.value.trim().length > 0;
        }

        if (submitBtn) submitBtn.disabled = !(hasContent && hasRating && hasTags);

        if (submitBtn) {
            const btnText = submitBtn.querySelector('.btn-text');
            if (btnText) {
                const i18n = window.f0ckI18n || {};
                if (!hasContent) {
                    btnText.textContent = activeMode === 'file'
                        ? (ssrSelectFileText || i18n.select_file || 'Select a file')
                        : (i18n.enter_url   || 'Enter a URL');
                } else if (!hasTags) {
                    // non-shitpost only
                    const remaining = minTags - tags.length;
                    const tpl = i18n.tags_required || '{n} more tag{s} required';
                    btnText.textContent = tpl
                        .replace('{n}', remaining)
                        .replace('{s}', remaining !== 1 ? 's' : '');
                } else if (!hasRating) {
                    const nsflEnabled = !!form.querySelector('input[name="rating"][value="nsfl"]');
                    if (nsflEnabled) {
                        btnText.textContent = i18n.select_rating_nsfl || 'Select SFW, NSFW or NSFL';
                    } else {
                        btnText.textContent = i18n.select_rating || 'Select SFW or NSFW';
                    }
                } else {
                    if (activeMode === 'url' && urlInput && ytRegex.test(urlInput.value.trim()) && window.f0ckEnableYoutubeUpload !== false) {
                        btnText.textContent = i18n.embed_youtube    || 'Embed YouTube Video';
                    } else if (activeMode === 'url') {
                        btnText.textContent = i18n.upload_from_url  || 'Upload from URL';
                    } else {
                        btnText.textContent = i18n.upload           || 'Upload';
                    }
                }
            }
        }

        if (tagCount) {
            if (minTags > 0) {
                tagCount.textContent = '(' + tags.length + '/' + minTags + ' minimum)';
                tagCount.classList.toggle('valid', tags.length >= minTags);
            } else {
                tagCount.style.display = 'none';
            }
        }
    };

    const handleFile = (files) => {
        const isShitpost = !!window.f0ckShitpostMode;
        
        // If files were provided, process them (append or replace)
        if (files && files.length > 0) {
            const filesToProcess = isShitpost ? Array.from(files) : [files[0]];
            if (!isShitpost) selectedFiles = []; // Reset for normal mode

            for (const file of filesToProcess) {
                if (!file) continue;
                
                // Basic validation (MIME/Extension/Size)
                const container = form.closest('.upload-container');
                const mimesSource = form.getAttribute('data-mimes') || (container ? container.getAttribute('data-mimes') : null);
                let allowedMimes = [];
                let allowedExts = [];
                try {
                    const mimesObj = JSON.parse(mimesSource || '{}');
                    allowedMimes = Object.keys(mimesObj);
                    allowedExts = [...new Set(Object.values(mimesObj))];
                } catch(e) {
                    allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/x-flac', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'application/x-shockwave-flash', 'application/vnd.adobe.flash.movie'];
                }

                const fileExt = file.name.split('.').pop().toLowerCase();
                const mimeOk = !file.type || allowedMimes.includes(file.type);
                const extOk = allowedExts.length > 0 && allowedExts.includes(fileExt);

                if (allowedMimes.length > 0 && !mimeOk && !extOk) {
                    const errorMsg = `File type ${file.type || '.' + fileExt} is not allowed.`;
                    if (window.showFlash) window.showFlash(errorMsg, 'error');
                    else if (statusDiv) { statusDiv.textContent = errorMsg; statusDiv.className = 'upload-status error'; }
                    continue;
                }

                const maxBytesAttr = form.getAttribute('data-max-bytes');
                if (maxBytesAttr) {
                    const maxBytes = parseInt(maxBytesAttr);
                    if (file.size > maxBytes) {
                        const errorMsg = `File is too large: ${formatSize(file.size)} (Limit: ${formatSize(maxBytes)})`;
                        if (window.showFlash) window.showFlash(errorMsg, 'error');
                        else if (statusDiv) { statusDiv.textContent = errorMsg; statusDiv.className = 'upload-status error'; }
                        continue;
                    }
                }

                if (!selectedFiles.some(f => (f.file || f).name === file.name && (f.file || f).size === file.size)) {
                    if (isShitpost) {
                        selectedFiles.push({ type: 'file', file: file, rating: '', tags: [], comment: '', is_oc: false });
                    } else {
                        selectedFiles.push(file); // Legacy single file mode uses raw File
                    }
                }
            }
        }

        // Rebuild UI state
        if (selectedFiles.length === 0) {
            if (filePreview) {
                filePreview.style.display = 'none';
                filePreview.innerHTML = '';
            }
            if (dropZonePrompt) dropZonePrompt.style.display = 'block';
            if (fileInput) {
                fileInput.value = '';
                fileInput.style.display = 'inline-block';
            }
            updateSubmitButton();
            return false;
        }

        if (dropZonePrompt) dropZonePrompt.style.display = 'none';
        if (fileInput) fileInput.style.display = 'none';
        if (filePreview) {
            filePreview.style.display = 'flex';
            filePreview.innerHTML = '';
        }

        if (statusDiv) {
            statusDiv.textContent = '';
            statusDiv.className = 'upload-status';
        }

        // Force 'file' mode tab UI
        if (activeMode !== 'file' && modeTabs.length > 0) {
            modeTabs.forEach(t => t.classList.remove('active'));
            const fileTab = form.querySelector('.upload-mode-tab[data-mode="file"]');
            if (fileTab) fileTab.classList.add('active');
            if (modeFile) modeFile.style.display = '';
            if (modeUrl) modeUrl.style.display = 'none';
            activeMode = 'file';
        }

        // Build preview items
        selectedFiles.forEach((item, index) => {
            const isUrl = isShitpost && item.type === 'url';
            const file = isUrl ? null : (isShitpost ? item.file : item);
            const previewItem = document.createElement('div');
            previewItem.className = 'file-preview-item' + (isUrl ? ' url-item' : '');
            
            let mediaElem;
            if (isUrl) {
                const isYtMatch = item.url.match(ytRegex);
                if (isYtMatch && window.f0ckEnableYoutubeUpload !== false) {
                    const videoId = isYtMatch[1];
                    mediaElem = document.createElement('iframe');
                    mediaElem.src = `https://www.youtube.com/embed/${videoId}?autoplay=0&mute=1`;
                    mediaElem.width = "100%";
                    mediaElem.height = "100%";
                    mediaElem.frameBorder = "0";
                    mediaElem.allow = "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
                    mediaElem.allowFullscreen = true;
                    mediaElem.style.borderRadius = '4px';
                    mediaElem.style.pointerEvents = 'auto'; // Ensure we can interact with it
                } else {
                    mediaElem = document.createElement('div');
                    mediaElem.className = 'generic-file-icon';
                    mediaElem.innerHTML = '<i class="fa-solid fa-link"></i>';
                }
            } else {
                const fileExt = file.name.split('.').pop().toLowerCase();
                
                if (file.type.startsWith('image/')) {
                    mediaElem = document.createElement('img');
                    mediaElem.src = URL.createObjectURL(file);
                } else if (file.type.startsWith('video/')) {
                    mediaElem = document.createElement('video');
                    mediaElem.src = URL.createObjectURL(file);
                    mediaElem.muted = true;
                    mediaElem.autoplay = true;
                    mediaElem.controls = true;
                    mediaElem.loop = true;
                } else if (file.type.startsWith('audio/')) {
                    mediaElem = document.createElement('audio');
                    mediaElem.src = URL.createObjectURL(file);
                    mediaElem.controls = true;
                    mediaElem.style.width = '100%';
                } else if (file.type === 'application/x-shockwave-flash' || file.type === 'application/vnd.adobe.flash.movie' || fileExt === 'swf') {
                    mediaElem = document.createElement('div');
                    mediaElem.className = 'generic-file-icon swf-preview-icon';
                    mediaElem.innerHTML = '<span style="font-size:1.5em;">⚡</span>';
                } else if (file.type === 'application/pdf' || fileExt === 'pdf') {
                    mediaElem = document.createElement('div');
                    mediaElem.className = 'generic-file-icon pdf-preview-icon';
                    mediaElem.innerHTML = '<i class="fa-solid fa-file-pdf"></i>';
                } else {
                    mediaElem = document.createElement('div');
                    mediaElem.className = 'generic-file-icon';
                    mediaElem.innerHTML = '<i class="fa-solid fa-file"></i>';
                }
            }
            mediaElem.classList.add('preview-media-small');

            const infoRow = document.createElement('div');
            infoRow.className = 'file-meta-row-small';
            
            let ratingSwitch = '';
            let tagsUI = '';
            let ocUI = '';
            let commentUI = '';
            if (isShitpost) {
                const nsflEnabled = !!form.querySelector('input[name="rating"][value="nsfl"]');
                ratingSwitch = `
                    <div class="item-rating-container">
                        <label class="item-rating-option">
                            <input type="radio" name="rating_${index}" value="sfw" ${item.rating === 'sfw' ? 'checked' : ''}>
                            <span class="item-rating-label sfw">SFW</span>
                        </label>
                        <label class="item-rating-option">
                            <input type="radio" name="rating_${index}" value="nsfw" ${item.rating === 'nsfw' ? 'checked' : ''}>
                            <span class="item-rating-label nsfw">NSFW</span>
                        </label>
                        ${nsflEnabled ? `
                        <label class="item-rating-option">
                            <input type="radio" name="rating_${index}" value="nsfl" ${item.rating === 'nsfl' ? 'checked' : ''}>
                            <span class="item-rating-label nsfl">NSFL</span>
                        </label>
                        ` : ''}
                    </div>
                `;

                const tagsPlaceholder = window.f0ckI18n?.upload_tags_placeholder || 'Tags...';
                tagsUI = `
                    <div class="item-tags-container">
                        <div class="item-tags-list"></div>
                        <input type="text" class="item-tag-input" placeholder="${window.escapeHtmlUpload(tagsPlaceholder)}" enterkeyhint="done">
                        <div class="tag-suggestions" style="display:none;"></div>
                        <div class="item-meta-suggestions" style="display:none; margin-top:5px; font-size:0.7rem; opacity:0.6;"></div>
                    </div>
                `;


                const commentPlaceholder = window.f0ckI18n?.upload_comment_placeholder || 'Comment (optional)...';
                commentUI = `
                    <textarea class="item-comment-input" placeholder="${window.escapeHtmlUpload(commentPlaceholder)}">${window.escapeHtmlUpload(item.comment || '')}</textarea>
                `;
            }

            const fileNameStr = isUrl ? item.url : file.name;
            const fileSizeStr = isUrl ? 'URL' : formatSize(file.size);

            infoRow.innerHTML = `
                <div class="file-info-small">
                    <span class="file-name-small" title="${window.escapeHtmlUpload(fileNameStr)}">${window.escapeHtmlUpload(fileNameStr)}</span>
                    <span class="file-size-small">${fileSizeStr}</span>
                </div>
                ${ratingSwitch}
                ${tagsUI}
                ${commentUI}
            `;

            if (isShitpost) {
                // Handle Rating
                infoRow.querySelectorAll('.item-rating-option input').forEach(radio => {
                    radio.onchange = () => { item.rating = radio.value; };
                });

                // Handle Comment
                const commentInput = infoRow.querySelector('.item-comment-input');
                if (commentInput) {
                    commentInput.oninput = () => { item.comment = commentInput.value; };
                }

                // Handle Tags
                const tagList = infoRow.querySelector('.item-tags-list');
                const tagInput = infoRow.querySelector('.item-tag-input');
                const tagSuggestions = infoRow.querySelector('.tag-suggestions');
                const suggCont = infoRow.querySelector('.item-meta-suggestions');

                const renderTags = () => {
                    if (!tagList) return;
                    tagList.innerHTML = '';
                    item.tags.forEach((t, i) => {
                        const chip = document.createElement('span');
                        chip.className = 'item-tag-chip';
                        chip.innerHTML = `${window.escapeHtmlUpload(t)} <span class="item-tag-remove">✕</span>`;
                        chip.querySelector('.item-tag-remove').onclick = () => {
                            item.tags.splice(i, 1);
                            renderTags();
                            updateSubmitButton();
                        };
                        tagList.appendChild(chip);
                    });
                };
                renderTags();

                const addItemTag = (val) => {
                    val = val.trim();
                    if (val && !item.tags.includes(val)) {
                        item.tags.push(val);
                        renderTags();
                        updateSubmitButton();
                    }
                };

                // Initialize autocomplete for THIS item
                if (tagInput && tagSuggestions) {
                    window.f0ckInitTagAutocomplete(tagInput, tagSuggestions, addItemTag, () => item.tags);
                }

                // Metadata Suggestions for THIS item
                const addMetaSuggestionToItem = (val) => {
                    if (!suggCont) return;
                    suggCont.style.display = 'flex';
                    const sugg = document.createElement('div');
                    sugg.className = 'item-meta-suggestion';
                    sugg.innerHTML = `<i class="fa fa-plus-circle" style="user-select:none"></i> <span style="user-select:text">${window.escapeHtmlUpload(val)}</span>`;
                    
                    sugg.addEventListener('mouseup', (ev) => {
                        const sel = window.getSelection?.()?.toString().trim();
                        if (!sel || sel === val) return;
                        sugg.addEventListener('click', (e) => e.stopImmediatePropagation(), { once: true, capture: true });
                        ev.stopPropagation();
                        window._showSelTagPopover?.(sel, sugg, (confirmed) => {
                            window.getSelection?.()?.removeAllRanges();
                            addItemTag(confirmed);
                        });
                    });

                    sugg.onclick = () => {
                        addItemTag(val);
                        sugg.classList.add('selected');
                        const icon = sugg.querySelector('i');
                        if (icon) icon.className = 'fa fa-check-circle';
                    };
                    suggCont.appendChild(sugg);
                };

                // Trigger Extraction for this item
                if (isUrl) {
                    (async () => {
                        try {
                            const resp = await fetch('/api/v2/meta/extract-url?url=' + encodeURIComponent(item.url), {
                                headers: { 'X-Requested-With': 'XMLHttpRequest' }
                            });
                            const data = await resp.json();
                            if (data.success && data.fields) {
                                data.fields.forEach(val => addMetaSuggestionToItem(val));
                            }
                        } catch (e) { console.warn('[URL ITEM META SYNC ERROR]', e.message); }
                    })();
                } else {
                    // Add filename as first suggestion
                    if (file.name) {
                        let baseName = file.name;
                        const lastDotIndex = baseName.lastIndexOf('.');
                        if (lastDotIndex > 0) baseName = baseName.substring(0, lastDotIndex);
                        baseName = baseName.trim();
                        if (baseName) addMetaSuggestionToItem(baseName);
                    }

                    if (files && Array.from(files).includes(file)) {
                        (async () => {
                            const chunkSize = (file.type && file.type.startsWith('image/')) ? 512 * 1024 : 4 * 1024 * 1024;
                            const chunk = file.slice(0, chunkSize);
                            const formData = new FormData();
                            formData.append('file', chunk, file.name);
                            try {
                                const resp = await fetch('/api/v2/meta/extract-file', {
                                    method: 'POST',
                                    headers: {
                                        'X-CSRF-Token': window.f0ckSession?.csrf_token || document.querySelector('input[name="csrf_token"]')?.value || '',
                                        'X-Requested-With': 'XMLHttpRequest'
                                    },
                                    body: formData
                                });
                                const data = await resp.json();
                                if (data.success && data.fields) {
                                    data.fields.forEach(val => addMetaSuggestionToItem(val));
                                }
                                if (data.hasGpsData) showGpsPrivacyWarning(file);
                            } catch (e) { console.warn('[ITEM META SYNC ERROR]', e.message); }
                        })();
                    }
                }
            }

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn-remove-small';
            removeBtn.innerHTML = '✕';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                selectedFiles.splice(index, 1);
                handleFile(); // Rebuild UI
            };

            previewItem.appendChild(mediaElem);
            previewItem.appendChild(infoRow);
            previewItem.appendChild(removeBtn);
            if (filePreview) filePreview.appendChild(previewItem);
        });

        // "Add more" button for Shitpost Mode
        if (isShitpost) {
            const addMoreItem = document.createElement('div');
            addMoreItem.className = 'file-preview-item add-more-item';
            addMoreItem.innerHTML = '<span>Add more</span>';
            addMoreItem.onclick = () => fileInput && fileInput.click();
            if (filePreview) filePreview.appendChild(addMoreItem);
        }

        // Legacy Global Meta Sync (Non-Shitpost Mode)
        if (!isShitpost && selectedFiles.length > 0 && files && files.length > 0) {
            const primaryFile = selectedFiles[0];
            autoTags = [];
            const metaCont = form.querySelector('.meta-suggestions-container');
            const metaList = form.querySelector('.meta-suggestions-list');
            if (metaList) metaList.innerHTML = '';
            if (metaCont) metaCont.style.display = 'none';
            form.querySelector('.gps-privacy-warning')?.remove();

            if (primaryFile.name) {
                let baseName = primaryFile.name;
                const lastDotIndex = baseName.lastIndexOf('.');
                if (lastDotIndex > 0) baseName = baseName.substring(0, lastDotIndex);
                baseName = baseName.trim();
                if (baseName && !autoTags.includes(baseName)) {
                    autoTags.push(baseName);
                    addMetaSuggestion(baseName);
                }
            }

            const isMedia = (primaryFile.type && primaryFile.type.startsWith('video/')) || 
                           (primaryFile.type && primaryFile.type.startsWith('audio/')) || 
                           (primaryFile.type && primaryFile.type.startsWith('image/')) ||
                           /\.(mp4|webm|mp3|ogg|wav|m4a|flac|jpg|jpeg|png|gif|webp|tiff?)$/i.test(primaryFile.name);
            
            if (isMedia) {
                const extractTags = async () => {
                    const chunkSize = (primaryFile.type && primaryFile.type.startsWith('image/')) ? 512 * 1024 : 4 * 1024 * 1024;
                    const chunk = primaryFile.slice(0, chunkSize);
                    const formData = new FormData();
                    formData.append('file', chunk, primaryFile.name);
                    const status = form.querySelector('.tag-input-container .sync-spinner');
                    if (status) status.classList.add('active');

                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 10000);
                        const resp = await fetch('/api/v2/meta/extract-file', {
                            method: 'POST',
                            headers: {
                                'X-CSRF-Token': window.f0ckSession?.csrf_token || document.querySelector('input[name="csrf_token"]')?.value || '',
                                'X-Requested-With': 'XMLHttpRequest'
                            },
                            body: formData,
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);
                        const data = await resp.json();
                        if (data.success && data.fields) {
                            data.fields.forEach(val => {
                                if (!autoTags.includes(val)) {
                                    autoTags.push(val);
                                    addMetaSuggestion(val);
                                }
                            });
                        }
                        if (data.hasGpsData) showGpsPrivacyWarning(primaryFile);
                    } catch (e) {
                        console.warn('[META SYNC ERROR]', e.message);
                    } finally {
                        if (status) status.classList.remove('active');
                    }
                };
                extractTags();
            }
        }

        // Toggle custom thumbnail for single SWF batch
        if (thumbSection) {
            const firstItem = selectedFiles[0];
            const firstFile = (firstItem && firstItem.file) || firstItem;
            const isSingleSwf = firstFile && selectedFiles.length === 1 && 
                (firstFile.type === 'application/x-shockwave-flash' || firstFile.type === 'application/vnd.adobe.flash.movie' || (firstFile.name && firstFile.name.endsWith('.swf')));
            thumbSection.style.display = isSingleSwf ? 'block' : 'none';
        }

        updateSubmitButton();
        form.dispatchEvent(new CustomEvent('fileReady', { detail: { files: selectedFiles } }));
        return true;
    };

    if (dropZone) {
        const preventDefaults = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
        });

        dropZone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const files = dt.files;
            handleFile(files);
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', (e) => handleFile(e.target.files));
    }

    if (removeFile) {
        removeFile.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectedFiles = [];
            form.querySelector('.gps-privacy-warning')?.remove();
            if (fileInput) fileInput.value = '';
            if (dropZonePrompt) dropZonePrompt.style.display = 'block';
            if (fileInput) fileInput.style.display = 'inline-block'; 
            if (filePreview) filePreview.style.display = 'none';
            const media = filePreview?.querySelector('.preview-media');
            if (media) media.remove();

            if (thumbSection) thumbSection.style.display = 'none';
            if (thumbInput) thumbInput.value = '';

            updateSubmitButton();
        });
    }

    const addTag = (tagName) => {
        tagName = tagName.trim();
        if (!tagName || tags.some(t => t.toLowerCase() === tagName.toLowerCase())) return;
        if (['sfw', 'nsfw', 'nsfl'].includes(tagName.toLowerCase())) return;
        if (/^https?:\/\//i.test(tagName)) {
            if (typeof window.showFlash === 'function') {
                window.showFlash('Post that in the comments', 'error');
            }
            if (tagInput) tagInput.value = '';
            return;
        }

        tags.push(tagName);

        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.style.cursor = 'pointer';
        chip.title = 'Click to edit prefix or tag';
        chip.innerHTML = `<span class="tag-text">${window.escapeHtmlUpload(tagName)}</span><button type="button">&times;</button>`;
        
        // Remove button logic
        chip.querySelector('button').addEventListener('click', (e) => {
            e.stopPropagation();
            tags = tags.filter(t => t !== tagName);
            chip.remove();
            
            syncMetaSuggestions();
            updateSubmitButton();
        });

        // Edit logic: clicking the text moves it back to input
        chip.querySelector('.tag-text').addEventListener('click', () => {
            tags = tags.filter(t => t !== tagName);
            chip.remove();
            if (tagInput) {
                tagInput.value = tagName;
                tagInput.focus();
            }
            syncMetaSuggestions();
            updateSubmitButton();
        });

        if (tagsList) tagsList.appendChild(chip);
        if (tagsHidden) tagsHidden.value = tags.join(',');
        if (tagInput) tagInput.value = '';
        if (tagSuggestions) {
            tagSuggestions.innerHTML = '';
            tagSuggestions.style.display = 'none';
        }
        syncMetaSuggestions();
        updateSubmitButton();
    };

    const showGpsPrivacyWarning = (originalFile) => {
        // Remove any existing warning
        const existing = form.querySelector('.gps-privacy-warning');
        if (existing) existing.remove();

        const warn = document.createElement('div');
        warn.className = 'gps-privacy-warning';
        warn.innerHTML = `
            <i class="fa-solid fa-location-dot"></i>
            <span><strong>Location data detected.</strong> This image contains GPS coordinates that reveal where it was taken.</span>
            <button type="button" class="gps-strip-btn">Strip GPS data</button>
            <button type="button" class="gps-dismiss-btn" title="Dismiss">×</button>
        `;

        const stripBtn = warn.querySelector('.gps-strip-btn');
        const dismissBtn = warn.querySelector('.gps-dismiss-btn');

        dismissBtn.addEventListener('click', () => warn.remove());

        stripBtn.addEventListener('click', async () => {
            stripBtn.disabled = true;
            stripBtn.textContent = 'Stripping…';

            try {
                const formData = new FormData();
                formData.append('file', originalFile, originalFile.name);

                const resp = await fetch('/api/v2/meta/strip-gps', {
                    method: 'POST',
                    headers: {
                        'X-CSRF-Token': window.f0ckSession?.csrf_token || document.querySelector('input[name="csrf_token"]')?.value || '',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: formData,
                });

                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

                const blob = await resp.blob();
                const cleanFile = new File([blob], originalFile.name, { type: originalFile.type || blob.type });

                // Replace the selected file in the array so the upload uses the clean version
                const isShitpost = !!window.f0ckShitpostMode;
                const idx = selectedFiles.findIndex(f => (f.file || f) === originalFile);
                if (idx !== -1) {
                    if (isShitpost && typeof selectedFiles[idx] === 'object') {
                        selectedFiles[idx].file = cleanFile;
                    } else {
                        selectedFiles[idx] = cleanFile;
                    }
                }

                warn.innerHTML = `<i class="fa-solid fa-check"></i> <span>GPS data stripped. Location will not be embedded in the uploaded image.</span>`;
                warn.classList.add('gps-stripped');
                setTimeout(() => warn.remove(), 5000);
            } catch (e) {
                console.warn('[GPS STRIP ERROR]', e.message);
                stripBtn.disabled = false;
                stripBtn.textContent = 'Strip GPS data';
                if (typeof window.showFlash === 'function') window.showFlash('Failed to strip GPS data', 'error');
                console.error('[GPS STRIP ERROR]', err);
            }
        });

        // Insert above the tag controls area
        const tagControls = form.querySelector('.tag-controls') || form.querySelector('.tag-input-container');
        if (tagControls) {
            tagControls.parentNode.insertBefore(warn, tagControls);
        } else {
            form.appendChild(warn);
        }
    };

    const addMetaSuggestion = (text) => {
        text = text.trim();
        if (!text) return;

        const metaCont = form.querySelector('.meta-suggestions-container');
        const metaList = form.querySelector('.meta-suggestions-list');
        if (!metaCont || !metaList) return;

        // Don't suggest duplicates in the suggestions list
        if (Array.from(metaList.children).some(el => el.getAttribute('data-text') === text)) return;

        metaCont.style.display = 'block';

        const sug = document.createElement('div');
        sug.className = 'meta-suggestion';
        sug.setAttribute('data-text', text);
        sug.innerHTML = `<i class="fa fa-plus-circle" style="user-select:none"></i> <span>${window.escapeHtmlUpload(text)}</span>`;

        sug.addEventListener('mouseup', (ev) => {
            const sel = window.getSelection?.()?.toString().trim();
            if (!sel) return;
            sug.addEventListener('click', (e) => e.stopImmediatePropagation(), { once: true, capture: true });
            ev.stopPropagation();
            window._showSelTagPopover?.(sel, sug, (confirmed) => {
                window.getSelection?.()?.removeAllRanges();
                addTag(confirmed);
            });
        });

        sug.addEventListener('click', () => {
            addTag(text);
        });

        metaList.appendChild(sug);
        syncMetaSuggestions();
    };

    const syncMetaSuggestions = () => {
        const metaList = form.querySelector('.meta-suggestions-list');
        if (!metaList) return;

        Array.from(metaList.children).forEach(sug => {
            const text = sug.getAttribute('data-text');
            if (tags.some(t => t.toLowerCase() === text.toLowerCase())) {
                sug.classList.add('selected');
                sug.querySelector('i').className = 'fa fa-check-circle';
            } else {
                sug.classList.remove('selected');
                sug.querySelector('i').className = 'fa fa-plus-circle';
            }
        });
    };

    /**
     * Reusable Tag Autocomplete Logic
     */
    window.f0ckInitTagAutocomplete = (tagInput, tagSuggestions, onAdd, getExistingTags) => {
        if (!tagInput || !tagSuggestions) return;

        let currentFocus = -1;
        let debounceTimer;

        const addActive = (x) => {
            if (!x) return false;
            removeActive(x);
            if (currentFocus >= x.length) currentFocus = 0;
            if (currentFocus < 0) currentFocus = (x.length - 1);
            x[currentFocus].classList.add("active");
            x[currentFocus].scrollIntoView({ block: 'nearest' });
            
            // Optional: update input value to highlighted tag
            // const tagName = x[currentFocus].querySelector('.tag-suggestion-name').textContent;
            // tagInput.value = tagName;
        };

        const removeActive = (x) => {
            for (let i = 0; i < x.length; i++) {
                x[i].classList.remove("active");
            }
        };

        tagInput.addEventListener('keydown', (e) => {
            const x = tagSuggestions.getElementsByClassName("tag-suggestion-item");
            if (e.key === 'ArrowDown') {
                currentFocus++;
                addActive(x);
            } else if (e.key === 'ArrowUp') {
                currentFocus--;
                addActive(x);
            } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) {
                if (currentFocus > -1) {
                    e.preventDefault();
                    if (x && x[currentFocus] && x[currentFocus]._f0ckSelect) {
                        x[currentFocus]._f0ckSelect();
                    }
                } else if (e.key === 'Enter' && tagInput.value.trim().length > 0) {
                    e.preventDefault();
                    onAdd(tagInput.value);
                    tagInput.value = '';
                }
            } else if (e.key === 'Escape') {
                if (tagSuggestions.style.display === 'block') {
                    e.preventDefault();
                    e.stopPropagation();
                }
                tagSuggestions.style.display = 'none';
                currentFocus = -1;
            }
        });

        tagInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            const query = tagInput.value.trim();
            currentFocus = -1;

            if (query.length < 1) {
                tagSuggestions.style.display = 'none';
                return;
            }

            debounceTimer = setTimeout(async () => {
                try {
                    const res = await fetch('/api/v2/tags/suggest?q=' + encodeURIComponent(query));
                    const data = await res.json();
                    if (data.success && data.suggestions && data.suggestions.length > 0) {
                        const existing = getExistingTags();
                        const filtered = (data.suggestions || []).filter(s => s && s.tag && !existing.some(t => t.toLowerCase() === s.tag.toLowerCase()));
                        let html = '';
                        const maxSuggestions = Math.min(8, filtered.length);
                        for (let i = 0; i < maxSuggestions; i++) {
                            const s = filtered[i];
                            const scoreStr = typeof s.score === 'number' ? s.score.toFixed(2) : '0.00';
                            html += `
                                <div class="tag-suggestion-item">
                                    <span class="tag-suggestion-name">${window.escapeHtmlUpload(s.tag)}</span>
                                    <span class="tag-suggestion-meta">${s.tagged || 0}× · ${scoreStr}</span>
                                </div>
                            `;
                        }
                        
                        if (maxSuggestions > 0) {
                            tagSuggestions.innerHTML = html;
                            tagSuggestions.style.display = 'block';

                            const items = tagSuggestions.querySelectorAll('.tag-suggestion-item');
                            items.forEach((el, idx) => {
                                const select = (ev) => {
                                    if (ev) {
                                        // Only stop if we actually have a selection (handled in mouseup)
                                        const sel = window.getSelection?.()?.toString().trim();
                                        if (sel && sel !== filtered[idx].tag) {
                                            ev.preventDefault();
                                            ev.stopPropagation();
                                            return;
                                        }
                                        ev.stopPropagation();
                                    }
                                    onAdd(filtered[idx].tag);
                                    tagInput.value = '';
                                    tagSuggestions.style.display = 'none';
                                    tagInput.focus();
                                };
                                
                                // Partial Selection Support
                                el.addEventListener('mouseup', (ev) => {
                                    const sel = window.getSelection?.()?.toString().trim();
                                    if (!sel || sel === filtered[idx].tag) return;
                                    
                                    // Block the immediate click action if we have a selection
                                    el.addEventListener('click', (e) => e.stopImmediatePropagation(), { once: true, capture: true });
                                    ev.stopPropagation();
                                    
                                    window._showSelTagPopover?.(sel, el, (confirmed) => {
                                        window.getSelection?.()?.removeAllRanges();
                                        onAdd(confirmed);
                                        tagSuggestions.style.display = 'none';
                                        tagInput.value = '';
                                        tagInput.focus();
                                    });
                                });

                                el.addEventListener('click', select);
                                
                                // Mobile support
                                let touchStartX = 0, touchStartY = 0;
                                el.addEventListener('touchstart', (ev) => {
                                    touchStartX = ev.touches[0].clientX;
                                    touchStartY = ev.touches[0].clientY;
                                }, { passive: true });
                                el.addEventListener('touchend', (ev) => {
                                    const dx = Math.abs(ev.changedTouches[0].clientX - touchStartX);
                                    const dy = Math.abs(ev.changedTouches[0].clientY - touchStartY);
                                    if (dx < 10 && dy < 10) {
                                        select(ev);
                                    }
                                });
                                el._f0ckSelect = select;
                            });
                        } else {
                            tagSuggestions.style.display = 'none';
                        }
                    } else {
                        tagSuggestions.style.display = 'none';
                    }
                } catch (err) {
                    console.error('[UPLOAD_TAGS] Error fetching suggestions:', err);
                }
            }, 200);
        });

        // Close when clicking outside
        const closeSuggestions = (e) => {
            if (!tagInput.contains(e.target) && !tagSuggestions.contains(e.target)) {
                tagSuggestions.style.display = 'none';
            }
        };
        document.addEventListener('mousedown', closeSuggestions);
        document.addEventListener('touchstart', closeSuggestions, { passive: true });
    };

    if (tagInput && tagSuggestions) {
        window.f0ckInitTagAutocomplete(tagInput, tagSuggestions, addTag, () => tags);
    }

    form.querySelectorAll('input[name="rating"]').forEach(radio => {
        radio.addEventListener('change', updateSubmitButton);
    });

    const performUpload = async (e) => {
        if (e && e.preventDefault) e.preventDefault();

        // If already uploading, don't start again
        if (submitBtn && submitBtn.disabled && submitBtn.querySelector('.btn-loading')?.style.display === 'inline') {
            return;
        }

        const isFileMode = activeMode === 'file';

        const globalRatingEl = form.querySelector('input[name="rating"]:checked');

        // Validation
        if (isShitpost && isFileMode) {
            if (selectedFiles.length === 0) {
                if (window.showFlash) window.showFlash('No files selected', 'error');
                return;
            }
            // No tag or rating requirement in shitpost mode — untagged items are allowed
        } else {
            if (!globalRatingEl) {
                if (window.showFlash) window.showFlash('Please select a rating', 'error');
                return;
            }
            if (tags.length < minTags) {
                if (window.showFlash) window.showFlash(`At least ${minTags} tags are required`, 'error');
                return;
            }
        }

        const dragModal = form.closest('#upload-drag-modal');
        const comment = form.querySelector('.upload-comment')?.value.trim() || '';
        const isOc = form.querySelector('#upload-oc-checkbox')?.checked || false;

        const setBtnLoading = (text) => {
            if (!submitBtn) return;
            submitBtn.disabled = true;
            const btnText = submitBtn.querySelector('.btn-text');
            const btnLoading = submitBtn.querySelector('.btn-loading');
            if (btnText) btnText.style.display = 'none';
            if (btnLoading) {
                btnLoading.style.display = 'inline';
                btnLoading.textContent = text;
            }
        };

        const restoreBtn = () => {
            if (!submitBtn) return;
            submitBtn.disabled = false;
            const btnText = submitBtn.querySelector('.btn-text');
            const btnLoading = submitBtn.querySelector('.btn-loading');
            if (btnText) btnText.style.display = 'inline';
            if (btnLoading) btnLoading.style.display = 'none';
        };

        if (activeMode === 'url') {
            // --- URL Upload ---
            let urls = [urlInput?.value.trim()];
            if (isShitpost && urlInput?.tagName === 'TEXTAREA') {
                urls = urlInput.value.split('\n').map(u => u.trim()).filter(u => u.length > 0);
            }
            if (urls.length === 0 || !urls[0]) return;

            setBtnLoading(isShitpost ? `Processing 1/${urls.length}...` : 'Processing...');
            if (statusDiv) {
                statusDiv.textContent = '';
                statusDiv.className = 'upload-status';
            }

            let successCount = 0;
            let lastData = null;

            for (let i = 0; i < urls.length; i++) {
                const url = urls[i];
                if (isShitpost) {
                    const statusMsg = window.f0ckI18n?.upload_shitposting_status || 'Shitposting';
                    setBtnLoading(`[${i + 1}/${urls.length}] ${statusMsg}...`);
                }

                try {
                    const resp = await fetch('/api/v2/upload-url', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': window.f0ckSession?.csrf_token || document.querySelector('input[name="csrf_token"]')?.value || '',
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: JSON.stringify({ 
                            url, 
                            rating: globalRatingEl.value, 
                            tags: tags.join(','),
                            comment: comment,
                            is_oc: isOc
                        })
                    });

                    const text = await resp.text();
                    let data;
                    try {
                        data = JSON.parse(text);
                    } catch (e) {
                        const statusText = resp.statusText || 'Unknown Error';
                        throw new Error(`Server returned non-JSON response (Status: ${resp.status} ${statusText})`);
                    }

                    if (data.success) {
                        successCount++;
                        lastData = data;
                        if (data.itemid) {
                            try {
                                const ts = Date.now();
                                const busted = JSON.parse(localStorage.getItem('bustedThumbs') || '{}');
                                busted[data.itemid] = ts;
                                const keys = Object.keys(busted);
                                if (keys.length > 50) delete busted[keys[0]];
                                localStorage.setItem('bustedThumbs', JSON.stringify(busted));
                            } catch(e) {}
                        }
                    } else if (!isShitpost) {
                        throw new Error(data.msg || 'Upload failed');
                    }
                } catch (err) {
                    console.error('[UPLOAD ERROR]', err);
                    if (!isShitpost) {
                        statusDiv.textContent = '✕ ' + err.message;
                        statusDiv.className = 'upload-status error';
                        restoreBtn();
                        return;
                    }
                }
            }

            if (successCount > 0) {
                if (dragModal) dragModal.classList.remove('show');
                if (window.resetGlobalScrollState) window.resetGlobalScrollState();
                if (window.hideAllModals) window.hideAllModals();
                
                form._f0ckUploader.reset();
                
                if (isShitpost) {
                    // Flash message removed as requested
                } else {
                    if (!dragModal && statusDiv) {
                        statusDiv.innerHTML = '✓ ' + (lastData?.msg || 'Upload successful');
                        statusDiv.className = 'upload-status success';
                    }
                    if (lastData?.manual_approval && typeof window.showFlash === 'function') {
                        window.showFlash('Upload awaits approval, please be patient', 'info');
                    }
                }

                setTimeout(() => {
                    if (typeof window.loadPageAjax === 'function') window.loadPageAjax('/');
                    else window.location.href = '/';
                }, dragModal ? 0 : 1000);
            } else {
                restoreBtn();
            }
        } else {
            // --- File Upload ---
            if (selectedFiles.length === 0) return;

            setBtnLoading(isShitpost ? `Uploading 1/${selectedFiles.length}...` : 'Uploading...');
            if (progressContainer) progressContainer.style.display = 'flex';
            if (statusDiv) {
                statusDiv.textContent = '';
                statusDiv.className = 'upload-status';
            }

            let successCount = 0;
            let lastData = null;

            for (let i = 0; i < selectedFiles.length; i++) {
                const item = selectedFiles[i];
                const isUrlItem = isShitpost && item.type === 'url';
                const file = !isUrlItem ? (isShitpost ? item.file : item) : null;
                const fileRating = isShitpost ? item.rating : (globalRatingEl ? globalRatingEl.value : 'sfw');
                const fileTags = isShitpost ? item.tags : tags;
                const fileComment = isShitpost ? item.comment : comment;

                if (isShitpost) {
                    const statusMsg = window.f0ckI18n?.upload_shitposting_status || 'Shitposting';
                    setBtnLoading(`[${i + 1}/${selectedFiles.length}] ${statusMsg}...`);
                }

                const formData = new FormData();
                if (isUrlItem) {
                    formData.append('url', item.url);
                } else {
                    formData.append('file', file);
                }
                formData.append('rating', fileRating);
                formData.append('tags', fileTags.join(','));
                formData.append('is_oc', (isShitpost ? item.is_oc : isOc) ? 'true' : 'false');
                if (isShitpost) formData.append('is_shitpost', 'true');

                // Add custom thumbnail if provided (only for single SWF files)
                if (selectedFiles.length === 1 && thumbInput && thumbInput.files && thumbInput.files[0]) {
                    formData.append('thumbnail', thumbInput.files[0]);
                }
                
                // Send the specific comment for this file
                if (fileComment) {
                    formData.append('comment', fileComment);
                }

                try {
                    const res = await new Promise((resolve, reject) => {
                        const xhr = new XMLHttpRequest();
                        xhr.upload.addEventListener('progress', (e) => {
                            if (e.lengthComputable) {
                                const percent = Math.round((e.loaded / e.total) * 100);
                                if (progressFill) progressFill.style.width = percent + '%';
                                if (progressText) progressText.textContent = (isShitpost ? `[${i+1}/${selectedFiles.length}] ` : '') + percent + '%';
                            }
                        });

                        xhr.onload = () => {
                            try {
                                const data = JSON.parse(xhr.responseText);
                                resolve(data);
                            } catch(e) {
                                let msg = 'Server error';
                                if (xhr.status === 413) msg = 'File too large';
                                try {
                                    const errData = JSON.parse(xhr.responseText);
                                    if (errData.msg) msg = errData.msg;
                                } catch(e2) {}
                                reject(new Error(msg));
                            }
                        };
                        xhr.onerror = () => reject(new Error('Connection error'));
                        const endpoint = isUrlItem ? '/api/v2/upload-url' : '/api/v2/upload';
                        xhr.open('POST', endpoint);
                        const csrf = window.f0ckSession?.csrf_token || document.querySelector('input[name="csrf_token"]')?.value || '';
                        xhr.setRequestHeader('X-CSRF-Token', csrf);
                        
                        if (isUrlItem) {
                            xhr.setRequestHeader('Content-Type', 'application/json');
                            xhr.send(JSON.stringify({
                                url: item.url,
                                rating: fileRating,
                                tags: fileTags.join(','),
                                is_oc: (isShitpost ? item.is_oc : isOc),
                                comment: fileComment,
                                is_shitpost: isShitpost ? true : undefined
                            }));
                        } else {
                            xhr.send(formData);
                        }
                    });

                    if (res.success) {
                        successCount++;
                        lastData = res;
                        if (res.pending) {
                            // Background URL download — show i18n toast
                            if (typeof window.flashMessage === 'function') {
                                window.flashMessage(window.f0ckI18n?.upload_url_queued_background || res.msg, 4000, 'info');
                            }
                        }
                        if (res.itemid) {
                            try {
                                const ts = Date.now();
                                const busted = JSON.parse(localStorage.getItem('bustedThumbs') || '{}');
                                busted[res.itemid] = ts;
                                const keys = Object.keys(busted);
                                if (keys.length > 50) delete busted[keys[0]];
                                localStorage.setItem('bustedThumbs', JSON.stringify(busted));
                            } catch(e) {}
                        }
                    } else if (!isShitpost) {
                        throw new Error(res.msg || 'Upload failed');
                    }
                } catch (err) {
                    console.error('[UPLOAD ERROR]', err);
                    if (!isShitpost) {
                        statusDiv.textContent = '✕ ' + err.message;
                        statusDiv.className = 'upload-status error';
                        if (progressContainer) progressContainer.style.display = 'none';
                        restoreBtn();
                        return;
                    }
                }
            }

            if (successCount > 0) {
                if (dragModal) dragModal.classList.remove('show');
                form._f0ckUploader.reset();
                if (isShitpost) {
                    // Flash message removed as requested
                } else if (!dragModal && statusDiv) {
                    statusDiv.innerHTML = '✓ ' + (lastData?.msg || 'Upload successful');
                    statusDiv.className = 'upload-status success';
                }

                setTimeout(() => {
                    if (typeof window.loadPageAjax === 'function') window.loadPageAjax('/');
                    else window.location.href = '/';
                }, dragModal ? 0 : 1000);
            } else {
                restoreBtn();
                if (progressContainer) progressContainer.style.display = 'none';
            }
        }
    };

    form.addEventListener('submit', performUpload);
    updateSubmitButton();
    
    // Return an object with methods to control the form externally if needed
    form._f0ckUploader = {
        handleFile: handleFile,
        performUpload: performUpload,
        reset: () => {
            form.reset();
            tags = [];
            selectedFiles = [];
            if (tagsList) tagsList.innerHTML = '';
            if (tagsHidden) tagsHidden.value = '';
            if (fileInput) fileInput.style.display = 'inline-block';
            if (dropZonePrompt) dropZonePrompt.style.display = 'block';
            if (filePreview) {
                filePreview.style.display = "none";
                filePreview.innerHTML = "";
            }
            if (urlInput) urlInput.value = '';
            if (urlBadge) urlBadge.style.display = 'none';
            if (progressContainer) { progressContainer.style.display = 'none'; }
            if (progressFill) { progressFill.style.width = '0%'; }
            if (progressText) { progressText.textContent = '0%'; }
            if (statusDiv) { statusDiv.textContent = ''; statusDiv.className = 'upload-status'; }

            if (thumbSection) thumbSection.style.display = 'none';
            if (thumbInput) thumbInput.value = '';
            if (submitBtn) {
                const btnText = submitBtn.querySelector('.btn-text');
                const btnLoading = submitBtn.querySelector('.btn-loading');
                if (btnText) btnText.style.display = 'inline';
                if (btnLoading) {
                    btnLoading.style.display = 'none';
                }
            }

            // Reset mode to 'file'
            activeMode = 'file';
            if (modeTabs.length > 0) {
                modeTabs.forEach(t => {
                    if (t.dataset.mode === 'file') t.classList.add('active');
                    else t.classList.remove('active');
                });
            }
            if (modeFile) modeFile.style.display = '';
            if (modeUrl) modeUrl.style.display = 'none';

            // Clear GPS warning and meta suggestions
            form.querySelector('.gps-privacy-warning')?.remove();
            const metaContReset = form.querySelector('.meta-suggestions-container');
            const metaListReset = form.querySelector('.meta-suggestions-list');
            if (metaListReset) metaListReset.innerHTML = '';
            if (metaContReset) metaContReset.style.display = 'none';
            autoTags = [];

            updateSubmitButton();
        }
    };

    return form._f0ckUploader;
};

// Global Keyboard Shortcut: Ctrl+Enter
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || (!e.ctrlKey && !e.metaKey)) return;

    // 1. Try the element that currently has focus
    // 2. Fall back to the modal form if it's visible
    // 3. Fall back to any visible upload form on the page
    let targetForm = document.activeElement?.closest('.upload-form');

    if (!targetForm || !targetForm._f0ckUploader) {
        const modal = document.getElementById('upload-drag-modal');
        if (modal && modal.classList.contains('show')) {
            targetForm = modal.querySelector('.upload-form');
        }
    }

    if (!targetForm || !targetForm._f0ckUploader) {
        targetForm = document.querySelector('.upload-form');
    }

    if (!targetForm || !targetForm._f0ckUploader) return;

    e.preventDefault();
    e.stopPropagation();

    const uploader = targetForm._f0ckUploader;
    const isShitpost = targetForm.classList.contains('shitpost-mode-active') || !!window.f0ckShitpostMode;
    const isUrlTab = targetForm.querySelector('.upload-mode-tab[data-mode="url"]')?.classList.contains('active');

    if (isShitpost && isUrlTab) {
        const btnAddUrls = targetForm.querySelector('.btn-add-urls');
        if (btnAddUrls) btnAddUrls.click();
    } else {
        uploader.performUpload();
    }
});

// Global multi-instance auto-init
window.autoInitUploadForms = () => {
    document.querySelectorAll('.upload-form').forEach(form => {
        window.initUploadForm(form);
    });
};

document.addEventListener('DOMContentLoaded', window.autoInitUploadForms);
