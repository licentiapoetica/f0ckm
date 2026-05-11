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

    let tags = [];
    let autoTags = []; // Track tags suggested from metadata
    let selectedFile = null;
    let activeMode = 'file'; // 'file' or 'url'

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

        if (urlBadge) {
            urlBadge.addEventListener('click', () => {
                const val = urlInput.value.trim();
                if (val && /^https?:\/\//i.test(val)) {
                    lastFetchedUrl = ''; // Force retry
                    fetchMetadata(val);
                }
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
        const rating = form.querySelector('input[name="rating"]:checked');
        const hasRating = rating !== null;
        const hasTags = tags.length >= minTags;

        let hasContent = false;
        if (activeMode === 'file') {
            hasContent = selectedFile !== null;
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
                    const remaining = minTags - tags.length;
                    const tpl = i18n.tags_required || '{n} more tag{s} required';
                    btnText.textContent = tpl
                        .replace('{n}', remaining)
                        .replace('{s}', remaining !== 1 ? 's' : '');
                } else if (!hasRating) {
                    btnText.textContent = i18n.select_rating || 'Select SFW or NSFW';
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

    const handleFile = (file) => {
        if (!file) return;

        // Note: Allowed mimes still come from a global or container-specific attribute
        const container = form.closest('.upload-container');
        const mimesSource = form.getAttribute('data-mimes') || (container ? container.getAttribute('data-mimes') : null);
        let allowedMimes = [];
        let allowedExts = [];
        try {
            const mimesObj = JSON.parse(mimesSource || '{}');
            allowedMimes = Object.keys(mimesObj);
            allowedExts = [...new Set(Object.values(mimesObj))];
        } catch(e) {
            // Fallback for modal
            allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/x-flac', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'application/x-shockwave-flash', 'application/vnd.adobe.flash.movie'];
        }

        // Check by MIME type or by file extension (browsers may report empty/wrong MIME for some formats)
        const fileExt = file.name.split('.').pop().toLowerCase();
        const mimeOk = !file.type || allowedMimes.includes(file.type);
        const extOk = allowedExts.length > 0 && allowedExts.includes(fileExt);

        if (allowedMimes.length > 0 && !mimeOk && !extOk) {
            const errorMsg = `File type ${file.type || '.' + fileExt} is not allowed.`;
            if (typeof window.showFlash === 'function') {
                window.showFlash(errorMsg, 'error');
            } else {
                statusDiv.textContent = errorMsg;
                statusDiv.className = 'upload-status error';
            }
            return false;
        }

        // --- File Size Check ---
        const maxBytesAttr = form.getAttribute('data-max-bytes');
        if (maxBytesAttr) {
            const maxBytes = parseInt(maxBytesAttr);
            if (file.size > maxBytes) {
                const errorMsg = `File is too large: ${formatSize(file.size)} (Limit: ${formatSize(maxBytes)})`;
                if (typeof window.showFlash === 'function') {
                    window.showFlash(errorMsg, 'error');
                } else if (statusDiv) {
                    statusDiv.textContent = errorMsg;
                    statusDiv.className = 'upload-status error';
                }
                updateSubmitButton();
                return false;
            }
        }

        selectedFile = file;
        if (fileName) fileName.textContent = file.name;
        if (fileSize) fileSize.textContent = formatSize(file.size);
        if (dropZonePrompt) dropZonePrompt.style.display = 'none';

        // Hide input so it doesn't intercept clicks on preview/remove button
        if (fileInput) fileInput.style.display = 'none';

        if (filePreview) filePreview.style.display = 'flex';
        if (statusDiv) {
            statusDiv.textContent = '';
            statusDiv.className = 'upload-status';
        }

        // Ensure we're on file tab
        if (activeMode !== 'file' && modeTabs.length > 0) {
            modeTabs.forEach(t => t.classList.remove('active'));
            const fileTab = form.querySelector('.upload-mode-tab[data-mode="file"]');
            if (fileTab) fileTab.classList.add('active');
            if (modeFile) modeFile.style.display = '';
            if (modeUrl) modeUrl.style.display = 'none';
            activeMode = 'file';
        }

        // Media Preview
        const existingPreview = filePreview ? filePreview.querySelector('.preview-media') : null;
        if (existingPreview) existingPreview.remove();

        let previewElem;
        if (file.type.startsWith('image/')) {
            previewElem = document.createElement('img');
            previewElem.src = URL.createObjectURL(file);
        } else if (file.type.startsWith('video/')) {
            previewElem = document.createElement('video');
            previewElem.src = URL.createObjectURL(file);
            previewElem.controls = true;
            previewElem.autoplay = true;
            previewElem.muted = true;
            previewElem.loop = true;
        } else if (file.type.startsWith('audio/')) {
            previewElem = document.createElement('audio');
            previewElem.src = URL.createObjectURL(file);
            previewElem.controls = true;
        } else if (file.type === 'application/x-shockwave-flash' || file.type === 'application/vnd.adobe.flash.movie' || fileExt === 'swf') {
            previewElem = document.createElement('div');
            previewElem.className = 'generic-file-icon swf-preview-icon';
            previewElem.innerHTML = '<span style="font-size:2.5em;">⚡</span><br><span style="font-size:0.85em;letter-spacing:0.1em;color:#e040fb;font-weight:bold;">SWF</span>';
        } else if (file.type === 'application/pdf' || fileExt === 'pdf') {
            previewElem = document.createElement('div');
            previewElem.className = 'generic-file-icon pdf-preview-icon';
            previewElem.innerHTML = '<span style="font-size:2.5em;"><i class="fa-solid fa-file-pdf"></i></span><br><span style="font-size:0.85em;letter-spacing:0.1em;color:#ef5350;font-weight:bold;"></span>';
        } else {
            previewElem = document.createElement('div');
            previewElem.className = 'generic-file-icon';
            previewElem.innerHTML = '📁';
        }

        previewElem.classList.add('preview-media');
        if (filePreview) filePreview.prepend(previewElem);

        // Flash-specific: show custom thumbnail option
        if (thumbSection) {
            if (file.type === 'application/x-shockwave-flash' || file.type === 'application/vnd.adobe.flash.movie' || fileExt === 'swf') {
                thumbSection.style.display = 'block';
            } else {
                thumbSection.style.display = 'none';
                if (thumbInput) thumbInput.value = '';
            }
        }

        selectedFile = file;
        updateSubmitButton();
        autoTags = []; // Reset auto tags

        // Clear previous metadata suggestions and GPS warning
        const metaCont = form.querySelector('.meta-suggestions-container');
        const metaList = form.querySelector('.meta-suggestions-list');
        if (metaList) metaList.innerHTML = '';
        if (metaCont) metaCont.style.display = 'none';
        form.querySelector('.gps-privacy-warning')?.remove();
        
        if (file.name) {
            let baseName = file.name;
            const lastDotIndex = baseName.lastIndexOf('.');
            if (lastDotIndex > 0) {
                baseName = baseName.substring(0, lastDotIndex);
            }
            baseName = baseName.trim();
            if (baseName && !autoTags.includes(baseName)) {
                autoTags.push(baseName);
                addMetaSuggestion(baseName);
            }
        }

        // --- Media Metadata Sync (Hybrid) ---
        const isMedia = file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/') ||
            (file.name && /\.(mp4|webm|mp3|ogg|wav|m4a|flac|jpg|jpeg|png|gif|webp|tiff?)$/i.test(file.name));
        if (isMedia) {
            const extractTitle = async () => {
                const chunkSize = file.type.startsWith('image/') ? 512 * 1024 : 4 * 1024 * 1024; // 512KB for images (EXIF at start), 4MB for video
                const chunk = file.slice(0, chunkSize);
                const formData = new FormData();
                formData.append('file', chunk, file.name);

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

                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = await resp.json();

                    if (data.success && data.fields && Array.isArray(data.fields)) {
                        data.fields.forEach(val => {
                            if (!autoTags.includes(val)) autoTags.push(val);
                            addMetaSuggestion(val);
                        });
                    }

                    // Privacy: GPS data found — offer to strip it
                    if (data.hasGpsData) {
                        showGpsPrivacyWarning(file);
                    }
                } catch (e) {
                    console.warn('[TITLE SYNC ERROR]', e.name === 'AbortError' ? 'Timeout' : e.message);
                } finally {
                    if (status) status.classList.remove('active');
                }
            };
            extractTitle();
        }

        // Custom event for global drag-drop completion
        form.dispatchEvent(new CustomEvent('fileReady', { detail: { file } }));
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
            handleFile(files[0]);
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
    }

    if (removeFile) {
        removeFile.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectedFile = null;
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

                // Replace the selected file so the upload uses the clean version
                selectedFile = cleanFile;

                warn.innerHTML = `<i class="fa-solid fa-check"></i> <span>GPS data stripped. Location will not be embedded in the uploaded image.</span>`;
                warn.classList.add('gps-stripped');
                setTimeout(() => warn.remove(), 4000);

                if (typeof window.showFlash === 'function') window.showFlash('GPS data removed from image', 'success');

            } catch (err) {
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

    let currentFocus = -1;

    const addActive = (x) => {
        if (!x) return false;
        removeActive(x);
        if (currentFocus >= x.length) currentFocus = 0;
        if (currentFocus < 0) currentFocus = (x.length - 1);
        x[currentFocus].classList.add("active");
        x[currentFocus].scrollIntoView({ block: 'nearest' });
    };

    const removeActive = (x) => {
        for (let i = 0; i < x.length; i++) {
            x[i].classList.remove("active");
        }
    };

    if (tagInput) {
        tagInput.addEventListener('keydown', (e) => {
            const x = tagSuggestions ? tagSuggestions.getElementsByClassName("tag-suggestion-item") : [];
            if (e.key === 'ArrowDown') {
                currentFocus++;
                addActive(x);
            } else if (e.key === 'ArrowUp') {
                currentFocus--;
                addActive(x);
            } else if (e.key === 'Enter') {
                if (currentFocus > -1) {
                    e.preventDefault();
                    if (x && x[currentFocus] && x[currentFocus]._f0ckSelect) {
                        x[currentFocus]._f0ckSelect();
                    }
                } else if (tagInput.value.trim().length > 0) {
                    e.preventDefault();
                    addTag(tagInput.value);
                }
            } else if (e.key === 'Escape') {
                if (tagSuggestions && tagSuggestions.style.display === 'block') {
                    e.preventDefault();
                    e.stopPropagation();
                }
                if (tagSuggestions) tagSuggestions.style.display = 'none';
                currentFocus = -1;
            }
        });
    }

    let debounceTimer;
    if (tagInput) {
        tagInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            const query = tagInput.value.trim();
            currentFocus = -1;

            if (query.length < 1) {
                if (tagSuggestions) tagSuggestions.style.display = 'none';
                return;
            }

            debounceTimer = setTimeout(async () => {
                try {
                    const res = await fetch('/api/v2/tags/suggest?q=' + encodeURIComponent(query));
                    const data = await res.json();
                    if (data.success && data.suggestions && data.suggestions.length > 0) {
                        const filtered = (data.suggestions || []).filter(s => s && s.tag && !tags.some(t => t.toLowerCase() === s.tag.toLowerCase()));
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
                        window.f0ckDebug('[UPLOAD] Rendering ' + filtered.length + ' suggestions');
                        if (tagSuggestions) {
                            tagSuggestions.innerHTML = html;
                            tagSuggestions.style.display = 'block';

                            const items = tagSuggestions.querySelectorAll('.tag-suggestion-item');
                            items.forEach((el, idx) => {
                                const select = (e) => {
                                    if (e) {
                                        e.preventDefault();
                                        e.stopPropagation();
                                    }
                                    addTag(filtered[idx].tag);
                                    tagInput.focus();
                                };
                                // Desktop: mousedown fires before blur, so dropdown stays open
                                el.addEventListener('mousedown', select);
                                // Mobile: use touchend to detect a tap (vs scroll)
                                let touchStartX = 0, touchStartY = 0;
                                el.addEventListener('touchstart', (e) => {
                                    touchStartX = e.touches[0].clientX;
                                    touchStartY = e.touches[0].clientY;
                                }, { passive: true });
                                el.addEventListener('touchend', (e) => {
                                    const dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
                                    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
                                    if (dx < 10 && dy < 10) {
                                        select(e);
                                    }
                                });
                                el._f0ckSelect = select; // Store for keyboard use
                            });
                        }
                    } else {
                        if (tagSuggestions) tagSuggestions.style.display = 'none';
                    }
                } catch (err) {
                    console.error('[UPLOAD_TAGS] Error fetching suggestions:', err);
                    if (typeof window.showFlash === 'function') {
                        window.showFlash('Tag suggestions unavailable', 'error');
                    }
                }
            }, 200);
        });
    }

    // Use mousedown (not click) so item's mousedown fires first on desktop.
    // Use touchstart for mobile — touchend on the item fires before this touchstart on document.
    const closeSuggestions = (e) => {
        if (form.contains(document.body) === false && !document.body.contains(form)) return;
        if (tagInput && tagSuggestions && !tagInput.contains(e.target) && !tagSuggestions.contains(e.target)) {
            tagSuggestions.style.display = 'none';
        }
    };
    document.addEventListener('mousedown', closeSuggestions);
    document.addEventListener('touchstart', closeSuggestions, { passive: true });

    form.querySelectorAll('input[name="rating"]').forEach(radio => {
        radio.addEventListener('change', updateSubmitButton);
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const rating = form.querySelector('input[name="rating"]:checked');
        if (!rating || tags.length < minTags) return;

        if (activeMode === 'url') {
            // --- URL Upload ---
            const url = urlInput?.value.trim();
            if (!url) return;

            if (submitBtn) {
                submitBtn.disabled = true;
                const btnText = submitBtn.querySelector('.btn-text');
                const btnLoading = submitBtn.querySelector('.btn-loading');
                if (btnText) btnText.style.display = 'none';
                if (btnLoading) {
                    btnLoading.style.display = 'inline';
                    btnLoading.textContent = 'Processing...';
                }
            }
            if (statusDiv) {
                statusDiv.textContent = '';
                statusDiv.className = 'upload-status';
            }

            try {
                const resp = await fetch('/api/v2/upload-url', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token || '',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({ 
                        url, 
                        rating: rating.value, 
                        tags: tags.join(','),
                        comment: form.querySelector('.upload-comment')?.value.trim() || '',
                        is_oc: form.querySelector('#upload-oc-checkbox')?.checked || false
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
                    const dragModal = form.closest('#upload-drag-modal');

                    if (data.pending) {
                        // For async uploads, don't redirect, just show status and reset
                        if (dragModal) dragModal.classList.remove('show');
                        
                        if (typeof window.flashMessage === 'function') {
                            window.flashMessage(data.msg || 'Processing in background...');
                        } else if (typeof window.showFlash === 'function') {
                            window.showFlash(data.msg || 'Processing in background...', 'info');
                        }
                        
                        if (!dragModal) {
                            statusDiv.innerHTML = '✓ ' + data.msg;
                            statusDiv.className = 'upload-status success';
                        }
                        
                        form._f0ckUploader.reset();
                        return;
                    }

                    if (dragModal) dragModal.classList.remove('show');
                    if (window.resetGlobalScrollState) window.resetGlobalScrollState();
                    if (window.hideAllModals) window.hideAllModals();
                    form._f0ckUploader.reset();
                    if (!dragModal) {
                        statusDiv.innerHTML = '✓ ' + data.msg;
                        statusDiv.className = 'upload-status success';
                    }
                    
                    if (data.itemid) {
                        try {
                            const ts = Date.now();
                            const bustedStr = localStorage.getItem('bustedThumbs');
                            const busted = bustedStr ? JSON.parse(bustedStr) : {};
                            busted[data.itemid] = ts;
                            const keys = Object.keys(busted);
                            if (keys.length > 50) delete busted[keys[0]];
                            localStorage.setItem('bustedThumbs', JSON.stringify(busted));
                        } catch(e) {}
                    }

                    if (data.manual_approval && typeof window.showFlash === 'function') {
                        window.showFlash('Upload awaits approval, please be patient', 'info');
                    }
                    const navDelay = dragModal ? 0 : 1000;
                    setTimeout(() => {
                        if (typeof window.loadPageAjax === 'function') {
                            window.loadPageAjax('/');
                        } else {
                            window.location.href = '/';
                        }
                    }, navDelay);
                } else {
                    statusDiv.textContent = '✕ ' + (data.msg || 'Upload failed');
                    statusDiv.className = 'upload-status error';
                    if (data.repost) {
                        statusDiv.innerHTML += ' <a href="/' + data.repost + '">View existing</a>';
                    }
                    submitBtn.disabled = false;
                    submitBtn.querySelector('.btn-text').style.display = 'inline';
                    submitBtn.querySelector('.btn-loading').style.display = 'none';
                }
            } catch (err) {
                console.error('[UPLOAD ERROR]', err);
                statusDiv.textContent = '✕ Upload failed: ' + err.message;
                statusDiv.className = 'upload-status error';
                submitBtn.disabled = false;
                submitBtn.querySelector('.btn-text').style.display = 'inline';
                submitBtn.querySelector('.btn-loading').style.display = 'none';
            }
        } else {
            // --- File Upload ---
            if (!selectedFile) return;

            if (submitBtn) {
                submitBtn.disabled = true;
                const btnText = submitBtn.querySelector('.btn-text');
                const btnLoading = submitBtn.querySelector('.btn-loading');
                if (btnText) btnText.style.display = 'none';
                if (btnLoading) {
                    btnLoading.style.display = 'inline';
                    btnLoading.textContent = 'Uploading...';
                }
            }
            if (progressContainer) progressContainer.style.display = 'flex';

            // Reset status
            if (statusDiv) {
                statusDiv.textContent = '';
                statusDiv.className = 'upload-status';
            }

            const formData = new FormData();
            formData.append('file', selectedFile);
            formData.append('rating', rating.value);
            formData.append('tags', tags.join(','));
            formData.append('is_oc', form.querySelector('#upload-oc-checkbox')?.checked ? 'true' : 'false');

            // Add custom thumbnail if provided (only for SWF files)
            if (thumbInput && thumbInput.files && thumbInput.files[0]) {
                formData.append('thumbnail', thumbInput.files[0]);
            }
            const commentEl = form.querySelector('.upload-comment');
            if (commentEl && commentEl.value.trim()) {
                formData.append('comment', commentEl.value.trim());
            }

            try {
                const xhr = new XMLHttpRequest();

                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        if (progressFill) progressFill.style.width = percent + '%';
                        if (progressText) progressText.textContent = percent + '%';
                    }
                });

                xhr.onload = () => {
                    let res;
                    try {
                        res = JSON.parse(xhr.responseText);
                    } catch(e) {
                        if (xhr.status === 413) {
                            res = { success: false, msg: 'File too large (rejected by proxy)' };
                        } else {
                            res = { success: false, msg: 'Internal server error (invalid JSON)' };
                            console.error('[UPLOAD ERROR] Failed to parse response:', xhr.responseText);
                        }
                    }

                    if (res.success) {
                        const dragModal = form.closest('#upload-drag-modal');
                        if (dragModal) dragModal.classList.remove('show');
                        form._f0ckUploader.reset();
                        if (!dragModal && statusDiv) {
                            statusDiv.innerHTML = '✓ ' + res.msg;
                            statusDiv.className = 'upload-status success';
                        }
                        
                        if (res.itemid) {
                            try {
                                const ts = Date.now();
                                const bustedStr = localStorage.getItem('bustedThumbs');
                                const busted = bustedStr ? JSON.parse(bustedStr) : {};
                                busted[res.itemid] = ts;
                                const keys = Object.keys(busted);
                                if (keys.length > 50) delete busted[keys[0]];
                                localStorage.setItem('bustedThumbs', JSON.stringify(busted));
                            } catch(e) {}
                        }

                        if (res.manual_approval && typeof window.showFlash === 'function') {
                            window.showFlash('Upload awaits approval', 'info');
                        }
                        const navDelay = dragModal ? 0 : 1000;
                        setTimeout(() => {
                            if (typeof window.loadPageAjax === 'function') {
                                window.loadPageAjax('/');
                            } else {
                                window.location.href = '/';
                            }
                        }, navDelay);
                    } else {
                        if (statusDiv) {
                            statusDiv.textContent = '✕ ' + res.msg;
                            statusDiv.className = 'upload-status error';
                            if (res.repost) {
                                statusDiv.innerHTML += ' <a href="/' + res.repost + '">View existing</a>';
                            }
                        }
                        if (submitBtn) {
                            submitBtn.disabled = false;
                            const btnText = submitBtn.querySelector('.btn-text');
                            const btnLoading = submitBtn.querySelector('.btn-loading');
                            if (btnText) btnText.style.display = 'inline';
                            if (btnLoading) btnLoading.style.display = 'none';
                        }
                        if (progressContainer) progressContainer.style.display = 'none';
                    }
                };

                xhr.onerror = () => {
                    if (statusDiv) {
                        statusDiv.textContent = '✕ Upload failed. The connection was reset or interrupted.';
                        statusDiv.className = 'upload-status error';
                    }
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        const btnText = submitBtn.querySelector('.btn-text');
                        const btnLoading = submitBtn.querySelector('.btn-loading');
                        if (btnText) btnText.style.display = 'inline';
                        if (btnLoading) btnLoading.style.display = 'none';
                    }
                    if (progressContainer) progressContainer.style.display = 'none';
                };

                xhr.open('POST', '/api/v2/upload');
                xhr.setRequestHeader('X-CSRF-Token', window.f0ckSession?.csrf_token || '');
                xhr.send(formData);

            } catch (err) {
                console.error(err);
                if (statusDiv) {
                    statusDiv.textContent = '✕ Upload failed: ' + err.message;
                    statusDiv.className = 'upload-status error';
                }
                if (submitBtn) submitBtn.disabled = false;
            }
        }
    });

    updateSubmitButton();
    
    // Return an object with methods to control the form externally if needed
    form._f0ckUploader = {
        handleFile: handleFile,
        reset: () => {
            form.reset();
            tags = [];
            selectedFile = null;
            if (tagsList) tagsList.innerHTML = '';
            if (tagsHidden) tagsHidden.value = '';
            if (fileInput) fileInput.style.display = 'inline-block';
            if (dropZonePrompt) dropZonePrompt.style.display = 'block';
            if (filePreview) filePreview.style.display = 'none';
            const media = filePreview?.querySelector('.preview-media');
            if (media) media.remove();
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

    // --- Keyboard Shortcuts ---
    // Control+Enter to Submit
    form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            if (submitBtn && !submitBtn.disabled) {
                e.preventDefault();
                submitBtn.click();
            }
        }
    });

    return form._f0ckUploader;
};

// Global multi-instance auto-init
window.autoInitUploadForms = () => {
    document.querySelectorAll('.upload-form').forEach(form => {
        window.initUploadForm(form);
    });
};

document.addEventListener('DOMContentLoaded', window.autoInitUploadForms);
