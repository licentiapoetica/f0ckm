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
        if (score <= 0)  return 0;
        if (score < 5)   return 1;
        if (score < 15)  return 2;
        if (score < 30)  return 3;
        if (score < 60)  return 4;
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

                let filesToDownload = [];
                if (exportUploads) {
                    filesToDownload = filesToDownload.concat(data.uploads.map(f => ({ ...f, exportType: 'uploads' })));
                }
                if (exportFavorites) {
                    filesToDownload = filesToDownload.concat(data.favorites.map(f => ({ ...f, exportType: 'favorites' })));
                }

                if (filesToDownload.length === 0) {
                    alert(exportStatusText.dataset.noData || 'No data found to export.');
                    btnStartExport.disabled = false;
                    exportProgressContainer.style.display = 'none';
                    return;
                }

                const zip = new JSZip();
                const uploadsFolder = zip.folder("uploads");
                const favoritesFolder = zip.folder("favorites");

                const metadata = {
                    exported_at: new Date().toISOString(),
                    user: window.f0ckSession?.user,
                    uploads: exportUploads ? data.uploads : [],
                    favorites: exportFavorites ? data.favorites : []
                };
                zip.file("metadata.json", JSON.stringify(metadata, null, 2));

                const total = filesToDownload.length;
                let completed = 0;

                const downloadFile = async (fileInfo) => {
                    const folder = fileInfo.exportType === 'uploads' ? uploadsFolder : favoritesFolder;

                    if (fileInfo.mime === 'video/youtube') {
                        const ytId = fileInfo.dest.replace(/^yt:/, '');
                        folder.file(`${fileInfo.id}_youtube_${ytId}.txt`, `https://www.youtube.com/watch?v=${ytId}`);
                        completed++;
                        const percent = Math.round((completed / total) * 100);
                        exportProgressBar.style.width = percent + '%';
                        const msg = (exportStatusText.dataset.processing || 'Processing files: {completed} / {total}')
                            .replace('{completed}', completed)
                            .replace('{total}', total);
                        exportStatusMsg.textContent = msg;
                        return;
                    }

                    try {
                        const url = (window.f0ckMediaBase || '/b') + '/' + fileInfo.dest;
                        const response = await fetch(url);
                        const blob = await response.blob();
                        folder.file(`${fileInfo.id}_${fileInfo.dest}`, blob);
                    } catch (err) {
                        console.error('Failed to download file:', fileInfo.id, err);
                    } finally {
                        completed++;
                        const percent = Math.round((completed / total) * 100);
                        exportProgressBar.style.width = percent + '%';
                        const msg = (exportStatusText.dataset.processing || 'Processing files: {completed} / {total}')
                            .replace('{completed}', completed)
                            .replace('{total}', total);
                        exportStatusMsg.textContent = msg;
                    }
                };

                // Download in batches to avoid overwhelming the browser/server
                const batchSize = 3;
                for (let i = 0; i < filesToDownload.length; i += batchSize) {
                    const batch = filesToDownload.slice(i, i + batchSize);
                    await Promise.all(batch.map(downloadFile));
                }

                exportStatusMsg.textContent = exportStatusText.dataset.generating || 'Generating ZIP file';
                exportAnimatedDots.style.display = 'inline';
                const content = await new Promise((resolve, reject) => {
                    const chunks = [];
                    zip.generateInternalStream({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
                        .on('data', (chunk) => chunks.push(chunk))
                        .on('error', reject)
                        .on('end', () => {
                            try {
                                resolve(new Blob(chunks, { type: 'application/zip' }));
                            } catch (e) {
                                reject(e);
                            }
                        })
                        .resume();
                });
                exportAnimatedDots.style.display = 'none';
                
                const link = document.createElement('a');
                link.href = URL.createObjectURL(content);
                link.download = `f0ckm_export_${new Date().toISOString().split('T')[0]}.zip`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                exportStatusMsg.textContent = exportStatusText.dataset.complete || 'Export complete!';
                btnStartExport.disabled = false;
            } catch (err) {
                console.error('Export failed:', err);
                alert(exportStatusText.dataset.failedAlert || 'Export failed. See console for details.');
                btnStartExport.disabled = false;
                exportStatusMsg.textContent = exportStatusText.dataset.failed || 'Export failed.';
            }
        });
    }

})();
