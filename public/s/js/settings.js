(() => {
    // Settings script — and loaded via AJAX or full page load specifically for settings.
    var i18n = window.f0ckI18n || {};

    // Update the navbar avatar image live and all rendered avatars for the current user
    const updateNavAvatar = (src) => {
        // 1. Navbar
        document.querySelectorAll('img.nav-avatar-img').forEach(img => img.src = src);

        // 2. Sidebar & comment avatars — identify by link to the current user's profile
        const username = window.f0ckSession?.user?.toLowerCase();
        if (username) {
            // sidebar-activity.js: <a class="sidebar-avatar-link" href="/user/..."><img class="sidebar-avatar">
            document.querySelectorAll(`a.sidebar-avatar-link[href="/user/${username}"] img.sidebar-avatar`).forEach(img => img.src = src);
            // comments.js: <div class="comment-avatar"><a href="/user/..."><img>
            document.querySelectorAll(`.comment-avatar a[href="/user/${username}"] img`).forEach(img => img.src = src);
            // f0ckm.js activity panel: <div class="comment-avatar"><a href="/user/..."><img>
            document.querySelectorAll(`#sidebar-activity-container .comment-avatar a[href="/user/${username}"] img`).forEach(img => img.src = src);
        }
    };

    // Update the username color live across the navbar and all rendered username links
    const updateNavColor = (color) => {
        // 1. Navbar display name
        const navName = document.getElementById('nav-display-name');
        if (navName) navName.style.color = color;

        // 2. Comment / sidebar / post username links for the current user
        const username = window.f0ckSession?.user?.toLowerCase();
        if (username) {
            document.querySelectorAll(`a[href="/user/${username}"]`).forEach(el => {
                el.style.color = color;
            });
        }
    };

    // Update the display name live across the navbar, sidebar activity and all profile links
    const updateNavDisplayName = (name) => {
        const username = window.f0ckSession?.user?.toLowerCase();
        if (!username) return;

        const displayName = name || window.f0ckSession?.user || 'User';

        // 1. Navbar
        const navName = document.getElementById('nav-display-name');
        if (navName) navName.textContent = displayName;

        // 2. All profile links that show the display name
        document.querySelectorAll(`a[href="/user/${username}"]`).forEach(el => {
            // Update link text if it currently matches the (old) display name or username
            // and it's not just an image container
            if (el.classList.contains('comment-author') || el.id === 'a_username' || el.classList.contains('mention')) {
                el.textContent = (el.classList.contains('mention') ? '@' : '') + displayName;
            }

            // Update tooltips (used in favs list, etc.)
            if (el.hasAttribute('tooltip')) {
                el.setAttribute('tooltip', displayName);
            }
        });

        // 3. Update sidebar activity cache if it exists
        if (window._sidebarActivityCache && Array.isArray(window._sidebarActivityCache)) {
            window._sidebarActivityCache.forEach(c => {
                if (c.username && c.username.toLowerCase() === username) {
                    c.display_name = name;
                }
            });
        }
        
        // 4. Update session
        if (window.f0ckSession) window.f0ckSession.display_name = name;
    };

    // ==== Avatar Item ID Logic (existing) ====
    const saveAvatar = async e => {
        e.preventDefault();

        const avatar = +document.querySelector('input[name="i_avatar"]').value;
        let res = await fetch('/api/v2/settings/setAvatar', {
            // ... content continues ...
            method: 'PUT',
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": window.f0ckSession?.csrf_token
            },
            body: JSON.stringify({ avatar })
        });
        const code = res.status;
        res = await res.json();

        switch (code) {
            case 200:
                // Update preview to show item thumbnail
                const preview = document.getElementById('avatar-preview');
                if (preview) {
                    if (preview.tagName === 'IMG') {
                        preview.src = `/t/${avatar}.webp`;
                    } else {
                        // Replace placeholder with img
                        const img = document.createElement('img');
                        img.id = 'avatar-preview';
                        img.className = 'avatar-preview-img';
                        img.src = `/t/${avatar}.webp`;
                        preview.replaceWith(img);
                    }
                }
                // Update navbar avatar
                updateNavAvatar(`/t/${avatar}.webp`);

                showStatus('Avatar updated to item #' + avatar, 'success');
                break;
            default:
                showStatus(res.msg || 'Failed to set avatar', 'error');
                break;
        }
    };

    const sAvatar = document.querySelector('button#s_avatar');
    if (sAvatar) sAvatar.addEventListener('click', saveAvatar);

    const iAvatar = document.querySelector('input[name="i_avatar"]');
    if (iAvatar) iAvatar.addEventListener('keyup', async e => {
        if (e.key === 'Enter')
            await saveAvatar(e);
    });

    // ==== Avatar File Upload Logic ====
    const fileInput = document.getElementById('avatar-file-input');
    const chooseBtn = document.getElementById('avatar-choose-btn');
    const filenameSpan = document.getElementById('avatar-filename');
    const uploadBtn = document.getElementById('avatar-upload-btn');
    const removeBtn = document.getElementById('avatar-remove-btn');
    const progressWrapper = document.getElementById('avatar-progress-wrapper');
    const progressFill = document.getElementById('avatar-progress-fill');
    const progressText = document.getElementById('avatar-progress-text');
    const statusDiv = document.getElementById('avatar-upload-status');
    const preview = document.getElementById('avatar-preview');

    const showStatus = (msg, type) => {
        if (statusDiv) {
            statusDiv.textContent = msg;
            statusDiv.className = 'avatar-status ' + type;
        }
    };

    const maxSize = 5 * 1024 * 1024; // 5MB
    const allowedTypes = ['image/gif', 'image/jpeg', 'image/png', 'image/webp'];

    if (chooseBtn && fileInput) {
        chooseBtn.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (!file) {
                filenameSpan.textContent = 'No file selected';
                uploadBtn.disabled = true;
                return;
            }

            // Validate file type
            if (!allowedTypes.includes(file.type)) {
                showStatus('Invalid file type. Allowed: gif, jpg, png, webp', 'error');
                filenameSpan.textContent = 'Invalid file';
                uploadBtn.disabled = true;
                return;
            }

            // Validate file size
            if (file.size > maxSize) {
                showStatus(`File too large. Max 5MB, got ${(file.size / 1024 / 1024).toFixed(2)}MB`, 'error');
                filenameSpan.textContent = 'File too large';
                uploadBtn.disabled = true;
                return;
            }

            filenameSpan.textContent = file.name;
            uploadBtn.disabled = false;
            showStatus('', '');
        });
    }

    if (uploadBtn) {
        uploadBtn.addEventListener('click', async () => {
            const file = fileInput.files[0];
            if (!file) return;

            uploadBtn.disabled = true;
            chooseBtn.disabled = true;
            progressWrapper.style.display = 'flex';
            progressFill.style.width = '0%';
            progressText.textContent = '0%';
            showStatus(i18n.uploading || 'Uploading...', '');

            const formData = new FormData();
            formData.append('file', file);

            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    progressFill.style.width = percent + '%';
                    progressText.textContent = percent + '%';
                }
            });

            xhr.addEventListener('load', () => {
                try {
                    const res = JSON.parse(xhr.responseText);
                    if (xhr.status === 200 && res.success) {
                        showStatus(res.msg || 'Avatar uploaded!', 'success');

                        // Update preview
                        if (preview) {
                            if (preview.tagName === 'IMG') {
                                preview.src = '/a/' + res.avatar_file + '?t=' + Date.now();
                            } else {
                                const img = document.createElement('img');
                                img.id = 'avatar-preview';
                                img.className = 'avatar-preview-img';
                                img.src = '/a/' + res.avatar_file + '?t=' + Date.now();
                                preview.replaceWith(img);
                            }
                        }

                        // Update navbar avatar
                        updateNavAvatar('/a/' + res.avatar_file + '?t=' + Date.now());

                        // Show remove button if not present
                        const existingRemoveBtn = document.getElementById('avatar-remove-btn');
                        if (!existingRemoveBtn) {
                            const actionsDiv = document.querySelector('.avatar-upload-actions');
                            if (actionsDiv) {
                                const btn = document.createElement('button');
                                btn.type = 'button';
                                btn.id = 'avatar-remove-btn';
                                btn.className = 'button button-danger';
                                btn.textContent = 'Remove Custom';
                                actionsDiv.appendChild(btn);
                            }
                        }

                        // Reset file input
                        fileInput.value = '';
                        filenameSpan.textContent = 'No file selected';
                    } else {
                        showStatus(res.msg || 'Upload failed', 'error');
                    }
                } catch (e) {
                    showStatus('Upload failed: Invalid response', 'error');
                }

                progressWrapper.style.display = 'none';
                uploadBtn.disabled = true;
                chooseBtn.disabled = false;
            });

            xhr.addEventListener('error', () => {
                showStatus('Upload failed: Network error', 'error');
                progressWrapper.style.display = 'none';
                uploadBtn.disabled = true;
                chooseBtn.disabled = false;
            });

            xhr.open('POST', '/api/v2/settings/uploadAvatar');
            xhr.setRequestHeader('X-CSRF-Token', window.f0ckSession?.csrf_token);
            xhr.send(formData);
        });
    }

    // Remove custom avatar handler (uses event delegation for dynamically added button)
    document.addEventListener('click', async (e) => {
        if (e.target.id === 'avatar-remove-btn') {
            e.target.disabled = true;
            e.target.textContent = i18n.hall_removing || 'Removing...';

            try {
                const res = await fetch('/api/v2/settings/uploadAvatar', { 
                    method: 'DELETE',
                    headers: { "X-CSRF-Token": window.f0ckSession?.csrf_token }
                });
                const data = await res.json();

                if (data.success) {
                    showStatus('Custom avatar removed', 'success');
                    e.target.remove();

                    // Reload to show item-based avatar or placeholder
                    setTimeout(() => window.location.reload(), 500);
                } else {
                    showStatus(data.msg || 'Failed to remove', 'error');
                    e.target.disabled = false;
                    e.target.textContent = 'Remove Custom';
                }
            } catch (err) {
                showStatus('Failed to remove avatar', 'error');
                e.target.disabled = false;
                e.target.textContent = 'Remove Custom';
            }
        }

        // Use Custom Avatar button handler
        if (e.target.id === 'use-custom-btn') {
            e.target.disabled = true;
            e.target.textContent = i18n.switching || 'Switching...';

            try {
                const res = await fetch('/api/v2/settings/useCustomAvatar', { 
                    method: 'PUT',
                    headers: { "X-CSRF-Token": window.f0ckSession?.csrf_token }
                });
                const data = await res.json();

                if (data.success) {
                    showStatus('Switched to custom avatar', 'success');

                    // Update preview
                    const preview = document.getElementById('avatar-preview');
                    if (preview && preview.tagName === 'IMG') {
                        preview.src = '/a/' + data.avatar_file + '?t=' + Date.now();
                    }

                    // Update navbar avatar
                    updateNavAvatar('/a/' + data.avatar_file + '?t=' + Date.now());

                    // Clear item ID input
                    const itemInput = document.querySelector('input[name="i_avatar"]');
                    if (itemInput) itemInput.value = '0';

                    // Re-enable the button
                    e.target.disabled = false;
                    e.target.textContent = 'Use Custom';
                } else {
                    showStatus(data.msg || 'Failed to switch', 'error');
                    e.target.disabled = false;
                    e.target.textContent = 'Use Custom';
                }
            } catch (err) {
                showStatus('Failed to switch avatar', 'error');
                e.target.disabled = false;
                e.target.textContent = 'Use Custom';
            }
        }
    });

    // Generic Linking Logic
    const genTokenBtn = document.getElementById('btn-gen-link-token');
    const linkedAccountsList = document.getElementById('linked-accounts-list');
    const tokenDisplay = document.getElementById('token-display-area');
    const tokenCode = document.getElementById('generated-token-code');

    const renderLinkedAccounts = (aliases) => {
        if (!linkedAccountsList) return;

        if (aliases.length === 0) {
            linkedAccountsList.innerHTML = '<em class="text-muted">No linked accounts</em>';
            return;
        }

        linkedAccountsList.innerHTML = '';
        aliases.forEach(a => {
            const div = document.createElement('div');
            div.className = 'linked-account-item';
            div.style.cssText = 'display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.1); padding: 8px; border-radius: 4px;';
            
            const infoDiv = document.createElement('div');
            infoDiv.style.display = 'flex';
            infoDiv.style.alignItems = 'center';
            infoDiv.style.gap = '10px';

            // Icon string based on type
            let icon = '🔗';
            let platformName = 'Unknown';
            if (a.type === 'discord') { icon = '<i class="fab fa-discord"></i>'; platformName = 'Discord'; }
            else if (a.type === 'matrix') { icon = '<i class="fas fa-comments"></i>'; platformName = 'Matrix'; }
            
            // Simple text fallback if fontawesome not fully loaded/supported in snippet
            if (a.type === 'matrix') icon = '[Matrix]';
            if (a.type === 'discord') icon = '[Discord]';

            infoDiv.innerHTML = `<span style="font-weight:bold; opacity:0.7;">${icon}</span> <span>${escHTML(a.alias || '')}</span>`;

            const btn = document.createElement('button');
            btn.className = 'button button-danger button-small unlink-account-btn';
            btn.setAttribute('data-alias', a.alias);
            btn.setAttribute('data-type', a.type);
            btn.style.cssText = 'padding: 2px 8px; font-size: 0.8rem; height: auto;';
            btn.textContent = 'Unlink';

            div.appendChild(infoDiv);
            div.appendChild(btn);
            linkedAccountsList.appendChild(div);
        });
    };

    const loadLinkedAccounts = async () => {
        try {
            const res = await fetch('/api/v2/settings/link/accounts');
            const data = await res.json();
            if (data.success) {
                renderLinkedAccounts(data.aliases);
            } else {
                linkedAccountsList.innerHTML = '<em>Error loading accounts</em>';
            }
        } catch (err) {
            console.error(err);
            linkedAccountsList.innerHTML = '<em>Error loading accounts</em>';
        }
    };

    if (linkedAccountsList) {
        loadLinkedAccounts();
    }

    // Unlink handler
    document.addEventListener('click', async (e) => {
        if (e.target.classList.contains('unlink-account-btn')) {
            const alias = e.target.getAttribute('data-alias');
            const type = e.target.getAttribute('data-type');
            
            if (!confirm(`Are you sure you want to unlink this ${type} account?`)) return;

            e.target.disabled = true;
            e.target.textContent = '...';

            try {
                const res = await fetch(`/api/v2/settings/link/unlink/${type}/${encodeURIComponent(alias)}`, { 
                    method: 'DELETE',
                    headers: { "X-CSRF-Token": window.f0ckSession?.csrf_token }
                });
                const data = await res.json();
                if (data.success) {
                    loadLinkedAccounts(); // Refresh
                } else {
                    alert(data.msg || 'Failed to unlink');
                    e.target.disabled = false;
                    e.target.textContent = 'Unlink';
                }
            } catch (err) {
                console.error(err);
                alert('Request failed');
                e.target.disabled = false;
                e.target.textContent = 'Unlink';
            }
        }
    });

    if (genTokenBtn) {
        genTokenBtn.addEventListener('click', async () => {
            genTokenBtn.disabled = true;
            genTokenBtn.textContent = i18n.generating || 'Generating...';

            try {
                // Type is optional, default token works for both if backend matches correctly.
                // But typically we generate a generic token now.
                const res = await fetch('/api/v2/settings/link/token', { 
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ type: 'generic' }) 
                });
                const data = await res.json();

                if (data.success) {
                    tokenCode.textContent = data.token;
                    tokenDisplay.style.display = 'block';
                    genTokenBtn.textContent = 'Generate New Token';
                    genTokenBtn.disabled = false;
                } else {
                    alert(data.msg || 'Failed to generate token');
                    genTokenBtn.disabled = false;
                    genTokenBtn.textContent = 'Generate Link Token';
                }
            } catch (err) {
                console.error(err);
                alert('Request failed');
                genTokenBtn.disabled = false;
                genTokenBtn.textContent = 'Generate Link Token';
            }
        });
    }

    // MOTD Visibility Toggle
    const motdToggle = document.getElementById('show_motd_toggle');
    if (motdToggle) {
        motdToggle.addEventListener('change', async () => {
            const show = motdToggle.checked;
            try {
                const res = await fetch('/api/v2/settings/motd', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ show })
                });
                const data = await res.json();
                if (data.success) {
                    const userPrefEl = document.getElementById('user-pref-show-motd');
                    if (userPrefEl) userPrefEl.innerText = show ? 'true' : 'false';

                    if (show) window['motd_dismissed'] = false; // Reset dismissal if re-enabling

                    if (typeof window.updateMotdUI === 'function') {
                        const dataEl = document.getElementById('motd-data');
                        window.updateMotdUI(dataEl ? dataEl.innerText : '');
                    }
                } else {
                    alert(data.msg || 'Error saving preference');
                    motdToggle.checked = !show; // Revert
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save MOTD preference');
                motdToggle.checked = !show; // Revert
            }
        });
    }

    const swipingToggle = document.getElementById('disable_swiping_toggle');
    if (swipingToggle) {
        swipingToggle.addEventListener('change', async () => {
            const disable_swiping = swipingToggle.checked;
            try {
                const res = await fetch('/api/v2/settings/swiping', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-CSRF-Token': window.f0ckSession.csrf_token
                    },
                    body: new URLSearchParams({ disable_swiping })
                });
                const data = await res.json();
                if (data.success) {
                    showStatus('Swiping preference updated!', 'success');
                    if (window.f0ckSession) {
                        window.f0ckSession.disable_swiping = disable_swiping;
                    }
                } else {
                    alert(data.msg || 'Error saving preference');
                    swipingToggle.checked = !disable_swiping; // Revert
                }
            } catch (err) {
                console.error('Update Swiping error:', err);
                alert('Connection error');
                swipingToggle.checked = !disable_swiping; // Revert
            }
        });
    }

    // New Dual Column Layout Toggle
    const layoutToggle = document.getElementById('use_new_layout_toggle');
    if (layoutToggle) {
        layoutToggle.addEventListener('change', async () => {
            const use_new_layout = layoutToggle.checked;
            try {
                const res = await fetch('/api/v2/settings/layout', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ use_new_layout })
                });
                const data = await res.json();
                if (data.success) {
                    window.location.reload();
                } else {
                    alert(data.msg || 'Error saving preference');
                    layoutToggle.checked = !use_new_layout; // Revert
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save Layout preference');
                layoutToggle.checked = !use_new_layout; // Revert
            }
        });
    }

    // Disable Autoplay Toggle
    const autoplayToggle = document.getElementById('disable_autoplay_toggle');
    if (autoplayToggle) {
        autoplayToggle.addEventListener('change', async () => {
            const disable_autoplay = autoplayToggle.checked;
            try {
                const res = await fetch('/api/v2/settings/autoplay', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ disable_autoplay })
                });
                const data = await res.json();
                if (data.success) {
                    showStatus('Autoplay preference updated!', 'success');
                    if (window.f0ckSession) {
                        window.f0ckSession.disable_autoplay = disable_autoplay;
                    }
                } else {
                    alert(data.msg || 'Error saving preference');
                    autoplayToggle.checked = !disable_autoplay; // Revert
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save Autoplay preference');
                autoplayToggle.checked = !disable_autoplay; // Revert
            }
        });
    }

    // Comment Display Mode Toggle
    const commentDisplayModeSelect = document.getElementById('comment_display_mode_select');
    if (commentDisplayModeSelect) {
        commentDisplayModeSelect.addEventListener('change', async () => {
            const mode = parseInt(commentDisplayModeSelect.value, 10);
            try {
                const res = await fetch('/api/v2/settings/comment_display_mode', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ mode })
                });
                const data = await res.json();
                if (data.success) {
                    showStatus('Comment display mode updated!', 'success');
                    if (window.f0ckSession) window.f0ckSession.comment_display_mode = mode;
                } else {
                    alert(data.msg || 'Error saving preference');
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save preference');
            }
        });
    }

    // Alternative Infobox Toggle (legacy layout only)
    const alternativeInfoboxToggle = document.getElementById('alternative_infobox_toggle');
    if (alternativeInfoboxToggle) {
        alternativeInfoboxToggle.addEventListener('change', async () => {
            const use_alternative_infobox = alternativeInfoboxToggle.checked;
            try {
                const res = await fetch('/api/v2/settings/alternative_infobox', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: new URLSearchParams({ use_alternative_infobox })
                });
                const data = await res.json();
                if (data.success) {
                    showStatus('Infobox preference updated!', 'success');
                    if (window.f0ckSession) window.f0ckSession.use_alternative_infobox = use_alternative_infobox;
                } else {
                    alert(data.msg || 'Error saving preference');
                    alternativeInfoboxToggle.checked = !use_alternative_infobox;
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save infobox preference');
                alternativeInfoboxToggle.checked = !use_alternative_infobox;
            }
        });
    }

    // Notification Preferences Toggles
    const setupPreferenceToggle = (id, sessionKey) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', async () => {
            const enabled = el.checked;
            try {
                const res = await fetch('/api/v2/settings/notifications', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: new URLSearchParams({ key: sessionKey, value: enabled })
                });
                const data = await res.json();
                if (data.success) {
                    if (window.f0ckSession) window.f0ckSession[sessionKey] = enabled;
                } else {
                    alert(data.msg || 'Error saving preference');
                    el.checked = !enabled;
                }
            } catch (err) {
                console.error(err);
                el.checked = !enabled;
            }
        });
    };

    setupPreferenceToggle('chk-receive-system-notifications', 'receive_system_notifications');
    setupPreferenceToggle('chk-receive-user-notifications', 'receive_user_notifications');
    setupPreferenceToggle('chk-do-not-disturb', 'do_not_disturb');

    const wheelToggle = document.getElementById('wheel_nav_toggle');
    if (wheelToggle) {
        wheelToggle.checked = localStorage.getItem('wheelNavEnabled') === 'true';
        wheelToggle.addEventListener('change', () => {
            localStorage.setItem('wheelNavEnabled', wheelToggle.checked);
        });
    }

    const imageExpandToggle = document.getElementById('image_expand_toggle');
    if (imageExpandToggle) {
        imageExpandToggle.checked = localStorage.getItem('imageExpandOnClick') !== 'false';
        imageExpandToggle.addEventListener('change', () => {
            localStorage.setItem('imageExpandOnClick', imageExpandToggle.checked);
        });
    }

    // Granular Thumbnail Blur Toggles
    const blurNsfwToggle = document.getElementById('blur_nsfw_toggle');
    if (blurNsfwToggle) {
        blurNsfwToggle.checked = localStorage.getItem('blurNsfw') === 'true';
        blurNsfwToggle.addEventListener('change', () => {
            const enabled = blurNsfwToggle.checked;
            localStorage.setItem('blurNsfw', enabled ? 'true' : 'false');
            if (enabled) {
                document.documentElement.classList.add('blur-nsfw-active');
            } else {
                document.documentElement.classList.remove('blur-nsfw-active');
            }
            showStatus(enabled ? 'NSFW blurring enabled!' : 'NSFW blurring disabled!', 'success');
        });
    }

    const blurNsflToggle = document.getElementById('blur_nsfl_toggle');
    if (blurNsflToggle) {
        blurNsflToggle.checked = localStorage.getItem('blurNsfl') === 'true';
        blurNsflToggle.addEventListener('change', () => {
            const enabled = blurNsflToggle.checked;
            localStorage.setItem('blurNsfl', enabled ? 'true' : 'false');
            if (enabled) {
                document.documentElement.classList.add('blur-nsfl-active');
            } else {
                document.documentElement.classList.remove('blur-nsfl-active');
            }
            showStatus(enabled ? 'NSFL blurring enabled!' : 'NSFL blurring disabled!', 'success');
        });
    }

    const blurSfwToggle = document.getElementById('blur_sfw_toggle');
    if (blurSfwToggle) {
        blurSfwToggle.checked = localStorage.getItem('blurSfw') === 'true';
        blurSfwToggle.addEventListener('change', () => {
            const enabled = blurSfwToggle.checked;
            localStorage.setItem('blurSfw', enabled ? 'true' : 'false');
            if (enabled) {
                document.documentElement.classList.add('blur-sfw-active');
            } else {
                document.documentElement.classList.remove('blur-sfw-active');
            }
            showStatus(enabled ? 'SFW blurring enabled!' : 'SFW blurring disabled!', 'success');
        });
    }

    const blurUntaggedToggle = document.getElementById('blur_untagged_toggle');
    if (blurUntaggedToggle) {
        blurUntaggedToggle.checked = localStorage.getItem('blurUntagged') === 'true';
        blurUntaggedToggle.addEventListener('change', () => {
            const enabled = blurUntaggedToggle.checked;
            localStorage.setItem('blurUntagged', enabled ? 'true' : 'false');
            if (enabled) {
                document.documentElement.classList.add('blur-untagged-active');
            } else {
                document.documentElement.classList.remove('blur-untagged-active');
            }
            showStatus(enabled ? 'Untagged blurring enabled!' : 'Untagged blurring disabled!', 'success');
        });
    }
    const blurDetailToggle = document.getElementById('blur_detail_toggle');
    if (blurDetailToggle) {
        blurDetailToggle.checked = localStorage.getItem('blurDetail') !== 'false';
        blurDetailToggle.addEventListener('change', () => {
            const enabled = blurDetailToggle.checked;
            localStorage.setItem('blurDetail', enabled ? 'true' : 'false');
            if (enabled) {
                document.documentElement.classList.add('blur-detail-active');
            } else {
                document.documentElement.classList.remove('blur-detail-active');
            }
            showStatus(enabled ? 'Detail page blurring enabled!' : 'Detail page blurring disabled!', 'success');
        });
    }

    // Background Blur Toggle
    const backgroundToggle = document.getElementById('show_background_toggle');
    if (backgroundToggle) {
        backgroundToggle.addEventListener('change', async () => {
            const show_background = backgroundToggle.checked;
            try {
                const res = await fetch('/api/v2/settings/background', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.f0ckSession?.csrf_token },
                    body: JSON.stringify({ show_background })
                });
                const data = await res.json();
                if (data.success) {
                    // Immediate reaction
                    window.background = show_background;
                    localStorage.setItem('background', show_background ? 'true' : 'false');
                    if (window.initBackground) window.initBackground();
                    
                    // Update session
                    if (window.f0ckSession) {
                        window.f0ckSession.show_background = show_background;
                    }
                    
                    // Update videoplayer toggle buttons if they exist
                    document.querySelectorAll("#togglebg").forEach(el => {
                        el.classList.toggle('active', show_background);
                    });
                } else {
                    alert(data.msg || 'Error saving preference');
                    backgroundToggle.checked = !show_background;
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save background preference');
                backgroundToggle.checked = !show_background;
            }
        });
    }

    // Quote Emojis Toggle
    const quoteEmojisToggle = document.getElementById('quote_emojis_toggle');
    if (quoteEmojisToggle) {
        quoteEmojisToggle.addEventListener('change', async () => {
            const quote_emojis = quoteEmojisToggle.checked;
            try {
                const res = await fetch('/api/v2/settings/quote_emojis', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.f0ckSession?.csrf_token },
                    body: JSON.stringify({ quote_emojis })
                });
                const data = await res.json();
                if (data.success) {
                    showStatus('Quote emoji preference updated!', 'success');
                    if (window.f0ckSession) window.f0ckSession.quote_emojis = quote_emojis;
                } else {
                    alert(data.msg || 'Error saving preference');
                    quoteEmojisToggle.checked = !quote_emojis;
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save preference');
                quoteEmojisToggle.checked = !quote_emojis;
            }
        });
    }

    // Embed YouTube In Comments Toggle
    const embedYoutubeToggle = document.getElementById('embed_youtube_in_comments_toggle');
    if (embedYoutubeToggle) {
        embedYoutubeToggle.addEventListener('change', async () => {
            const embed_youtube_in_comments = embedYoutubeToggle.checked;
            try {
                const res = await fetch('/api/v2/settings/embed_youtube_in_comments', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.f0ckSession?.csrf_token },
                    body: JSON.stringify({ embed_youtube_in_comments })
                });
                const data = await res.json();
                if (data.success) {
                    showStatus('YouTube embed preference updated!', 'success');
                    if (window.f0ckSession) window.f0ckSession.embed_youtube_in_comments = embed_youtube_in_comments;
                } else {
                    alert(data.msg || 'Error saving preference');
                    embedYoutubeToggle.checked = !embed_youtube_in_comments;
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save preference');
                embedYoutubeToggle.checked = !embed_youtube_in_comments;
            }
        });
    }

    // Hide Köpfe Toggle
    const hideKoepfeToggle = document.getElementById('hide_koepfe_toggle');
    if (hideKoepfeToggle) {
        hideKoepfeToggle.addEventListener('change', async () => {
            const hide_koepfe = hideKoepfeToggle.checked;
            try {
                const res = await fetch('/api/v2/settings/hide_koepfe', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.f0ckSession?.csrf_token },
                    body: JSON.stringify({ hide_koepfe })
                });
                const data = await res.json();
                if (data.success) {
                    showStatus('Köpfe preference updated!', 'success');
                    if (window.f0ckSession) window.f0ckSession.hide_koepfe = hide_koepfe;
                    // Immediately show/hide the koepfe image without a reload
                    const koepfeImg = document.getElementById('koepfe-img');
                    if (koepfeImg) koepfeImg.style.display = hide_koepfe ? 'none' : '';
                } else {
                    alert(data.msg || 'Error saving preference');
                    hideKoepfeToggle.checked = !hide_koepfe;
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save preference');
                hideKoepfeToggle.checked = !hide_koepfe;
            }
        });
    }

    // Language Preference Selector
    const languageSelect = document.getElementById('language_select');
    if (languageSelect) {
        languageSelect.addEventListener('change', async () => {
            const language = languageSelect.value; // '' = site default, 'en', 'de', etc.
            try {
                const res = await fetch('/api/v2/settings/language', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.f0ckSession?.csrf_token },
                    body: JSON.stringify({ language })
                });
                const data = await res.json();
                if (data.success) {
                    // Set/clear cookie so the running server picks up the change immediately
                    if (language) {
                        document.cookie = `language=${encodeURIComponent(language)}; path=/; max-age=${365 * 24 * 3600}; SameSite=Lax`;
                    } else {
                        document.cookie = `language=; path=/; max-age=0; SameSite=Lax`;
                    }
                    // Reload so server renders in the new language
                    window.location.reload();
                } else {
                    alert(data.msg || 'Error saving language preference');
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save language preference');
            }
        });
    }


    const colorPicker = document.getElementById('username_color_picker');
    const colorHex = document.getElementById('username_color_hex');
    const saveColorBtn = document.getElementById('btn-save-username-color');
    const resetColorBtn = document.getElementById('btn-reset-username-color');

    // Two-way sync: swatch → text input
    if (colorPicker && colorHex) {
        colorPicker.addEventListener('input', () => {
            colorHex.value = colorPicker.value;
        });

        // Text input → swatch (validate on each keystroke)
        colorHex.addEventListener('input', () => {
            const val = colorHex.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                colorPicker.value = val;
                colorHex.style.borderColor = '';
            } else {
                colorHex.style.borderColor = '#e74c3c';
            }
        });

        // On blur, normalise to lowercase
        colorHex.addEventListener('blur', () => {
            const val = colorHex.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                colorHex.value = val.toLowerCase();
                colorHex.style.borderColor = '';
            } else {
                // Revert to swatch value if invalid
                colorHex.value = colorPicker.value;
                colorHex.style.borderColor = '';
            }
        });
    }

    if (saveColorBtn && colorPicker) {
        saveColorBtn.addEventListener('click', async () => {
            const color = colorPicker.value;
            saveColorBtn.disabled = true;
            saveColorBtn.textContent = i18n.saving || 'Saving...';

            try {
                const res = await fetch('/api/v2/settings/username_color', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ color })
                });
                const data = await res.json();
                if (data.success) {
                    showStatus('Username color saved!', 'success');
                    updateNavColor(color);
                } else {
                    alert(data.msg || 'Error saving color');
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save username color');
            } finally {
                saveColorBtn.disabled = false;
                saveColorBtn.textContent = 'Save Color';
            }
        });
    }

    if (resetColorBtn && colorPicker) {
        resetColorBtn.addEventListener('click', async () => {
            const defaultColor = '#ffffff';
            colorPicker.value = defaultColor;
            if (colorHex) { colorHex.value = defaultColor; colorHex.style.borderColor = ''; }
            
            resetColorBtn.disabled = true;
            resetColorBtn.textContent = 'Resetting...';

            try {
                const res = await fetch('/api/v2/settings/username_color', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ color: defaultColor })
                });
                const data = await res.json();
                if (data.success) {
                    showStatus('Username color reset to default', 'success');
                    updateNavColor(defaultColor);
                } else {
                    alert(data.msg || 'Error resetting color');
                }
            } catch (err) {
                console.error(err);
                alert('Failed to reset username color');
            } finally {
                resetColorBtn.disabled = false;
                resetColorBtn.textContent = 'Reset';
            }
        });
    }

    // Website Theme Selection (immediate — cookie + attribute, no API needed)
    const themeSelect = document.getElementById('website_theme_select');
    if (themeSelect) {
        themeSelect.addEventListener('change', () => {
            const theme = themeSelect.value;
            document.documentElement.setAttribute('theme', theme);
            // Set cookie in same way theme.js does (1-year expiry, SameSite=Strict)
            document.cookie = `theme=${encodeURIComponent(theme)}; path=/; max-age=${360 * 24 * 3600}; SameSite=Strict`;
            showStatus(`Theme changed to ${theme}`, 'success');
        });
    }

    // Website Font Selection
    const fontSelect = document.getElementById('website_font_select');

    const applyFontLive = async (fontFile) => {
        let style = document.getElementById('live-font-style');
        if (!fontFile) {
            // Revert to default: remove injected style
            if (style) style.remove();
            return;
        }
        // Preload the font via FontFace API so it's available immediately
        try {
            const face = new FontFace('CustomUserFont', `url(/s/fonts/${fontFile})`);
            await face.load();
            document.fonts.add(face);
        } catch (e) {
            console.warn('[font] FontFace preload failed, continuing anyway:', e);
        }
        // Inject/update the same style rules that header.html uses
        if (!style) {
            style = document.createElement('style');
            style.id = 'live-font-style';
            document.head.appendChild(style);
        }
        style.textContent = `
          @font-face {
            font-family: 'CustomUserFont';
            src: url('/s/fonts/${fontFile}');
          }
          :root { --font: 'CustomUserFont', monospace !important; }
          *:not(.fa-solid):not(.fa-regular):not(.fa-brands):not(.fa-light):not(.fa-thin):not(.fa-duotone):not([class*=" fa-"]):not([class^="fa-"]) {
            font-family: 'CustomUserFont', monospace !important;
          }
          .fa-solid::before, .fa-regular::before, .fa-brands::before,
          .fas::before, .far::before, .fab::before, .fa::before {
            font-family: "Font Awesome 6 Free", "Font Awesome 6 Brands" !important;
          }
        `;
    };

    if (fontSelect) {
        fontSelect.addEventListener('change', async () => {
            const font = fontSelect.value;
            try {
                const res = await fetch('/api/v2/settings/font', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ font })
                });
                const data = await res.json();
                if (data.success) {
                    await applyFontLive(font);
                    showStatus('Website font updated!', 'success');
                } else {
                    alert(data.msg || 'Error saving font preference');
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save font preference');
            }
        });
    }

    // ==== Profile Description Logic ====
    const descriptionTextarea = document.getElementById('profile_description');
    const saveDescriptionBtn = document.getElementById('btn-save-description');
    const descriptionStatus = document.getElementById('description-status');

    if (saveDescriptionBtn && descriptionTextarea) {
        saveDescriptionBtn.addEventListener('click', async () => {
            const description = descriptionTextarea.value;
            saveDescriptionBtn.disabled = true;
            saveDescriptionBtn.textContent = i18n.saving || 'Saving...';

            try {
                const res = await fetch('/api/v2/settings/description', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ description })
                });
                const data = await res.json();
                if (data.success) {
                    showAccountStatus(descriptionStatus, 'Description updated successfully!', 'success');
                } else {
                    alert(data.msg || 'Error saving description');
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save description');
            } finally {
                saveDescriptionBtn.disabled = false;
                saveDescriptionBtn.textContent = 'Save Description';
            }
        });
    }

    const clearDescriptionBtn = document.getElementById('btn-clear-description');
    if (clearDescriptionBtn && descriptionTextarea) {
        clearDescriptionBtn.addEventListener('click', async () => {
            if (!confirm('Clear your profile description?')) return;
            
            descriptionTextarea.value = '';
            clearDescriptionBtn.disabled = true;
            
            try {
                const res = await fetch('/api/v2/settings/description', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ description: '' })
                });
                const data = await res.json();
                if (data.success) {
                    showAccountStatus(descriptionStatus, 'Description cleared!', 'success');
                } else {
                    alert(data.msg || 'Error clearing description');
                }
            } catch (err) {
                console.error(err);
                alert('Failed to clear description');
            } finally {
                clearDescriptionBtn.disabled = false;
            }
        });
    }

  // Website Font Size Selection

    // ==== Account Settings Logic ====
    const passwordForm = document.getElementById('password-change-form');
    const passwordStatus = document.getElementById('password-status');
    const emailForm = document.getElementById('email-update-form');
    const emailStatus = document.getElementById('email-status');
    const displayEmail = document.getElementById('display-email');

    const showAccountStatus = (el, msg, type) => {
        if (el) {
            el.textContent = msg;
            el.className = 'avatar-status ' + type;
            if (type === 'success') {
                setTimeout(() => { el.textContent = ''; el.className = 'avatar-status'; }, 5000);
            }
        }
    };

    if (passwordForm) {
        passwordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const current_password = document.getElementById('current_password').value;
            const new_password = document.getElementById('new_password').value;
            const new_password_confirm = document.getElementById('new_password_confirm').value;

            if (new_password !== new_password_confirm) {
                showAccountStatus(passwordStatus, 'New passwords do not match', 'error');
                return;
            }

            const btn = passwordForm.querySelector('button');
            btn.disabled = true;
            btn.textContent = 'Updating...';

            try {
                const res = await fetch('/api/v2/settings/password', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ current_password, new_password, new_password_confirm })
                });
                const data = await res.json();
                if (data.success) {
                    showAccountStatus(passwordStatus, data.msg || 'Password updated correctly', 'success');
                    passwordForm.reset();
                } else {
                    showAccountStatus(passwordStatus, data.msg || 'Failed to update password', 'error');
                }
            } catch (err) {
                showAccountStatus(passwordStatus, 'Request failed', 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Update Password';
            }
        });
    }

    if (emailForm) {
        emailForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email_input').value;

            const btn = emailForm.querySelector('button');
            btn.disabled = true;
            btn.textContent = 'Updating...';

            try {
                const res = await fetch('/api/v2/settings/email', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ email })
                });
                const data = await res.json();
                if (data.success) {
                    showAccountStatus(emailStatus, data.msg || 'Email updated correctly', 'success');
                    if (displayEmail) displayEmail.textContent = email;
                } else {
                    showAccountStatus(emailStatus, data.msg || 'Failed to update email', 'error');
                }
            } catch (err) {
                showAccountStatus(emailStatus, 'Request failed', 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Update Email';
            }
        });
    }

    // Display Name Update
    const displayNameBtn = document.getElementById('btn-update-display-name');
    const displayNameInput = document.getElementById('display_name_input');
    const displayNameStatus = document.getElementById('display-name-status');
    if (displayNameBtn && displayNameInput) {
        displayNameBtn.addEventListener('click', async () => {
            const display_name = displayNameInput.value;
            displayNameBtn.disabled = true;
            displayNameBtn.textContent = '...';

            try {
                const res = await fetch('/api/v2/settings/display_name', {
                    method: 'PUT',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ display_name })
                });
                const data = await res.json();
                if (data.success) {
                    showAccountStatus(displayNameStatus, data.msg || 'Display name updated!', 'success');
                    updateNavDisplayName(data.display_name);
                } else {
                    showAccountStatus(displayNameStatus, data.msg || 'Failed to update display name', 'error');
                }
            } catch (err) {
                showAccountStatus(displayNameStatus, 'Request failed', 'error');
            } finally {
                displayNameBtn.disabled = false;
                displayNameBtn.textContent = 'Save';
            }
        });
    }

    // ==== Min xD Score Filter ====
    const xdInput     = document.getElementById('min_xd_score_input');
    const xdValLabel  = document.getElementById('xd_score_val');
    const xdSaveBtn   = document.getElementById('btn-save-min-xd-score');
    const xdResetBtn  = document.getElementById('btn-reset-min-xd-score');
    const xdStatus    = document.getElementById('xd-score-status');
    const xdTierLabel = document.getElementById('xd_score_tier_label');

    const XD_TIERS = [
        null,
        { cls: 'xd-tier-1', label: 'xD' },
        { cls: 'xd-tier-2', label: 'xDD' },
        { cls: 'xd-tier-3', label: 'xDDD' },
        { cls: 'xd-tier-4', label: 'xDDDD' },
        { cls: 'xd-tier-5', label: 'xDDDDD+' },
    ];

    const getXdTier = (score) => {
        score = +score;
        if (score < 5)           return 0;
        if (score < 200)         return 1;
        if (score < 1000)        return 2;
        if (score < 100000)      return 3;
        if (score < 200000000)   return 4;
        return 5;
    };

    const XD_TIER_COLORS = ['#888', '#5a9e5a', '#8ac449', '#d4a017', '#e07b2a', '#ff5500'];

    const updateXdUI = (score) => {
        score = +score;
        if (xdValLabel) xdValLabel.textContent = score;
        const tier = getXdTier(score);
        // Color-coded slider track
        if (xdInput) {
            const pct = Math.round((score / +xdInput.max) * 100);
            const color = XD_TIER_COLORS[tier];
            xdInput.style.setProperty('--xd-fill', color);
            xdInput.style.setProperty('--xd-pct', pct + '%');
            if (xdValLabel) xdValLabel.style.color = color;
        }
        if (!xdTierLabel) return;
        const t = XD_TIERS[tier];
        if (!tier || score <= 0) {
            xdTierLabel.style.display = 'none';
            return;
        }
        xdTierLabel.className = `xd-score-badge ${t.cls}`;
        xdTierLabel.textContent = `≥ ${score} · ${t.label}`;
        xdTierLabel.style.display = 'inline-flex';
    };

    if (xdInput) {
        updateXdUI(+xdInput.value);
        xdInput.addEventListener('input', () => updateXdUI(+xdInput.value));
    }

    if (xdSaveBtn && xdInput) {
        xdSaveBtn.addEventListener('click', async () => {
            const min_xd_score = parseInt(xdInput.value, 10) || 0;
            xdSaveBtn.disabled = true;
            xdSaveBtn.textContent = i18n.saving || 'Saving...';
            try {
                const res = await fetch('/api/v2/settings/min_xd_score', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ min_xd_score })
                });
                const data = await res.json();
                if (data.success) {
                    if (xdStatus) {
                        xdStatus.textContent = min_xd_score > 0
                            ? `✓ Filter active — showing posts with xD score ≥ ${min_xd_score}`
                            : '✓ Filter disabled';
                        xdStatus.className = 'avatar-status success';
                        setTimeout(() => { xdStatus.textContent = ''; xdStatus.className = 'avatar-status'; }, 4000);
                    }
                } else {
                    alert(data.msg || 'Error saving preference');
                }
            } catch (err) {
                console.error(err);
                alert('Failed to save xD score preference');
            } finally {
                xdSaveBtn.disabled = false;
                xdSaveBtn.textContent = 'Save';
            }
        });
    }

    if (xdResetBtn && xdInput) {
        xdResetBtn.addEventListener('click', () => {
            xdInput.value = 0;
            updateXdUI(0);
            xdSaveBtn?.click();
        });
    }

    // ==== Ruffle (Flash) Settings ====
    const ruffleBackToggle  = document.getElementById('ruffle_background_toggle');
    const ruffleSaveBtn     = document.getElementById('btn-save-ruffle-settings');
    const ruffleStatus      = document.getElementById('ruffle-settings-status');



    if (ruffleBackToggle) {
        ruffleBackToggle.addEventListener('change', async () => {
            const ruffle_background = ruffleBackToggle.checked;

            try {
                const res = await fetch('/api/v2/settings/ruffle', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: JSON.stringify({ ruffle_background })
                });
                const data = await res.json();
                if (data.success) {
                    showAccountStatus(ruffleStatus, 'Flash settings updated!', 'success');
                    if (window.f0ckSession) {
                        window.f0ckSession.ruffle_background = ruffle_background;

                        // Apply to the active Ruffle player if it exists so user doesn't need to refresh
                        const ruffleContainer = document.getElementById('ruffle-container');
                        if (ruffleContainer) {
                            const player = ruffleContainer.querySelector('ruffle-player') || ruffleContainer.querySelector('ruffle-object');
                            if (player) {
                                // Ruffle doesn't dynamically toggle pageVisibility well without recreation,
                                // but we can update the config for subsequent initializations
                                if (window.RufflePlayer && window.RufflePlayer.config) {
                                    window.RufflePlayer.config.pageVisibility = !ruffle_background;
                                    window.RufflePlayer.config.backgroundExecution = ruffle_background ? "Unthrottled" : undefined;
                                }
                            }
                        }
                    }
                } else {
                    showAccountStatus(ruffleStatus, data.msg || 'Failed to update Flash settings', 'error');
                    ruffleBackToggle.checked = !ruffle_background; // Revert on failure
                }
            } catch (err) {
                console.error(err);
                showAccountStatus(ruffleStatus, 'Request failed', 'error');
                ruffleBackToggle.checked = !ruffle_background; // Revert on error
            }
        });
    }

    // ==== Export Data Logic ====
    const btnStartExport = document.getElementById('btn-start-export');
    const exportProgressContainer = document.getElementById('export-progress-container');
    const exportProgressBar = document.getElementById('export-progress-bar');
    const exportStatusText = document.getElementById('export-status-text');
    const exportStatusMsg = document.getElementById('export-status-msg');
    const chkExportUploads = document.getElementById('export_uploads');
    const chkExportFavorites = document.getElementById('export_favorites');
    const exportAnimatedDots = document.getElementById('export-animated-dots');

    if (btnStartExport) {
        btnStartExport.addEventListener('click', async () => {
            const exportUploads = chkExportUploads.checked;
            const exportFavorites = chkExportFavorites.checked;

            if (!exportUploads && !exportFavorites) {
                alert(exportStatusText.dataset.selectOption || 'Please select at least one option to export.');
                return;
            }

            btnStartExport.disabled = true;
            exportProgressContainer.style.display = 'block';
            exportProgressBar.style.width = '0%';
            exportStatusMsg.textContent = exportStatusText.dataset.fetching || 'Fetching data list...';

            try {
                const res = await fetch('/settings/export-data');
                const data = await res.json();

                // Use a Map to deduplicate downloads by ID while tracking multiple target folders
                const fileMap = new Map();
                if (chkExportUploads.checked) {
                    data.uploads.forEach(u => {
                        if (!fileMap.has(u.id)) fileMap.set(u.id, { ...u, folders: [] });
                        fileMap.get(u.id).folders.push('uploads');
                    });
                }
                if (chkExportFavorites.checked) {
                    data.favorites.forEach(f => {
                        if (!fileMap.has(f.id)) fileMap.set(f.id, { ...f, folders: [] });
                        fileMap.get(f.id).folders.push('favorites');
                    });
                }

                const filesToDownload = Array.from(fileMap.values());

                if (filesToDownload.length === 0) {
                    alert(exportStatusText.dataset.noData || 'No data found to export.');
                    btnStartExport.disabled = false;
                    exportProgressContainer.style.display = 'none';
                    return;
                }

                const metadata = {
                    exported_at: new Date().toISOString(),
                    user: window.f0ckSession?.user,
                    uploads: exportUploads ? data.uploads : [],
                    favorites: exportFavorites ? data.favorites : []
                };

                // STREAMING PATH (all browsers): Web Worker + Service Worker
                exportStatusMsg.textContent = exportStatusText.dataset.fetching || 'Preparing export...';
                exportAnimatedDots.style.display = 'inline';
                const siteDomain = (exportStatusText.dataset.domain || 'f0ckm').replace(/[^a-z0-9]/gi, '_').toLowerCase();
                const exportDate = new Date().toISOString().split('T')[0];
                const suggestedFileName = `${siteDomain}_export_${exportDate}.zip`;

                    
                    const workerCode = `
                        const crcTable = new Uint32Array(256);
                        for (let i = 0; i < 256; i++) {
                            let c = i;
                            for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                            crcTable[i] = c;
                        }
                        function crc32buf(data) {
                            let c = 0xffffffff;
                            for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ crcTable[(c ^ data[i]) & 0xff];
                            return (c ^ 0xffffffff) >>> 0;
                        }
                        function crc32update(c, data) {
                            for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ crcTable[(c ^ data[i]) & 0xff];
                            return c;
                        }
                        // Write a 64-bit LE integer; offset tracking stays in Number (safe to 2^53 ~9PB)
                        function u64(view, pos, val) { view.setBigUint64(pos, BigInt(val), true); }

                        let ackResolver = null;
                        self.onmessage = (e) => {
                            if (e.data.type === 'START') {
                                runExport(e.data.files, e.data.metadata).catch(err => {
                                    console.error('Worker global error:', err);
                                });
                            } else if (e.data.type === 'ACK') {
                                if (ackResolver) { const r = ackResolver; ackResolver = null; r(); }
                            }
                        };

                        async function send(chunk, done = false) {
                            self.postMessage({ type: 'CHUNK', chunk, done }, chunk ? [chunk.buffer] : []);
                            return new Promise(r => { ackResolver = r; });
                        }

                        async function runExport(files, metadata) {
                            const entries = [];
                            let offset = 0;

                            // Local header: 30 bytes fixed + name + 20-byte ZIP64 extra field
                            // ZIP64 extra: id(2) + dataSize(2) + uncompressedSize(8) + compressedSize(8)
                            async function writeLocalHeader(nameBuf, crc, size, streaming, time, day) {
                                const h = new Uint8Array(30 + nameBuf.length + 20);
                                const v = new DataView(h.buffer);
                                v.setUint32(0,  0x04034b50, true); // LFH signature
                                v.setUint16(4,  45,         true); // version needed: 4.5 (ZIP64)
                                v.setUint16(6,  streaming ? 0x0008 : 0, true); // flags
                                v.setUint16(8,  0,          true); // compression: STORE
                                v.setUint16(10, time,       true);
                                v.setUint16(12, day,        true);
                                v.setUint32(14, streaming ? 0 : crc,        true); // CRC-32
                                v.setUint32(18, 0xffffffff, true); // compressed size  → ZIP64
                                v.setUint32(22, 0xffffffff, true); // uncompressed size → ZIP64
                                v.setUint16(26, nameBuf.length, true);
                                v.setUint16(28, 20, true);         // extra field length
                                h.set(nameBuf, 30);
                                // ZIP64 extra field
                                const ex = new DataView(h.buffer, 30 + nameBuf.length);
                                ex.setUint16(0, 0x0001, true);     // ZIP64 extra ID
                                ex.setUint16(2, 16,     true);     // 2 × uint64
                                u64(ex, 4,  streaming ? 0 : size); // uncompressed size
                                u64(ex, 12, streaming ? 0 : size); // compressed size
                                const len = h.byteLength;
                                await send(h);
                                offset += len;
                            }

                            async function add(name, dataOrUrl) {
                                const d = new Date();
                                const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) >>> 0;
                                const day  = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) >>> 0;
                                const nameBuf     = new TextEncoder().encode(name);
                                const startOffset = offset;

                                if (typeof dataOrUrl !== 'string') {
                                    // ── Static (metadata, YouTube stubs) ─────────────────────────
                                    const data     = dataOrUrl;
                                    const dataSize = data.byteLength;
                                    const crc      = crc32buf(data);
                                    await writeLocalHeader(nameBuf, crc, dataSize, false, time, day);
                                    await send(data);
                                    offset += dataSize;
                                    entries.push({ name: nameBuf, size: dataSize, crc, offset: startOffset, time, day, flag: 0 });
                                } else {
                                    // ── Streamed (media files) ────────────────────────────────────
                                    await writeLocalHeader(nameBuf, 0, 0, true, time, day);
                                    let size = 0, crcState = 0xffffffff;
                                    const ctrl = new AbortController();
                                    const tid  = setTimeout(() => ctrl.abort(), 120000);
                                    try {
                                        const res = await fetch(dataOrUrl, { signal: ctrl.signal });
                                        if (res.ok && res.body) {
                                            const reader  = res.body.getReader();
                                            let lastLog   = Date.now();
                                            while (true) {
                                                const { done, value } = await reader.read();
                                                if (done) break;
                                                crcState       = crc32update(crcState, value);
                                                const chunkLen = value.byteLength; // capture before transfer
                                                size += chunkLen;
                                                await send(value);
                                                offset += chunkLen;
                                                if (Date.now() - lastLog > 1000) {
                                                    self.postMessage({ type: 'STATUS', msg: 'Streaming: ' + name + ' (' + Math.round(size / 1024 / 1024) + ' MB)' });
                                                    lastLog = Date.now();
                                                }
                                            }
                                        }
                                    } catch(err) {
                                        console.error('Export: fetch failed for', name, err.message);
                                    } finally { clearTimeout(tid); }

                                    const crc = (crcState ^ 0xffffffff) >>> 0;

                                    // ZIP64 Data Descriptor: sig(4) + crc(4) + sizes(8+8) = 24 bytes
                                    const dd  = new Uint8Array(24);
                                    const ddv = new DataView(dd.buffer);
                                    ddv.setUint32(0, 0x08074b50, true); // signature
                                    ddv.setUint32(4, crc,        true); // CRC-32
                                    u64(ddv, 8,  size);                 // compressed size (64-bit)
                                    u64(ddv, 16, size);                 // uncompressed size (64-bit)
                                    await send(dd);
                                    offset += 24;

                                    entries.push({ name: nameBuf, size, crc, offset: startOffset, time, day, flag: 0x0008 });
                                }
                            }

                            await add('metadata.json', new TextEncoder().encode(JSON.stringify(metadata, null, 2)));
                            for (let i = 0; i < files.length; i++) {
                                const f = files[i];
                                self.postMessage({ type: 'STATUS', msg: 'Packing: ' + f.name });
                                await add(f.name, f.content ? new TextEncoder().encode(f.content) : f.url);
                                self.postMessage({ type: 'PROGRESS', completed: i + 1 });
                            }

                            // ── Central Directory ─────────────────────────────────────────────
                            // Each entry: 46 fixed + name + 28-byte ZIP64 extra
                            // ZIP64 CD extra: id(2)+dataSize(2)+uncompressed(8)+compressed(8)+offset(8)
                            const cdOffset  = offset;
                            const cdExtraLen = 28;
                            let   cdSize    = 0;
                            for (const e of entries) cdSize += 46 + e.name.length + cdExtraLen;
                            const cd  = new Uint8Array(cdSize);
                            let   pos = 0;
                            for (const e of entries) {
                                const v = new DataView(cd.buffer, pos);
                                v.setUint32(0,  0x02014b50, true); // CDH signature
                                v.setUint16(4,  45,         true); // version made by (4.5)
                                v.setUint16(6,  45,         true); // version needed (4.5)
                                v.setUint16(8,  e.flag,     true);
                                v.setUint16(10, 0,          true); // STORE
                                v.setUint16(12, e.time,     true);
                                v.setUint16(14, e.day,      true);
                                v.setUint32(16, e.crc,      true);
                                v.setUint32(20, 0xffffffff, true); // compressed size  → ZIP64
                                v.setUint32(24, 0xffffffff, true); // uncompressed size → ZIP64
                                v.setUint16(28, e.name.length, true);
                                v.setUint16(30, cdExtraLen, true);
                                v.setUint16(32, 0, true); // comment length
                                v.setUint16(34, 0, true); // disk start
                                v.setUint16(36, 0, true); // internal attrs
                                v.setUint32(38, 0, true); // external attrs
                                v.setUint32(42, 0xffffffff, true); // local header offset → ZIP64
                                cd.set(e.name, pos + 46);
                                const ex = new DataView(cd.buffer, pos + 46 + e.name.length);
                                ex.setUint16(0, 0x0001,     true); // ZIP64 extra ID
                                ex.setUint16(2, 24,         true); // 3 × uint64
                                u64(ex, 4,  e.size);               // uncompressed size
                                u64(ex, 12, e.size);               // compressed size
                                u64(ex, 20, e.offset);             // local header offset
                                pos += 46 + e.name.length + cdExtraLen;
                            }
                            await send(cd);
                            offset += cdSize;

                            // ── ZIP64 End of Central Directory Record (56 bytes) ─────────────
                            const z64eocd = new Uint8Array(56);
                            const z64v    = new DataView(z64eocd.buffer);
                            z64v.setUint32(0,  0x06064b50, true); // signature
                            u64(z64v, 4,  44);                    // size of this record (after signature + size field)
                            z64v.setUint16(12, 45, true);         // version made by
                            z64v.setUint16(14, 45, true);         // version needed
                            z64v.setUint32(16, 0,  true);         // disk number
                            z64v.setUint32(20, 0,  true);         // disk with CD start
                            u64(z64v, 24, entries.length);        // entries this disk
                            u64(z64v, 32, entries.length);        // total entries
                            u64(z64v, 40, cdSize);                // CD size
                            u64(z64v, 48, cdOffset);              // CD offset
                            await send(z64eocd);
                            offset += 56;

                            // ── ZIP64 End of Central Directory Locator (20 bytes) ────────────
                            const z64loc  = new Uint8Array(20);
                            const z64lv   = new DataView(z64loc.buffer);
                            z64lv.setUint32(0,  0x07064b50,        true); // signature
                            z64lv.setUint32(4,  0,                 true); // disk with ZIP64 EOCD
                            u64(z64lv, 8, cdOffset + cdSize);             // offset of ZIP64 EOCD
                            z64lv.setUint32(16, 1,                 true); // total disks
                            await send(z64loc);
                            offset += 20;

                            // ── Standard EOCD (sentinel values point to ZIP64) ───────────────
                            const eocd = new Uint8Array(22);
                            const ev   = new DataView(eocd.buffer);
                            ev.setUint32(0,  0x06054b50, true); // signature
                            ev.setUint16(4,  0xffff,     true); // disk number → ZIP64
                            ev.setUint16(6,  0xffff,     true); // disk with CD → ZIP64
                            ev.setUint16(8,  0xffff,     true); // entries this disk → ZIP64
                            ev.setUint16(10, 0xffff,     true); // total entries → ZIP64
                            ev.setUint32(12, 0xffffffff, true); // CD size → ZIP64
                            ev.setUint32(16, 0xffffffff, true); // CD offset → ZIP64
                            ev.setUint16(20, 0,          true); // comment length
                            await send(eocd, true);

                            console.log('[ZIP64] Done. Files:', entries.length, 'CD offset:', cdOffset, 'Total bytes:', offset + 22);
                        }
                    `;

                    const streamId = Math.random().toString(36).substring(2);
                    const streamUrl = `/api/v2/export/stream?id=${streamId}&filename=${encodeURIComponent(suggestedFileName)}`;
                    const worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));
                    
                    // The SW must be controlling this page to intercept /api/v2/export/stream.
                    // .controller is null after hard refresh — in that case, reload once.
                    const sw = navigator.serviceWorker.controller;
                    if (!sw) {
                        worker.terminate();
                        exportStatusMsg.textContent = 'Reloading to activate Service Worker...';
                        setTimeout(() => location.reload(), 500);
                        return;
                    }

                     // Use location.href instead of <a> click - Chrome sometimes bypasses
                     // the Service Worker for <a download> requests, causing a 404.
                     // A navigation request always goes through the SW. Since the response has
                     // Content-Disposition: attachment, the browser downloads without navigating away.
                     window.location.href = streamUrl;

                    worker.onmessage = async (msg) => {
                        const data = msg.data;
                        if (data.type === 'PROGRESS') {
                            const percent = Math.round((data.completed / filesToDownload.length) * 100);
                            exportProgressBar.style.width = percent + '%';
                            if (data.completed === filesToDownload.length) {
                                exportStatusMsg.textContent = exportStatusText.dataset.generating || 'Finalizing archive...';
                            }
                        } else if (data.type === 'STATUS') {
                             exportStatusMsg.textContent = data.msg + '...';
                        } else if (data.type === 'CHUNK') {
                            const channel = new MessageChannel();
                            const ackPromise = new Promise((resolve) => {
                                const timeout = setTimeout(() => resolve({ type: 'TIMEOUT' }), 15000);
                                channel.port1.onmessage = (msg) => { clearTimeout(timeout); resolve(msg.data); };
                            });

                            sw.postMessage({ type: 'EXPORT_CHUNK', id: streamId, chunk: data.chunk, done: data.done }, data.chunk ? [channel.port2, data.chunk.buffer] : [channel.port2]);
                            
                            const response = await ackPromise;
                            if (response.type === 'ERROR') console.warn('Export: SW error', response.error);
                            
                            worker.postMessage({ type: 'ACK' });
                            
                            if (data.done) { 
                                exportStatusMsg.textContent = exportStatusText.dataset.complete || 'Export complete!'; 
                                setTimeout(() => worker.terminate(), 1000);
                            }
                        }
                    };

                    const origin = window.location.origin;
                    const mediaBase = window.f0ckMediaBase || '/b';
                    const workerFiles = [];
                    for (const f of filesToDownload) {
                        const folderNames = f.folders && f.folders.length > 0 ? f.folders : ['files'];

                        const filename = f.mime === 'video/youtube'
                            ? `${f.id}_youtube_${f.dest.replace(/^yt:/, '')}.txt`
                            : `${f.id}_${f.dest}`;

                        const content = f.mime === 'video/youtube'
                            ? `https://www.youtube.com/watch?v=${f.dest.replace(/^yt:/, '')}`
                            : null;

                        const absoluteUrl = content ? null : new URL(mediaBase + '/' + f.dest, origin).href;

                        for (const folder of folderNames) {
                            workerFiles.push(content
                                ? { name: `${folder}/${filename}`, content }
                                : { name: `${folder}/${filename}`, url: absoluteUrl }
                            );
                        }
                    }

                    worker.postMessage({ type: 'START', files: workerFiles, metadata });
                
                exportAnimatedDots.style.display = 'none';
                btnStartExport.disabled = false;
            } catch (err) {
                console.error('Export failed:', err);
                alert(exportStatusText.dataset.failedAlert || 'Export failed.');
                btnStartExport.disabled = false;
                exportStatusMsg.textContent = exportStatusText.dataset.failed || 'Export failed.';
            }
        });
    }

    // ============================================================
    // Upload API Key Management
    // ============================================================
    const apiKeyStatusBox    = document.getElementById('api-key-status-box');
    const apiKeyRevealBox    = document.getElementById('api-key-reveal');
    const apiKeyFullDisplay  = document.getElementById('api-key-full-display');
    const btnCopyApiKey      = document.getElementById('btn-copy-api-key');
    const btnRegenApiKey     = document.getElementById('btn-regen-api-key');
    const btnRevokeApiKey    = document.getElementById('btn-revoke-api-key');
    const btnShareXDownload  = document.getElementById('btn-sharex-download');
    const apiKeyActionStatus = document.getElementById('api-key-action-status');

    const showApiKeyStatus = (msg, type) => {
        if (!apiKeyActionStatus) return;
        apiKeyActionStatus.textContent = msg;
        apiKeyActionStatus.className = 'avatar-status ' + (type || '');
    };

    const renderApiKeyState = (hasKey, preview, createdAt) => {
        if (!apiKeyStatusBox) return;
        if (hasKey) {
            const date = createdAt ? new Date(createdAt).toLocaleString() : 'unknown';
            apiKeyStatusBox.innerHTML =
                `<span>Active key: <code style="font-size:0.9em;">${escHTML(preview)}</code></span>` +
                `<span style="color:var(--text-muted); margin-left:12px; font-size:0.85em;">Created: ${escHTML(date)}</span>`;
            if (btnRevokeApiKey) btnRevokeApiKey.style.display = '';
            if (btnShareXDownload) btnShareXDownload.style.display = '';
        } else {
            apiKeyStatusBox.innerHTML = '<span class="text-muted">No API key generated yet.</span>';
            if (btnRevokeApiKey) btnRevokeApiKey.style.display = 'none';
            if (btnShareXDownload) btnShareXDownload.style.display = 'none';
        }
    };

    // Load current state
    if (apiKeyStatusBox) {
        (async () => {
            try {
                const res = await fetch('/api/v2/settings/api-key');
                const data = await res.json();
                if (data.success) {
                    renderApiKeyState(data.has_key, data.preview, data.created_at);
                } else {
                    apiKeyStatusBox.innerHTML = '<span class="text-muted">Could not load key info.</span>';
                }
            } catch (e) {
                apiKeyStatusBox.innerHTML = '<span class="text-muted">Could not load key info.</span>';
            }
        })();
    }

    // Generate / Regenerate
    if (btnRegenApiKey) {
        btnRegenApiKey.addEventListener('click', async () => {
            if (btnRevokeApiKey && btnRevokeApiKey.style.display !== 'none') {
                // Key already exists — warn the user
                if (!confirm('Regenerating will immediately invalidate your current API key. Continue?')) return;
            }

            btnRegenApiKey.disabled = true;
            btnRegenApiKey.textContent = 'Generating…';
            showApiKeyStatus('', '');

            try {
                const res = await fetch('/api/v2/settings/api-key/regenerate', {
                    method: 'POST',
                    headers: { 'X-CSRF-Token': window.f0ckSession?.csrf_token }
                });
                const data = await res.json();

                if (data.success) {
                    // Show one-time reveal box
                    if (apiKeyFullDisplay) apiKeyFullDisplay.textContent = data.api_key;
                    if (apiKeyRevealBox) apiKeyRevealBox.style.display = '';

                    // Update status row to masked preview
                    const preview = '****' + data.api_key.slice(-8);
                    renderApiKeyState(true, preview, new Date().toISOString());
                    showApiKeyStatus('Key generated. Copy it now — it will not be shown in full again.', 'success');
                } else {
                    showApiKeyStatus(data.msg || 'Failed to generate key.', 'error');
                }
            } catch (e) {
                showApiKeyStatus('Request failed.', 'error');
            } finally {
                btnRegenApiKey.disabled = false;
                btnRegenApiKey.textContent = 'Generate / Regenerate Key';
            }
        });
    }

    // Copy key to clipboard
    if (btnCopyApiKey) {
        btnCopyApiKey.addEventListener('click', async () => {
            const key = apiKeyFullDisplay?.textContent?.trim();
            if (!key) return;
            try {
                await navigator.clipboard.writeText(key);
                const orig = btnCopyApiKey.textContent;
                btnCopyApiKey.textContent = 'Copied!';
                setTimeout(() => { btnCopyApiKey.textContent = orig; }, 2000);
            } catch (e) {
                // Fallback: select the text
                const range = document.createRange();
                range.selectNodeContents(apiKeyFullDisplay);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        });
    }

    // Revoke key
    if (btnRevokeApiKey) {
        btnRevokeApiKey.addEventListener('click', async () => {
            if (!confirm('Revoke your API key? This cannot be undone — you will need to generate a new one.')) return;

            btnRevokeApiKey.disabled = true;
            btnRevokeApiKey.textContent = 'Revoking…';

            try {
                const res = await fetch('/api/v2/settings/api-key', {
                    method: 'DELETE',
                    headers: { 'X-CSRF-Token': window.f0ckSession?.csrf_token }
                });
                const data = await res.json();

                if (data.success) {
                    btnRevokeApiKey.disabled = false;
                    btnRevokeApiKey.textContent = 'Revoke Key';
                    renderApiKeyState(false, null, null);
                    if (apiKeyRevealBox) apiKeyRevealBox.style.display = 'none';
                    if (apiKeyFullDisplay) apiKeyFullDisplay.textContent = '';
                    showApiKeyStatus('API key revoked.', 'success');
                } else {
                    showApiKeyStatus(data.msg || 'Failed to revoke key.', 'error');
                    btnRevokeApiKey.disabled = false;
                    btnRevokeApiKey.textContent = 'Revoke Key';
                }
            } catch (e) {
                showApiKeyStatus('Request failed.', 'error');
                btnRevokeApiKey.disabled = false;
                btnRevokeApiKey.textContent = 'Revoke Key';
            }
        });
    }

})();
