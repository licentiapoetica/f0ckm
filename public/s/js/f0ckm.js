
// Normalize percent-encoded characters in the URL bar that are safe to show decoded.
// Runs immediately so the address bar is clean before any other JS runs.
(function () {
  try {
    const p = window.location.pathname;
    // Decode colon and space; leave %2F (/), %3F (?), %23 (#), %26 (&) encoded.
    const clean = p.replace(/%3A/gi, ':').replace(/%20/gi, ' ');
    if (clean !== p) {
      history.replaceState(null, '', clean + window.location.search + window.location.hash);
    }
  } catch (_) {}
})();

window.requestAnimFrame = (function () {

  return window.requestAnimationFrame
    || window.webkitRequestAnimationFrame
    || window.mozRequestAnimationFrame
    || function (callback) { window.setTimeout(callback, 1000 / 60); };
})();

window.cancelAnimFrame = (function () {
  return window.cancelAnimationFrame
    || window.webkitCancelAnimationFrame
    || window.mozCancelAnimationFrame
    || function (id) { window.clearTimeout(id); };
})();


(() => {
  var i18n = window.f0ckI18n || {};
  window.escHTML = (str) => {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  window.getCurrentItemId = () => {
    const path = window.location.pathname;
    // Explicitly ignore admin/mod/settings paths to avoid false positives from user IDs, etc.
    if (path.includes('/admin/') || path.includes('/mod/') || path.includes('/settings') || path.includes('/user/')) return null;
    const match = path.match(/\/(\d+)\/?$/);
    return match ? match[1] : null;
  };

  // OS and Browser detection for CSS targeting
  const ua = navigator.userAgent;
  const htmlEl = document.documentElement;
  if (ua.includes('Linux')) htmlEl.classList.add('is-linux');
  if (ua.includes('Windows')) htmlEl.classList.add('is-windows');
  if (ua.includes('Firefox')) htmlEl.classList.add('is-firefox');
  if (ua.includes('Chrome')) htmlEl.classList.add('is-chrome');
  if (ua.includes('Safari') && !ua.includes('Chrome')) htmlEl.classList.add('is-safari');

  if (localStorage.getItem('blurNsfw') === 'true') htmlEl.classList.add('blur-nsfw-active');
  if (localStorage.getItem('blurNsfl') === 'true') htmlEl.classList.add('blur-nsfl-active');
  if (localStorage.getItem('blurSfw') === 'true') htmlEl.classList.add('blur-sfw-active');
  if (localStorage.getItem('blurUntagged') === 'true') htmlEl.classList.add('blur-untagged-active');
  if (localStorage.getItem('blurDetail') !== 'false') htmlEl.classList.add('blur-detail-active');

  window.updateVisitIndicators = () => {
      try {
          // View indicators and counters have been permanently removed as requested.
          // This function is now a no-op to prevent injection into items.
      } catch (e) { console.error('Visit tracking error:', e); }
  };

  window.trackVisit = (id) => {
      try {
          const visits = JSON.parse(localStorage.getItem('visited_videos') || '{}');
          visits[id] = (visits[id] || 0) + 1;
          localStorage.setItem('visited_videos', JSON.stringify(visits));
          // Delay update slightly to ensure DOM is ready? No, update immediately is fine.
          updateVisitIndicators();
      } catch(e) { console.error('Visit tracking error:', e); }
  };

  window.applyThumbCacheBust = (bgUrlStr) => {
      if (!bgUrlStr) return bgUrlStr;
      try {
          const bustedStr = localStorage.getItem('bustedThumbs');
          if (!bustedStr) return bgUrlStr;
          const busted = JSON.parse(bustedStr);
          const match = bgUrlStr.match(/\/t\/(\d+)(?:_blur)?\.webp/);
          if (match) {
              const id = match[1];
              if (busted[id]) {
                  const url = new URL(bgUrlStr, window.location.origin);
                  url.searchParams.set('t', busted[id]);
                  return url.pathname + url.search;
              }
          }
      } catch(e) {}
      return bgUrlStr;
  };

  /**
   * Forcefully refreshes all thumbnail occurrences for a specific item in the DOM.
   * Handles grid items (data-bg), images (src), and the background canvas.
   */
  window.refreshItemThumbnails = (itemId, timestamp = Date.now()) => {
      if (!itemId) return;
      const idStr = String(itemId);
      
      // Update localStorage so future navigations use the new timestamp
      try {
          const bustedStr = localStorage.getItem('bustedThumbs');
          const busted = bustedStr ? JSON.parse(bustedStr) : {};
          busted[idStr] = timestamp;
          const keys = Object.keys(busted);
          if (keys.length > 50) delete busted[keys[0]];
          localStorage.setItem('bustedThumbs', JSON.stringify(busted));
      } catch(e) {}

      // Clear grid cache to force fresh render on next navigation
      if (typeof gridCacheMap !== 'undefined') gridCacheMap.clear();

      // Update elements with data-bg (grid items).
      // We look for any data-bg or inline style containing the thumbnail path for this ID.
      document.querySelectorAll(`[data-bg*="/t/${idStr}.webp"], [data-bg*="/t/${idStr}_blur.webp"], [style*="/t/${idStr}.webp"], [style*="/t/${idStr}_blur.webp"]`).forEach(el => {
          // If it has data-bg, update it (this handles lazy-thumb logic)
          if (el.dataset.bg) {
              el.dataset.bg = window.applyThumbCacheBust(el.dataset.bg);
          }
          // If it's already showing the background, update the style directly
          if (el.style.backgroundImage || el.getAttribute('style')?.includes('background-image')) {
              const currentStyle = el.getAttribute('style') || '';
              // Match url(...) contents
              const newStyle = currentStyle.replace(/url\(['"]?([^'"]+)['"]?\)/g, (match, p1) => {
                  if (p1.includes(`/t/${idStr}.webp`) || p1.includes(`/t/${idStr}_blur.webp`)) {
                      return `url('${window.applyThumbCacheBust(p1)}')`;
                  }
                  return match;
              });
              el.setAttribute('style', newStyle);
          }
      });

      // Update actual img tags
      document.querySelectorAll(`img[src*="/t/${idStr}.webp"], img[src*="/t/${idStr}_blur.webp"]`).forEach(el => {
          try {
              const url = new URL(el.src, window.location.origin);
              url.searchParams.set('t', timestamp);
              el.src = url.pathname + url.search;
          } catch(e) {}
      });

      // Refresh background canvas if it matches the current item
      const currentId = window.getCurrentItemId();
      if (currentId === idStr && window.initBackground) {
          window.initBackground();
      }
  };

  let lazyObserver;
  window.initLazyLoading = () => {
    if (!('IntersectionObserver' in window)) {
        document.querySelectorAll('.lazy-thumb').forEach(thumb => {
            let bg = thumb.dataset.bg;
            if (bg) {
                 const mode = thumb.getAttribute('data-mode');
                 const blurNsfw = localStorage.getItem('blurNsfw') === 'true';
                 const blurNsfl = localStorage.getItem('blurNsfl') === 'true';
                 const blurSfw = localStorage.getItem('blurSfw') === 'true';
                 const blurUntagged = localStorage.getItem('blurUntagged') === 'true';
                 
                 let shouldBlurThis = false;
                 if (mode === 'nsfw') shouldBlurThis = blurNsfw;
                 else if (mode === 'nsfl') shouldBlurThis = blurNsfl;
                 else if (mode === 'sfw') shouldBlurThis = blurSfw;
                 else if (mode === 'null' || !mode) shouldBlurThis = blurUntagged;
                 
                 if (shouldBlurThis && !thumb.classList.contains('revealed')) {
                     bg = bg.replace('.webp', '_blur.webp');
                 }
                 const finalBg = window.applyThumbCacheBust(bg);
                 thumb.style.backgroundImage = `url('${finalBg}')`;
                 thumb.classList.remove('lazy-thumb');
            }
        });
        return;
    }

    if (!lazyObserver) {
        lazyObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const thumb = entry.target;
                    let bg = thumb.dataset.bg;
                    if (bg && !thumb.classList.contains('loaded')) {
                        const mode = thumb.getAttribute('data-mode');
                        const blurNsfw = localStorage.getItem('blurNsfw') === 'true';
                        const blurNsfl = localStorage.getItem('blurNsfl') === 'true';
                        const blurSfw = localStorage.getItem('blurSfw') === 'true';
                        const blurUntagged = localStorage.getItem('blurUntagged') === 'true';
                        
                        let shouldBlurThis = false;
                        if (mode === 'nsfw') shouldBlurThis = blurNsfw;
                        else if (mode === 'nsfl') shouldBlurThis = blurNsfl;
                        else if (mode === 'sfw') shouldBlurThis = blurSfw;
                        else if (mode === 'null' || !mode) shouldBlurThis = blurUntagged;
                        
                        if (shouldBlurThis && !thumb.classList.contains('revealed')) {
                            bg = bg.replace('.webp', '_blur.webp');
                        }

                        bg = window.applyThumbCacheBust(bg);
                        const img = new Image();
                        img.onload = () => {
                            thumb.style.backgroundImage = `url('${bg}')`;
                            thumb.classList.add('loaded');
                            thumb.classList.remove('lazy-thumb');
                        };
                        img.onerror = () => {
                            const retries = parseInt(thumb.dataset.retries || '0');
                            if (retries < 3) {
                                thumb.dataset.retries = retries + 1;
                                setTimeout(() => {
                                    img.src = bg + '?r=' + Date.now();
                                }, 1000);
                            } else {
                                // All retries exhausted — show fallback for audio items
                                const mime = thumb.dataset.mime || '';
                                if (mime.startsWith('audio/')) {
                                    thumb.style.backgroundImage = `url('/s/img/audio.webp')`;
                                    thumb.classList.add('thumb-fallback');
                                }
                                thumb.classList.remove('lazy-thumb');
                            }
                        };
                        img.src = bg;
                    }
                    lazyObserver.unobserve(thumb);
                }
            });
        }, { rootMargin: '300px 0px', threshold: 0.01 });
    }

    // Nudge lazy loading on tab switch to prevent stuck skeletons in inactive tabs
    if (!window._lazyVisibilityBound) {
        window._lazyVisibilityBound = true;
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && typeof window.initLazyLoading === 'function') {
                // Clear observation state for pending items to force re-observation
                document.querySelectorAll('.lazy-thumb:not(.loaded)').forEach(t => {
                    delete t.dataset.lazyObserved;
                });
                window.initLazyLoading();
            }
        });
    }

    document.querySelectorAll('.lazy-thumb').forEach(thumb => {
        if (!thumb.dataset.lazyObserved) {
            thumb.dataset.lazyObserved = 'true';
            lazyObserver.observe(thumb);
        }
    });
  };

  window.showMediaOverlay = (show = true) => {
    const overlay = document.querySelector('.v0ck_overlay');
    if (overlay) overlay.classList[show ? 'remove' : 'add']('v0ck_hidden');
  };

  window.flashMessage = (text, duration = 2000, type = 'info') => {
    // Ensure the stacking container exists
    let container = document.getElementById('f0ck-flash-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'f0ck-flash-container';
      container.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:9999;display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none;';
      document.body.appendChild(container);
    }

    const flash = document.createElement('div');
    flash.textContent = text;

    let baseStyle = 'color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;opacity:0;transition:opacity 0.3s,transform 0.3s;box-shadow:0 4px 12px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);transform:translateY(6px);';
    if (type === 'error') {
      baseStyle += 'background:rgba(200,30,30,0.95);';
    } else if (type === 'success') {
      baseStyle += 'background:rgba(30,130,60,0.95);';
    } else {
      baseStyle += 'background:rgba(30,30,30,0.95);';
    }

    flash.style.cssText = baseStyle;
    container.appendChild(flash);

    requestAnimationFrame(() => {
      flash.style.opacity = '1';
      flash.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
      flash.style.opacity = '0';
      flash.style.transform = 'translateY(6px)';
      setTimeout(() => flash.remove(), 300);
    }, duration);
  };



  let video;
  let isNavigating = false;
  const main = document.getElementById('main');
  let posts = document.querySelector('.posts');
  const navbar = document.querySelector("nav.navbar");
  const gridCacheMap = new Map(); // Cache for detached grid nodes (URL -> {node, scroll})
  window.activeMode = 0; // Default
  let audioCtx = null;
  let visualizerRafId = null;
  let audioSource = null;

  const updateMimeLabel = () => {
    let mimeStr = null;
    const cookieMime = document.cookie.split('; ').find(row => row.startsWith('mime='));
    if (cookieMime) {
        mimeStr = cookieMime.split('=')[1];
    }
    
    const selected = mimeStr ? mimeStr.split(',').filter(m => ['video', 'audio', 'image', 'flash'].includes(m)) : [];

    document.querySelectorAll('.nav-mime-btn').forEach(btn => {
      let label = 'ALL';
      if (selected.length > 0) {
        label = selected.map(s => s.charAt(0).toUpperCase()).sort().join(',');
      }
      btn.innerHTML = `${label} ▾`;
    });

    document.querySelectorAll('.nav-mime-menu').forEach(menu => {
      menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = selected.includes(cb.value);
      });
    });

    if (window.updateFilterBadge) window.updateFilterBadge();
  };
  window.updateMimeLabel = updateMimeLabel;

  const updateFilterBadge = () => {
    const badge = document.getElementById('nav-filter-badge');
    if (!badge) return;

    let activeMode = 0;
    if (window.activeMode !== undefined) {
      activeMode = window.activeMode;
    } else {
      const cookieMode = document.cookie.split('; ').find(row => row.startsWith('mode='));
      if (cookieMode) {
        activeMode = +cookieMode.split('=')[1];
      } else if (window.f0ckSession && window.f0ckSession.mode !== undefined) {
        activeMode = window.f0ckSession.mode;
      }
    }

    let hasMimeFilter = false;
    let mimeStr = '';
    const cookieMime = document.cookie.split('; ').find(row => row.startsWith('mime='));
    if (cookieMime) {
      mimeStr = cookieMime.split('=')[1] || '';
    }
    const selectedMimes = mimeStr ? mimeStr.split(',').filter(m => ['video', 'audio', 'image', 'flash'].includes(m)) : [];
    if (selectedMimes.length > 0) {
      hasMimeFilter = true;
    }

    let badgeText = '';
    let badgeClass = 'filter-badge';

    switch (activeMode) {
      case 0:
        badgeText = 'SFW';
        badgeClass += ' filter-badge-sfw';
        break;
      case 1:
        badgeText = 'NSFW';
        badgeClass += ' filter-badge-nsfw';
        break;
      case 4:
        badgeText = 'NSFL';
        badgeClass += ' filter-badge-nsfl';
        break;
      case 2:
        badgeText = 'UNT';
        badgeClass += ' filter-badge-unt';
        break;
      case 3:
        badgeText = 'ALL';
        badgeClass += ' filter-badge-all';
        break;
      default:
        badgeText = 'SFW';
        badgeClass += ' filter-badge-sfw';
    }

    const isRandom = document.cookie.includes('random_mode=1');
    let zomgHtml = '';
    if (isRandom) {
      zomgHtml = ' <span class="zomg-z" title="ZOMG Mode Active (Shuffle!)">Z</span>';
    }

    badge.className = badgeClass;
    badge.innerHTML = badgeText + zomgHtml;

    if (hasMimeFilter) {
      const iconsContainer = document.createElement('span');
      iconsContainer.className = 'filter-mime-icons';
      selectedMimes.forEach(mime => {
        const icon = document.createElement('i');
        let iconClass = 'mime-icon ';
        if (mime === 'audio') iconClass += 'fa-solid fa-music mime-icon-audio';
        else if (mime === 'image') iconClass += 'fa-solid fa-image mime-icon-image';
        else if (mime === 'video') iconClass += 'fa-solid fa-film mime-icon-video';
        else if (mime === 'flash') iconClass += 'fa-solid fa-bolt mime-icon-flash';
        
        icon.className = iconClass;
        icon.title = mime.charAt(0).toUpperCase() + mime.slice(1);
        iconsContainer.appendChild(icon);
      });
      badge.appendChild(iconsContainer);
    }

    badge.style.display = 'inline-flex';
  };
  window.updateFilterBadge = updateFilterBadge;

  document.addEventListener('f0ck:modeChanged', () => {
    updateFilterBadge();
  });
  window.randomizeLogo = () => {
    const logoArr = window.f0ckBrandImages;
    if (!logoArr || !logoArr.length) return;
    const img = document.getElementById('navbar-logo');
    if (!img) return;
    // Avoid picking the same image if there's more than one
    let randomImg;
    do {
      randomImg = logoArr[Math.floor(Math.random() * logoArr.length)];
    } while (logoArr.length > 1 && randomImg === img.getAttribute('src'));
    img.src = randomImg;
  };

  // Initialize active mode from UI
  const activeModeBtn = document.querySelector('.mode-btn.active');
  if (activeModeBtn) {
    const modeMatch = activeModeBtn.href.match(/\/mode\/(\d)/);
    if (modeMatch) window.activeMode = +modeMatch[1];
  }

  // Cleanup strict param from URL bar on initial load if present (legacy or external link)
  if (window.location.search.includes('strict=1')) {
    const cleanUrl = window.location.pathname + window.location.search.replace(/[?&]strict=1/, '').replace(/[?&]$/, '') + window.location.hash;
    history.replaceState({}, '', cleanUrl);
  }

  // User & Visitor dropdown toggle
  const userToggle = document.getElementById('nav-user-toggle');
  const userMenu = document.getElementById('nav-user-menu');
  const visitorToggle = document.getElementById('nav-visitor-toggle');
  const visitorMenu = document.getElementById('nav-visitor-menu');
  const hallsToggle = document.getElementById('nav-halls-toggle');
  const hallsMenu = document.getElementById('nav-halls-menu');
  const vHallsToggle = document.getElementById('nav-visitor-halls-toggle');
  const vHallsMenu = document.getElementById('nav-visitor-halls-menu');

  if (userToggle && userMenu) {
    userToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !userMenu.classList.contains('show');
      userMenu.classList.toggle('show');
      userToggle.classList.toggle('is-active', opening);
    });

    userMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        userMenu.classList.remove('show');
        userMenu.classList.remove('show-mobile');
        userToggle.classList.remove('is-active');
      });
    });
  }

  if (visitorToggle && visitorMenu) {
    visitorToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      visitorMenu.classList.toggle('show');
    });

    visitorMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        visitorMenu.classList.remove('show');
        visitorMenu.classList.remove('show-mobile');
      });
    });
  }

  const setupHallsToggle = (toggle, menu) => {
    if (toggle && menu) {
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        menu.classList.toggle('show');
      });
      menu.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => menu.classList.remove('show'));
      });
    }
  };

  setupHallsToggle(hallsToggle, hallsMenu);
  setupHallsToggle(vHallsToggle, vHallsMenu);

  document.addEventListener('click', (e) => {
    if (userMenu && !userMenu.contains(e.target) && userToggle && !userToggle.contains(e.target)) {
      userMenu.classList.remove('show');
      userToggle.classList.remove('is-active');
    }
    if (visitorMenu && !visitorMenu.contains(e.target) && visitorToggle && !visitorToggle.contains(e.target)) {
      visitorMenu.classList.remove('show');
    }
    if (hallsMenu && !hallsMenu.contains(e.target) && hallsToggle && !hallsToggle.contains(e.target)) {
      hallsMenu.classList.remove('show');
    }
    if (vHallsMenu && !vHallsMenu.contains(e.target) && vHallsToggle && !vHallsToggle.contains(e.target)) {
      vHallsMenu.classList.remove('show');
    }
  });

  // Randomize logo on click
  document.addEventListener('click', (e) => {
    if (e.target.closest('.navbar-brand') || e.target.id === 'navbar-logo') {
      window.randomizeLogo();
    }
  });

  // Modal Logic (Login, Forgot, Reset, Register)
  const loginBtn = document.getElementById('nav-login-btn');
  const loginModal = document.getElementById('login-modal');
  const loginClose = document.getElementById('login-modal-close');
  const registerBtn = document.getElementById('nav-register-btn');
  const registerModal = document.getElementById('register-modal');
  const registerClose = document.getElementById('register-modal-close');

  const switchModalView = (view) => {
    if (!loginModal) return;
    const views = ['login', 'forgot', 'reset'];
    views.forEach(v => {
      const el = document.getElementById(`modal-${v}-view`);
      if (el) el.style.display = (v === view) ? 'block' : 'none';
    });
  };

  const openModal = (modal, view = 'login') => {
    if (!modal) return;
    if (modal === loginModal) switchModalView(view);
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
    if (visitorMenu) visitorMenu.classList.remove('show');
  };

  const closeModal = (modal) => {
    if (modal) {
      modal.style.display = 'none';
      document.body.classList.remove('modal-open');
    }
  };

  /**
   * Surgical cleanup of scroll-lock state and modal visibility.
   * Used during AJAX navigation to ensure the UI remains interactive.
   */
  window.resetGlobalScrollState = () => {
    document.body.classList.remove('modal-open');
    document.documentElement.classList.remove('modal-open');
    document.body.style.overflow = '';
    document.body.style.height = '';
    document.documentElement.style.overflow = '';
    document.documentElement.style.height = '';
    const pw = document.querySelector('.pagewrapper');
    if (pw) {
      pw.style.overflow = '';
      pw.style.height = '';
    }
  };

  window.hideAllModals = () => {
    const modalIds = [
      'login-modal', 'register-modal', 'forgot-modal', 'reset-modal',
      'report-modal', 'halls-modal', 'metadata-modal', 'warning-modal',
      'shortcuts-modal', 'upload-drag-modal', 'excluded-tags-overlay',
      'content-warning-modal', 'gchat-img-modal', 'image-modal', 'info-modal'
    ];
    modalIds.forEach(id => {
      // Don't close the filter modal during a background mime-filter reload
      if (id === 'excluded-tags-overlay' && window._keepFilterModal) return;
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('show', 'visible');
        // If the modal uses CSS classes for visibility, we must clear the inline display
        // to allow those classes to work later. For others, we force display: none.
        if (['upload-drag-modal', 'image-modal', 'gchat-img-modal', 'excluded-tags-overlay'].includes(id)) {
           el.style.display = '';
        } else {
           el.style.display = 'none';
        }
      }
    });
    // Also handle class-based modals if any
    document.querySelectorAll('.modal-overlay, .modal-backdrop').forEach(el => {
      el.classList.remove('show', 'visible');
      // Do NOT set display: none here as it might override CSS-based visibility
      // for modals that use the classes we just removed.
    });
  };

  if (loginModal) {
    if (loginBtn) {
      loginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openModal(loginModal, 'login');
      });
    }

    if (loginClose) loginClose.addEventListener('click', () => closeModal(loginModal));

    loginModal.addEventListener('click', (e) => {
      if (e.target === loginModal) closeModal(loginModal);
    });

    // Forgot Password link
    const modalForgotBtn = document.getElementById('modal-forgot-btn');
    if (modalForgotBtn) {
      modalForgotBtn.addEventListener('click', (e) => {
        e.preventDefault();
        switchModalView('forgot');
      });
    }

    const forgotToLogin = document.getElementById('forgot-to-login');
    if (forgotToLogin) {
      forgotToLogin.addEventListener('click', (e) => {
        e.preventDefault();
        switchModalView('login');
      });
    }

    // Check for reset token or login flag in URL
    const urlParams = new URLSearchParams(window.location.search);
    const resetToken = urlParams.get('token');
    if (resetToken) {
      const tokenInput = document.getElementById('reset-token');
      if (tokenInput) {
        tokenInput.value = resetToken;
        openModal(loginModal, 'reset');
        
        // Clean URL
        const cleanUrl = window.location.pathname + window.location.search.replace(/[?&]token=[^&]+/, '').replace(/[?&]$/, '') + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);
      }
    } else if (urlParams.get('login') === '1') {
      openModal(loginModal, 'login');
      // Clean URL
      const cleanUrl = window.location.pathname + window.location.search.replace(/[?&]login=1/, '').replace(/[?&]$/, '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    } else if (urlParams.get('already_logged_in') === '1') {
      // Clean URL first, then show flash (deferred so window.showFlash is defined)
      const cleanUrl = window.location.pathname + window.location.search.replace(/[?&]already_logged_in=1/, '').replace(/[?&]$/, '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
      setTimeout(() => {
          window.showFlash(i18n.already_logged_in || 'Already logged in lol', 'error');
      }, 0);
    }

    const loginForm = loginModal.querySelector('.login-form');
    if (loginForm && loginForm.id !== 'forgot-password-form' && loginForm.id !== 'reset-password-form') {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(loginForm);
        const params = new URLSearchParams(formData);

        if (!formData.get('password')) {
          let errDiv = loginForm.querySelector('.flash-error');
          if (!errDiv) {
            errDiv = document.createElement('div');
            errDiv.className = 'flash-error';
            loginForm.insertBefore(errDiv, loginForm.firstChild);
          }
          errDiv.textContent = 'Invalid username or password.';
          return;
        }

        try {
          const res = await fetch('/login', {
            method: 'POST',
            headers: {
              'X-Requested-With': 'XMLHttpRequest',
              'Accept': 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params
          });

          if (res.redirected) {
            window.location.href = res.url;
            return;
          }

          const json = await res.json();
          if (json && json.success === false) {
            let errDiv = loginForm.querySelector('.flash-error');
            if (!errDiv) {
              errDiv = document.createElement('div');
              errDiv.className = 'flash-error';
              loginForm.insertBefore(errDiv, loginForm.firstChild);
            }
            errDiv.textContent = json.msg;
          }
        } catch (err) {
          console.error('Login error:', err);
        }
      });
    }

    // Forgot Password Submit
    const forgotForm = document.getElementById('forgot-password-form');
    if (forgotForm) {
      forgotForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('forgot-email').value;
        const status = document.getElementById('forgot-status');
        const btn = forgotForm.querySelector('button');

        btn.disabled = true;
        btn.textContent = i18n.sending || 'Sending...';
        status.textContent = '';
        status.className = '';

        try {
          const res = await fetch('/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: new URLSearchParams({ email })
          });
          const data = await res.json();
          if (data.success) {
            status.textContent = data.msg || 'Success! Check your email.';
            status.className = 'flash-success';
            forgotForm.reset();
          } else {
            status.textContent = data.msg || 'Error sending link.';
            status.className = 'flash-error';
          }
        } catch (err) {
          status.textContent = 'Network error.';
          status.className = 'flash-error';
        } finally {
          btn.disabled = false;
          btn.textContent = 'Send Reset Link';
        }
      });
    }

    // Reset Password Submit
    const resetForm = document.getElementById('reset-password-form');
    if (resetForm) {
      const resetToLogin = document.getElementById('reset-to-login');
      resetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = document.getElementById('reset-token').value;
        const password = document.getElementById('reset-password').value;
        const password_confirm = document.getElementById('reset-password-confirm').value;
        const status = document.getElementById('reset-status');
        const btn = resetForm.querySelector('button');

        if (password !== password_confirm) {
          status.className = 'flash-error';
          return;
        }

        if (password.length < 20) {
          status.textContent = 'Password is too short (minimum 20 characters).';
          status.className = 'flash-error';
          return;
        }

        btn.disabled = true;
        btn.textContent = i18n.updating || 'Updating...';
        status.textContent = '';
        status.className = '';

        try {
          const res = await fetch('/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: new URLSearchParams({ token, password, password_confirm })
          });
          const data = await res.json();
          if (data.success) {
            status.textContent = data.msg || 'Password updated successfully!';
            status.className = 'flash-success';
            resetForm.reset();
            btn.style.display = 'none';
            if (resetToLogin) resetToLogin.style.display = 'inline-block';
          } else {
            status.textContent = data.msg || 'Error resetting password.';
            status.className = 'flash-error';
          }
        } catch (err) {
          status.textContent = 'Network error.';
          status.className = 'flash-error';
        } finally {
          btn.disabled = false;
          btn.textContent = 'Update Password';
        }
      });

      if (resetToLogin) {
        resetToLogin.addEventListener('click', (e) => {
          e.preventDefault();
          switchModalView('login');
          resetToLogin.style.display = 'none';
          resetForm.querySelector('button').style.display = 'inline-block';
        });
      }
    }
  }



  if (registerBtn && registerModal) {
    registerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(registerModal);
    });

    if (registerClose) registerClose.addEventListener('click', () => closeModal(registerModal));

    registerModal.addEventListener('click', (e) => {
      if (e.target === registerModal) closeModal(registerModal);
    });

    // Register Form AJAX
    const registerForm = document.getElementById('modal-register-form');
    if (registerForm) {
      registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(registerForm);
        const params = new URLSearchParams(formData);
        const status = document.getElementById('register-status');
        const btn = registerForm.querySelector('button');

        const password = formData.get('password');
        const password_confirm = formData.get('password_confirm');

        if (password && password.length < 20) {
          if (status) {
            status.textContent = 'Password is too short (minimum 20 characters).';
            status.className = 'flash-error';
          }
          return;
        }

        if (password !== password_confirm) {
          if (status) {
            status.textContent = 'Passwords do not match.';
            status.className = 'flash-error';
          }
          return;
        }

        btn.disabled = true;
        btn.textContent = i18n.registering || 'Registering...';
        if (status) {
          status.textContent = '';
          status.className = '';
        }

        try {
          const res = await fetch('/register', {
            method: 'POST',
            headers: {
              'X-Requested-With': 'XMLHttpRequest',
              'Accept': 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params
          });

          const json = await res.json();
          if (json.success) {
            if (status) {
              status.textContent = json.msg || 'Registration successful! You can now login.';
              status.className = 'flash-success';
            }
            registerForm.reset();
            // Optional: switch to login view after a delay
            setTimeout(() => {
              const loginToRegister = document.getElementById('login-to-register');
              if (loginToRegister) {
                // If we are in register modal, we might want to close it and open login?
                // But registration modal is separate in HTML. 
                closeModal(registerModal);
                openModal(loginModal, 'login');
              }
            }, 3000);
          } else {
            if (status) {
              status.textContent = json.msg || 'Registration failed.';
              status.className = 'flash-error';
            }
          }
        } catch (err) {
          console.error('Registration error:', err);
          if (status) {
            status.textContent = 'Network error.';
            status.className = 'flash-error';
          }
        } finally {
          btn.disabled = false;
          btn.textContent = 'Create Account';
        }
      });
    }
    
    // Switch to register from login
    
    // Switch to register from login
    const loginToRegister = document.getElementById('login-to-register');
    if (loginToRegister) {
      loginToRegister.addEventListener('click', (e) => {
        e.preventDefault();
        closeModal(loginModal);
        openModal(registerModal);
      });
    }

    // Switch to login from register
    const registerToLogin = document.getElementById('register-to-login');
    if (registerToLogin) {
      registerToLogin.addEventListener('click', (e) => {
        e.preventDefault();
        closeModal(registerModal);
        openModal(loginModal, 'login');
      });
    }
  }

  // Shortcuts Modal Logic
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const shortcutsClose = document.getElementById('shortcuts-modal-close');
  
  if (shortcutsModal) {
    if (shortcutsClose) {
      shortcutsClose.addEventListener('click', () => closeModal(shortcutsModal));
    }
    shortcutsModal.addEventListener('click', (e) => {
      if (e.target === shortcutsModal) closeModal(shortcutsModal);
    });

    // Delegate help button click (since it's in a partial)
    document.addEventListener('click', (e) => {
      if (e.target.id === 'help-button') {
        openModal(shortcutsModal);
      }
    });
  }

  // Handle ESC key to close any modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal(loginModal);
      closeModal(registerModal);
      closeModal(shortcutsModal);
      const infoModal = document.getElementById('info-modal');
      if (infoModal) closeModal(infoModal);
    }
  });

  var background = (window.f0ckSession && window.f0ckSession.show_background !== undefined) 
                   ? window.f0ckSession.show_background 
                   : (localStorage.getItem('background') !== 'false');

  window.toggleBackground = async () => {
    background = !background;
    localStorage.setItem('background', background ? 'true' : 'false');
    window.initBackground();
    
    // Update videoplayer toggle buttons if they exist
    document.querySelectorAll("#togglebg").forEach(el => {
        el.classList.toggle('active', background);
    });

    // Update session preference and persist if logged in
    if (window.f0ckSession) {
        window.f0ckSession.show_background = background;
        try {
            await fetch('/api/v2/settings/background', {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': window.f0ckSession.csrf_token 
                },
                body: JSON.stringify({ show_background: background })
            });
        } catch (err) {
            console.error('Failed to sync background preference:', err);
        }
    }
  };
  
  // Initialize autoplay preference
  if (localStorage.getItem('autoplay') == undefined) {
    localStorage.setItem('autoplay', 'false');
  }
  var autoplay = localStorage.getItem('autoplay') === 'true';

  window.toggleAutoplay = () => {
    autoplay = !autoplay;
    localStorage.setItem('autoplay', autoplay.toString());
    
    // Update videoplayer toggle buttons if they exist
    document.querySelectorAll("#toggleautoplay").forEach(el => {
        el.classList.toggle('active', autoplay);
    });
  };
  let bgRafId = null;
  let lastBgElem = null;


  // Apply initial visual state
  var initialCanvas = document.getElementById('bg');
  if (initialCanvas) {
    // No background on SWF pages
    if (document.getElementById('ruffle-container')) {
      initialCanvas.classList.add('fader-out');
      initialCanvas.classList.remove('fader-in');
    } else if (background) {
      initialCanvas.classList.add('fader-in');
      initialCanvas.classList.remove('fader-out');
    } else {
      initialCanvas.classList.add('fader-out');
      initialCanvas.classList.remove('fader-in');
    }
  }


  const setupMedia = () => {
    const elem = document.querySelector("#my-video") || document.querySelector("audio#my-video");
    if (elem) {
      video = new v0ck(elem);
    } else {
      video = null;
    }
  };

  // Initial Load
  document.addEventListener('DOMContentLoaded', () => {
    setupMedia();
  });

  // Export init function for dynamic calls
  window.initBackground = () => {
    // Media selection priority
    let elem = document.querySelector("#my-video");
    if (!elem) {
        const rp = document.querySelector('ruffle-player');
        if (rp) {
            elem = rp.shadowRoot ? rp.shadowRoot.querySelector('canvas') : null;
            if (!elem) {
                // If we have a player but no canvas yet, it's likely still initializing.
                // Re-init background in a moment.
                setTimeout(window.initBackground, 200);
                return;
            }
        }
    }
    if (elem && elem.tagName === 'AUDIO') {
        elem = document.querySelector("#f0ck-audio-cover") || elem;
    }
    if (!elem || (elem.tagName === 'AUDIO')) {
        elem = document.querySelector("#f0ck-image") || elem;
    }

    const canvas = document.getElementById('bg');

    if (elem) {
      if (canvas) {
        // Restore visual state on re-init
        if (background) {
          canvas._bgFadingOut = false;
          // For images: defer fader-in until drawOnce draws the thumbnail.
          // For video/audio: fader-in immediately.
          if (elem.tagName !== 'IMG') {
            canvas.classList.add('fader-in');
            canvas.classList.remove('fader-out', 'fast-fade');
          }
        } else {
          // Don't clear the canvas here — let the existing content fade out.
          canvas._bgFadingOut = true;
          canvas.classList.add('fader-out');
          canvas.classList.remove('fader-in', 'fast-fade');
          const stopOnFadeEnd = (ev) => {
            if (ev.propertyName === 'opacity') {
              canvas._bgFadingOut = false;
              canvas.removeEventListener('transitionend', stopOnFadeEnd);
            }
          };
          canvas.addEventListener('transitionend', stopOnFadeEnd);
          return; // nothing more to do — let CSS do the fade
        }

        // Only reset canvas dimensions when turning ON (avoids clearing pixels mid-fade-out).
        const context = canvas.getContext('2d');
        const cw = canvas.width = canvas.clientWidth | 0;
        const ch = canvas.height = canvas.clientHeight | 0;

        const drawOnce = () => {
            if (!background || !context) return;

            // Always use the thumbnail first for instant backdrop — thumbnails are tiny,
            // often browser-cached from grid view, and give us a frame-0 equivalent for GIFs too.
            // Extract item ID from URL for thumbnail path.
            const itemId = window.getCurrentItemId();

            const showCanvas = () => {
                canvas.classList.remove('fader-out', 'fast-fade');
                canvas.classList.add('fader-in');
            };

            const isDrawable = elem && elem.tagName === 'IMG';

            if (itemId) {
                // Step 1: draw thumbnail immediately for instant background
                const thumb = new Image();
                thumb.onload = () => {
                    try { context.drawImage(thumb, 0, 0, cw, ch); } catch (e) {}
                    showCanvas();
                    // Step 2: upgrade with full image when it's ready (skip for AUDIO elements)
                    if (isDrawable) {
                        if (elem.complete) {
                            try { context.drawImage(elem, 0, 0, cw, ch); } catch (e) {}
                        } else {
                            elem.onload = () => {
                                try { context.drawImage(elem, 0, 0, cw, ch); } catch (e) {}
                            };
                        }
                    }
                };
                thumb.onerror = () => {
                    // Thumbnail failed — fall back to waiting for the main image (skip for AUDIO)
                    if (isDrawable) {
                        if (elem.complete) {
                            try { context.drawImage(elem, 0, 0, cw, ch); } catch (e) {}
                            showCanvas();
                        } else {
                            elem.onload = () => {
                                try { context.drawImage(elem, 0, 0, cw, ch); } catch (e) {}
                                showCanvas();
                            };
                        }
                    }
                    // For audio-only items with no thumbnail, canvas stays blank (nothing to draw)
                };
                let newSrc = `/t/${itemId}.webp`;
                if (window.applyThumbCacheBust) newSrc = window.applyThumbCacheBust(newSrc);
                thumb.src = newSrc;
            } else if (isDrawable) {
                // No item ID — fall back to waiting for the main image
                if (elem.complete) {
                    try { context.drawImage(elem, 0, 0, cw, ch); } catch (e) {}
                    showCanvas();
                } else {
                    elem.onload = () => {
                        try { context.drawImage(elem, 0, 0, cw, ch); } catch (e) {}
                        showCanvas();
                    };
                }
            }
        };

        const animationLoop = () => {
          if (!elem || elem.tagName === 'AUDIO' || elem.paused || elem.ended || (!background && !canvas._bgFadingOut)) {
            bgRafId = null;
            return;
          }
          try {
              context.drawImage(elem, 0, 0, cw, ch);
          } catch (e) {
              bgRafId = null;
              return;
          }
          bgRafId = window.requestAnimFrame(animationLoop);
        };

        // Singleton: Ensure only one listener and one loop per element
        if (lastBgElem !== elem) {
          if (bgRafId) window.cancelAnimFrame(bgRafId);
          lastBgElem = elem;

          if (elem.tagName === 'VIDEO') {
              elem.addEventListener('play', () => {
                 if (bgRafId) window.cancelAnimFrame(bgRafId);
                 if (background) animationLoop();
              });
          } else if (elem.tagName === 'CANVAS') {
              // Ruffle canvas: start loop immediately
              if (bgRafId) window.cancelAnimFrame(bgRafId);
              if (background) animationLoop();
          }
        }

        if (elem.tagName === 'VIDEO') {
            if (!elem.paused && background) {
              if (bgRafId) window.cancelAnimFrame(bgRafId);
              animationLoop();
            }
        } else if (elem.tagName === 'CANVAS') {
            if (background) {
              if (bgRafId) window.cancelAnimFrame(bgRafId);
              animationLoop();
            }
        } else if (elem.tagName === 'IMG' || elem.tagName === 'AUDIO') {
            // IMG: draw from thumbnail. AUDIO: draw thumbnail from URL (no drawable elem, just background).
            drawOnce();
        }

      }
    } else if (canvas) {
      // No drawable element (e.g. YouTube iframe) — still handle canvas fade toggle
      if (background) {
        canvas._bgFadingOut = false;
        // Draw the item thumbnail if we have an item ID in the URL
        const itemId = window.getCurrentItemId();
        if (itemId) {
          const context = canvas.getContext('2d');
          const cw = canvas.width = canvas.clientWidth | 0;
          const ch = canvas.height = canvas.clientHeight | 0;
          const thumb = new Image();
          thumb.onload = () => {
            try { context.drawImage(thumb, 0, 0, cw, ch); } catch (e) {}
            canvas.classList.remove('fader-out', 'fast-fade');
            canvas.classList.add('fader-in');
          };
          thumb.src = `/t/${itemId}.webp`;
        } else {
          canvas.classList.remove('fader-out', 'fast-fade');
          canvas.classList.add('fader-in');
        }
      } else {
        canvas._bgFadingOut = true;
        canvas.classList.add('fader-out');
        canvas.classList.remove('fader-in', 'fast-fade');
        const stopOnFadeEnd = (ev) => {
          if (ev.propertyName === 'opacity') {
            canvas._bgFadingOut = false;
            canvas.removeEventListener('transitionend', stopOnFadeEnd);
          }
        };
        canvas.addEventListener('transitionend', stopOnFadeEnd);
      }
    }
  };


  window.initVisualizer = () => {
    const audioElement = document.querySelector("audio");
    if (audioElement) {
      // Cleanup existing visualizer
      if (visualizerRafId) window.cancelAnimFrame(visualizerRafId);
      const existingCanvas = document.querySelector(".v0ck > canvas.audio-visualizer");
      if (existingCanvas) existingCanvas.remove();

      const canvas = document.createElement("canvas");
      canvas.className = "audio-visualizer";
      const ctx = canvas.getContext("2d");
      canvas.width = 1920;
      canvas.height = 1080;

      setTimeout(() => {
        const v0ckContainer = document.querySelector(".v0ck");
        if (v0ckContainer) v0ckContainer.insertAdjacentElement("afterbegin", canvas);
      }, 400);

      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;

      try {
        const source = audioCtx.createMediaElementSource(audioElement);
        source.connect(analyser);
        source.connect(audioCtx.destination);
      } catch (e) {
        console.warn("Visualizer Source creation failed (already connected?):", e);
      }

      let data = new Uint8Array(analyser.frequencyBinCount);
      
      const draw = (data) => {
        data = [...data];
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--accent") || "#9f0";
        data.forEach((value, i) => {
          const percent = value / 256;
          const height = (canvas.height * percent / 2) - 40;
          const offset = canvas.height - height - 1;
          const barWidth = canvas.width / analyser.frequencyBinCount;
          ctx.fillRect(i * barWidth, offset, barWidth, height);
        });
      };

      const loopingFunction = () => {
        visualizerRafId = requestAnimationFrame(loopingFunction);
        analyser.getByteFrequencyData(data);
        draw(data);
      };

      visualizerRafId = requestAnimationFrame(loopingFunction);

      audioElement.onplay = () => {
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
      };
    }
  };


  // Content Warning Logic
  const cwModal = document.getElementById('content-warning-modal');
  if (cwModal) {
    if (!localStorage.getItem('content_warning_accepted')) {
      cwModal.style.display = 'flex';
      document.body.classList.add('modal-open');
    }

    const acceptBtn = document.getElementById('cw-accept');
    const declineBtn = document.getElementById('cw-decline');

    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => {
        localStorage.setItem('content_warning_accepted', 'true');
        cwModal.style.display = 'none';
        document.body.classList.remove('modal-open');
      });
    }

    if (declineBtn) {
      declineBtn.addEventListener('click', () => {
        window.location.href = 'https://duckduckgo.com';
      });
    }
  }

  // Initial call
  window.initBackground();
  window.initVisualizer();

  // Ruffle / SWF support — only register when the site has SWF enabled.
  // The static ruffle.js <script> tag is injected by the server only on SWF item pages.
  // This listener handles AJAX navigation TO a SWF item from any other page.
  if (window.f0ckSession?.enable_swf) {
    // Global Ruffle configuration
    window.RufflePlayer = window.RufflePlayer || {};
    window.RuffleConfig = window.RuffleConfig || {};
    window.RufflePlayer.config = window.RuffleConfig = {
        "pageVisibility": window.f0ckSession?.ruffle_background === false,
        "backgroundExecution": "Unthrottled",
        "autoplay": "on",
        "unmuteOverlay": "hidden",
        "letterbox": "on",
        "warnOnUnsupportedContent": false,
        "contextMenu": "on"
      };

    let ruffleKeepAliveApplied = false;
    let activeRuffleGesture = null;

    // Window-level listeners for desktop mouse gestures (singleton)
    window.addEventListener('mousemove', e => {
        if (activeRuffleGesture) {
            activeRuffleGesture.handleMove(e.clientX, e.clientY, e);
        }
    });
    window.addEventListener('mouseup', e => {
        if (activeRuffleGesture) {
            activeRuffleGesture.handleEnd();
            activeRuffleGesture = null;
        }
    });

    const applyRuffleKeepAlive = () => {
      if (ruffleKeepAliveApplied) return;
      
      window.f0ckDebug("[Ruffle] Registering background keep-alive patches (Browser Level)...");
      
      try {
        const docProto = Object.getPrototypeOf(document);
        const visProp = Object.getOwnPropertyDescriptor(docProto, 'visibilityState') || Object.getOwnPropertyDescriptor(document, 'visibilityState');
        const hiddenProp = Object.getOwnPropertyDescriptor(docProto, 'hidden') || Object.getOwnPropertyDescriptor(document, 'hidden');

        if (visProp && visProp.get) {
          const originalVisGet = visProp.get;
          Object.defineProperty(document, 'visibilityState', {
            get: () => {
              if (window.f0ckSession?.ruffle_background !== false && document.getElementById('ruffle-container')) {
                return 'visible';
              }
              return originalVisGet.call(document);
            },
            configurable: true
          });
        }

        if (hiddenProp && hiddenProp.get) {
          const originalHiddenGet = hiddenProp.get;
          Object.defineProperty(document, 'hidden', {
            get: () => {
              if (window.f0ckSession?.ruffle_background !== false && document.getElementById('ruffle-container')) {
                return false;
              }
              return originalHiddenGet.call(document);
            },
            configurable: true
          });
        }

        document.addEventListener('visibilitychange', (e) => {
          if (window.f0ckSession?.ruffle_background !== false && document.getElementById('ruffle-container')) {
            e.stopImmediatePropagation();
          }
        }, true);

        window.addEventListener('blur', (e) => {
          if (window.f0ckSession?.ruffle_background !== false && document.getElementById('ruffle-container')) {
            e.stopImmediatePropagation();
          }
        }, true);

      } catch (e) {
        console.error("[Ruffle] Failed to apply keep-alive patches:", e);
      }

      ruffleKeepAliveApplied = true;
    };

    function initRuffle() {
      const container = document.getElementById('ruffle-container');
      if (!container || container.querySelector('ruffle-player') || container.querySelector('ruffle-object')) return;

      // Ensure v0ck.css is loaded for HUD styles
      if (!document.querySelector('link[href^="/s/css/v0ck.css"]')) {
          document.head.insertAdjacentHTML("beforeend", `<link rel="stylesheet" href="/s/css/v0ck.css">`);
      }

      applyRuffleKeepAlive();

      // Update config with latest session preferences just before creation
      if (window.RufflePlayer) {
        window.RufflePlayer.config = window.RuffleConfig = {
          ...window.RuffleConfig,
          "pageVisibility": window.f0ckSession?.ruffle_background === false,
          "backgroundExecution": window.f0ckSession?.ruffle_background === false ? undefined : "Unthrottled" 
        };
      }

      function createPlayer() {
        if (!window.RufflePlayer) return;
        if (typeof window.RufflePlayer.newest !== 'function') return; // WASM still initializing
        const ruffle = window.RufflePlayer.newest();
        if (!ruffle) return;
        const player = ruffle.createPlayer();
        player.style.width = '100%';
        player.style.height = '100%';

        container.appendChild(player);
        window.initBackground();

        // Apply volume after the SWF has loaded to prevent it from being overwritten
        player.addEventListener('loadedmetadata', () => {
            const sessionVolume = window.f0ckSession?.ruffle_volume;
            const savedVolume = localStorage.getItem('volume');
            
            if (sessionVolume !== undefined && sessionVolume !== null) {
                player.volume = parseFloat(sessionVolume);
            } else if (savedVolume !== null) {
                player.volume = parseFloat(savedVolume);
            } else {
                player.volume = 0.5;
            }
        });

        player.load(container.dataset.swf).catch(err => {
          console.error('[Ruffle] Failed to load SWF:', err);
          container.innerHTML = '<div style="color:#e040fb;text-align:center;padding:2em;">⚡ SWF playback failed</div>';
        });

        // --- Gesture Support (Mobile & Desktop) ---
        // Inject HUD, Overlay, and Danmaku toggle
        const existingHUD = container.querySelector('.v0ck_hud');
        if (!existingHUD) {
            // Determine initial danmaku state
            const dmConfigDefault = (window.f0ckSession && window.f0ckSession.enable_danmaku !== undefined)
                ? !!window.f0ckSession.enable_danmaku : true;
            const dmSaved = localStorage.getItem('danmaku');
            const dmOn = (dmSaved !== null) ? (dmSaved !== 'false') : dmConfigDefault;

            container.insertAdjacentHTML('beforeend', `
                <div class="v0ck_hud v0ck_hidden" style="z-index: 10000;">
                    <svg viewBox="0 0 24 24"><use class="v0ck_hud_icon" href="/s/img/v0ck.svg#volume_full"></use></svg>
                    <div class="v0ck_hud_bar_container">
                        <div class="v0ck_hud_bar"></div>
                    </div>
                </div>
                <div class="ruffle-gesture-overlay"></div>
                <button class="ruffle-danmaku-toggle${dmOn ? ' active' : ''}" title="Toggle Danmaku">
                    <i class="fa-solid fa-bars-staggered"></i>
                </button>
            `);

            // Wire up danmaku toggle
            const dmBtn = container.querySelector('.ruffle-danmaku-toggle');
            if (dmBtn) {
                dmBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (window.danmakuInstance) {
                        window.danmakuInstance.toggle();
                        const on = window.danmakuInstance.isEnabled();
                        dmBtn.classList.toggle('active', on);
                        localStorage.setItem('danmaku', on ? 'true' : 'false');
                        if (window.flashMessage) window.flashMessage(on ? 'Danmaku ON' : 'Danmaku OFF', 1800);
                    } else {
                        dmBtn.classList.toggle('active');
                        const newVal = dmBtn.classList.contains('active');
                        localStorage.setItem('danmaku', newVal ? 'true' : 'false');
                        if (window.flashMessage) window.flashMessage(newVal ? 'Danmaku ON' : 'Danmaku OFF', 1800);
                    }
                });

                // Mobile: show button briefly on tap, then auto-hide
                const isMobileDevice = /Mobi/i.test(navigator.userAgent) || ('ontouchstart' in window);
                if (isMobileDevice) {
                    let dmHideTimer = null;
                    const showDmBtn = () => {
                        dmBtn.style.opacity = '1';
                        dmBtn.style.pointerEvents = 'auto';
                        clearTimeout(dmHideTimer);
                        dmHideTimer = setTimeout(() => {
                            dmBtn.style.opacity = '';
                            dmBtn.style.pointerEvents = '';
                        }, 3000);
                    };
                    container.addEventListener('touchstart', showDmBtn, { passive: true });
                    // Keep visible while interacting with the button itself
                    dmBtn.addEventListener('touchstart', (e) => {
                        e.stopPropagation();
                        showDmBtn();
                    }, { passive: true });
                }
            }
        }

        const hud = container.querySelector('.v0ck_hud');
        const hudBar = hud.querySelector('.v0ck_hud_bar');
        const hudIcon = hud.querySelector('.v0ck_hud_icon');
        let startX, startY, startVol, isRightSide, gestureType;
        let hudTimer;
        let isDragging = false;

        const showHUD = (vol) => {
            if (!hud) return;
            hud.classList.remove('v0ck_hidden');
            hudBar.style.width = `${vol * 100}%`;
            let icon = 'volume_full';
            if (vol === 0) icon = 'volume_mute';
            else if (vol <= 0.5) icon = 'volume_mid';
            hudIcon.setAttribute('href', `/s/img/v0ck.svg#${icon}`);
            clearTimeout(hudTimer);
            hudTimer = setTimeout(() => hud && hud.classList.add('v0ck_hidden'), 1000);
        };

        const handleStart = (clientX, clientY) => {
            const rect = container.getBoundingClientRect();
            const x = clientX - rect.left;
            isRightSide = x > rect.width / 2;
            gestureType = 'none';
            if (isRightSide) {
                startX = clientX;
                startY = clientY;
                startVol = player.volume;
                isDragging = true;
                return true;
            }
            return false;
        };

        const handleMove = (clientX, clientY, e) => {
            if (!isDragging || !isRightSide || gestureType === 'other') return;
            const dx = Math.abs(clientX - startX);
            const dy = Math.abs(clientY - startY);

            if (gestureType === 'none') {
                if (dy > dx && dy > 5) {
                    gestureType = 'volume';
                } else if (dx > dy && dx > 5) {
                    gestureType = 'other';
                    return;
                } else {
                    return;
                }
            }

            if (gestureType === 'volume' && player) {
                const deltaY = startY - clientY;
                const sensitivity = 200;
                let newVol = startVol + (deltaY / sensitivity);
                newVol = Math.max(0, Math.min(1, newVol));
                player.volume = newVol;
                localStorage.setItem('volume', newVol);
                if (window.f0ckSession) window.f0ckSession.ruffle_volume = newVol;
                showHUD(newVol);
                if (e && e.cancelable) e.preventDefault();
            }
        };

        const handleEnd = () => {
            isDragging = false;
        };

        // Touch listeners (attached to container for mobile)
        container.addEventListener('touchstart', e => handleStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
        container.addEventListener('touchmove', e => handleMove(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
        container.addEventListener('touchend', handleEnd, { passive: true });
 
        // Mouse gesture listeners attached to overlay to bypass Ruffle capture on desktop
        const overlay = container.querySelector('.ruffle-gesture-overlay');
        if (overlay) {
            overlay.addEventListener('mousedown', e => {
                if (e.button !== 0) return;
                if (handleStart(e.clientX, e.clientY)) {
                    e.preventDefault(); 
                    activeRuffleGesture = { handleMove, handleEnd };
                }
            });
        }
      }

      const tryCreatePlayer = () => {
        // createPlayer() has its own internal checks (RufflePlayer exists, newest() is a function, returns value)
        createPlayer();
        return !!container.querySelector('ruffle-player, ruffle-object');
      };

      const pollForPlayer = () => {
        const wait = setInterval(() => {
          if (tryCreatePlayer()) {
            clearInterval(wait);
          }
        }, 100);
        setTimeout(() => clearInterval(wait), 10000);
      };

      // Check if ruffle.js has actually been loaded (not just our pre-config stub)
      const ruffleScriptLoaded = !!document.querySelector('script[src="/s/ruffle/ruffle.js"]');

      if (ruffleScriptLoaded) {
        // Script is in the DOM — WASM may still be initializing, poll for player
        if (!tryCreatePlayer()) {
          pollForPlayer();
        }
      } else {
        // Inject ruffle.js dynamically (AJAX navigation from a non-flash page)
        const s = document.createElement('script');
        s.src = '/s/ruffle/ruffle.js';
        s.onload = () => pollForPlayer();
        document.head.appendChild(s);
      }

    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initRuffle, { once: true });
    } else {
      initRuffle();
    }
    document.addEventListener('f0ck:contentLoaded', initRuffle);

    // Synchronize volume across tabs (e.g. if changed in a v0ck player elsewhere)
    window.addEventListener('storage', (e) => {
      if (e.key === 'volume' && e.newValue !== null) {
        const player = document.querySelector('ruffle-player');
        if (player) {
          player.volume = parseFloat(e.newValue);
        }
      }
    });

    window.addEventListener('blur', (e) => {
      if (document.getElementById('ruffle-container')) {
        e.stopImmediatePropagation();
      }
    }, true);
  }

  window.syncNavbarHeight = () => {
    const nav = document.querySelector('.navbar');
    if (nav) document.documentElement.style.setProperty('--navbar-h', nav.offsetHeight + 'px');
  };
  window.syncNavbarHeight();
  window.addEventListener('resize', window.syncNavbarHeight);
  const _navEl = document.querySelector('.navbar');
  if (_navEl && window.ResizeObserver) {
    new ResizeObserver(window.syncNavbarHeight).observe(_navEl);
  }

  // Sidebar state init — apply persisted hidden/visible state on load
  window.initSidebarRightToggle = () => {
    // One-time migration: clear the old mobile-default-hidden value so existing
    // users see the sidebar again now that it defaults to visible everywhere
    if (!localStorage.getItem('sidebarRightMigrated')) {
      localStorage.removeItem('sidebarRightHidden');
      localStorage.setItem('sidebarRightMigrated', '1');
    }

    let hiddenValue = localStorage.getItem('sidebarRightHidden');
    let hidden;
    if (hiddenValue === null) {
      hidden = false; // Default to visible on all devices
      localStorage.setItem('sidebarRightHidden', hidden);
    } else {
      hidden = hiddenValue === 'true';
    }
    document.body.classList.toggle('sidebar-right-hidden', hidden);
  };
  window.initSidebarRightToggle();

  const loadPageAjax = async (url, replace = true, options = {}) => {
    if (isNavigating) return;

    // Immediately restore scrollability and hide modals
    if (window.resetGlobalScrollState) window.resetGlobalScrollState();
    if (window.hideAllModals) window.hideAllModals();

    isNavigating = true;

    // ── Scroller-active cleanup ──────────────────────────────────────────────
    // When leaving the abyss scroller page, undo ALL the inline style overrides
    // that were applied so the main-site layout is fully restored.
    if (document.body.classList.contains('scroller-active')) {
      document.head.querySelectorAll('[data-pjax-abyss]').forEach(el => el.remove());
      document.body.classList.remove('scroller-active', 'gallery-open');

      // Restore body
      ['overflow', 'background', 'height'].forEach(p => document.body.style.removeProperty(p));

      // Restore navbar
      const _nav = document.querySelector('nav.navbar');
      if (_nav) _nav.style.removeProperty('display');

      // Restore sidebar
      const _sb = document.querySelector('.global-sidebar-right');
      if (_sb) _sb.style.removeProperty('display');

      // Restore sidebar drag zone (desktop edge hint)
      const _dz = document.getElementById('sidebar-drag-zone');
      if (_dz) _dz.style.removeProperty('display');

      // Restore pagewrapper
      const _pw = document.querySelector('.pagewrapper');
      if (_pw) ['height', 'padding', 'margin', 'overflow'].forEach(p => _pw.style.removeProperty(p));

      // Restore #main (element persists across PJAX, its inline styles must be cleared)
      const _m = document.getElementById('main');
      if (_m) ['height', 'overflow'].forEach(p => _m.style.removeProperty(p));

      // Stop all media
      document.querySelectorAll('video, audio').forEach(el => { try { el.pause(); el.removeAttribute('src'); el.load(); } catch {} });
      document.querySelectorAll('ruffle-player').forEach(el => { try { el.remove(); } catch {} });
    }

    // Immediately close image modal on any navigation
    if (window.closeImageModal) window.closeImageModal();

    // Auto-clear notification highlight if opening an item
    const itemIdMatch = url.match(/\/(\d+)(\?.*|#.*)?$/);
    if (itemIdMatch) {
      const itemId = itemIdMatch[1];
      document.querySelectorAll(`a.thumb.has-notif[href$="/${itemId}"]`).forEach(el => {
        el.classList.remove('has-notif');
      });
    }

    window.dispatchEvent(new Event('pjax:start'));

    const currentScroll = window.scrollY;

    // Immediately fade out the current main content to provide a clean slate for the next page
    if (main) {
        main.classList.add('grid-transition');
        main.classList.remove('show');
    }

    // Save scroll position for the current page before we leave it (only for new navigations)
    if (!options.skipPush) {
       const currentState = history.state || {};
       history.replaceState({ ...currentState, scroll: currentScroll }, document.title, window.location.href);
    }

    posts = document.querySelector('.posts');


    // Unified state management
    const urlObj = new URL(url, window.location.origin);
    const pathname = urlObj.pathname;

    const isUserHall = pathname.match(/\/user\/[^/?]+\/hall\/([^/?]+)/);
    const isUserHalls = pathname.match(/\/user\/[^/?]+\/halls\/?(?:$|\?)/);
    const isProfile = !isUserHall && !isUserHalls && pathname.match(/\/user\/([^/?]+)(?:$|\?|$)/) && !pathname.match(/\/user\/[^/]+\/(f0cks|favs|comments|hall|halls)/);
    const isUserF0cks = pathname.match(/\/user\/([^/?]+)\/f0cks/);
    const isUserFavs = pathname.match(/\/user\/([^/?]+)\/favs/);
    const isTags = pathname.match(/\/tags\/?(?:$|\?)/);
    const isComments = pathname.match(/\/user\/([^/?]+)\/comments\/?(?:$|\?)/);
    const isNotifs = pathname.match(/\/notifications\/?(?:$|\?)/);
    const isHall = pathname.match(/\/h\/([^/?]+)(?:$|\?)/);
    const isHalls = pathname.match(/\/halls\/?(?:$|\?)/);
    const isAdmin = !!pathname.match(/^\/admin/);
    const isMod = !!pathname.match(/^\/mod/);
    const isSettings = pathname.match(/\/settings\/?(?:$|\?)/);
    const isStatic = pathname.match(/\/(about|rules|terms|upload|subscriptions|stats|docs|discord|ranking|meme|memes)($|\/|\?)/);
    const isUpload = pathname.match(/\/upload\/?(?:$|\?)/);
    const parts = pathname.split('/').filter(Boolean);
    const isItem = !pathname.match(/\/p\//) && (
      pathname.match(/^\/\d+/) || 
      (parts.length >= 3 && (parts[0] === 'tag' || parts[0] === 'user' || parts[0] === 'h') && /^\d+$/.test(parts[parts.length - 1]))
    );
    const isMessages = !!pathname.match(/^\/messages(\/|$)/);
    const isAbyss    = !!pathname.match(/^\/abyss(\/|$|\?|#)/) || pathname === '/abyss';
    const isGrid = !isProfile && !isUserHall && !isUserHalls && !isHall && !isHalls && !isTags && !isComments && !isNotifs && !isItem && !isAdmin && !isMod && !isSettings && !isStatic && !isUpload && !isMessages && !isAbyss;

    if (isItem) {
       isNavigating = false;
       return loadItemAjax(url, replace, options);
    }


    // Check for cached grid (Index/Grid Only) - RESTORE EARLY to avoid pagination/layout destruction
    if (isGrid && options.skipPush) {
       const targetCacheKey = urlObj.pathname + urlObj.search;
       if (gridCacheMap.has(targetCacheKey)) {
          const cache = gridCacheMap.get(targetCacheKey);
          gridCacheMap.delete(targetCacheKey); // Consume cache

          stopMedia();

          // Instant fade out background canvas (from item view)
          const canvas = document.getElementById('bg');
          if (canvas) {
            canvas.style.transition = 'none'; // Disable transition
            canvas.style.opacity = '0';
            canvas.classList.remove('fader-in');
            canvas.classList.add('fader-out');

            // Clean up overrides after render
            requestAnimationFrame(() => {
               setTimeout(() => {
                  canvas.style.transition = '';
                  canvas.style.opacity = '';
               }, 50);
            });
          }

          // Restore DOM
          if (main) {
             main.innerHTML = ''; // Clear item view
             main.appendChild(cache.node);
             cache.node.style.display = ''; // Ensure visible
             cache.node.classList.remove('cached-grid'); // Cleanup
             main.className = '';

             // Clear layout-lock state now that we are restoring the grid
             document.body.classList.remove('legacy-view', 'layout-modern', 'layout-legacy');
             document.body.style.overflow = '';
             document.body.style.height = '';
             
             // Restore Pagination HTML
             const paginationWrapper = document.querySelector('.pagination-wrapper');
             if (paginationWrapper && cache.pagination) {
                paginationWrapper.innerHTML = cache.pagination;
             }
             
             // Re-attach Infinite Scroll Handler
             const restoredPosts = cache.node.querySelector('.posts');
             if (restoredPosts && restoredPosts._scrollHandler) {
                 window.addEventListener('scroll', restoredPosts._scrollHandler);
                 // Ensure loading state is reset just in case
                 if (restoredPosts._infiniteState) restoredPosts._infiniteState.loading = false;
             }
          }
          
          // Restore Scroll Position
          requestAnimationFrame(() => window.scrollTo(0, cache.scroll));
          
          // Update Document Title
          let titleSuffix = '';
          const urlParams = new URLSearchParams(window.location.search);
          const page = urlParams.get('p') || urlParams.get('page');
          if (page) titleSuffix = ` - page ${page}`;
          document.title = `${window.f0ckDomain}${titleSuffix}`;
          
          // Reset navigation state
          document.querySelectorAll('.pagination-container-fluid').forEach(el => el.style.display = ''); // Restore pagination visibility
           if (navbar) navbar.classList.remove("pbwork");
           window.updateVisitIndicators();
           window.initLazyLoading();
           if (window.initSidebarRightToggle) window.initSidebarRightToggle(); 
           if (window.syncNavbarHeight) window.syncNavbarHeight();
           // Sync has-notif highlights — on PWA there's no visibilitychange, so poll here
           window.NotificationSystemInstance?.pollDebounced?.();
           isNavigating = false;
           return; // SKIP FETCH
       }
    }


    // Handle transition from Item View or User Profile back to Grid View
    const isOnProfilePage = main && main.querySelector('.profile_head');
    const isOnItemView = main && main.querySelector('.container .content');
    const isOnTagsPage = main && main.querySelector('.tags-grid');
    const isOnSettingsPage = main && main.querySelector('.settings');
    const isOnNotifPage = main && main.querySelector('.notif-history-container');
    const isOnUploadPage = main && main.querySelector('.upload-container');

    const isListView = isGrid || isUserHall || isUserHalls || isHall || isHalls || isNotifs || isProfile || isTags || isComments || isUserF0cks || isUserFavs || isAdmin || isMod || isSettings || isStatic || isUpload;
    const isOnStructuralPage = main && (main.querySelector('.pagewrapper') || main.closest('.pagewrapper'));
    const isOnAdminPage = main && (main.querySelector('.container h1')?.innerText.match(/APPROVAL QUEUE/) || main.querySelector('.admin-container') || main.querySelector('.mod-container'));
    const isOnStaticPage = main && (main.querySelector('.static-page') || main.querySelector('.about-container'));

    if (isListView && (!posts || isOnProfilePage || isOnTagsPage || isOnSettingsPage || isOnNotifPage || isOnItemView || isOnAdminPage || isOnStaticPage || isOnUploadPage || isOnStructuralPage) && main) {



      main.className = ''; // Reset class

      // Clear legacy-view state (layout-lock) now that we are swapping to a list view
      document.body.classList.remove('legacy-view', 'layout-modern', 'layout-legacy');
      document.body.style.overflow = '';
      document.body.style.height = '';
      // Toggle button lives permanently in body via header.html — no removal needed
      stopMedia(); // Ensure media stops when leaving item view

      // Fade out background canvas for smooth transition to black
      const canvas = document.getElementById('bg');
      if (canvas) {
        canvas.classList.add('fast-fade');
        canvas.classList.remove('fader-in');
        canvas.classList.add('fader-out');
      }

      // Rescue existing pagination container before wiping main, so it never disappears from the DOM
      const existingPagContainer = main.querySelector('.pagination-container-fluid');

      // Clear entire main content and create fresh grid structure (with sidebar for index)
      const indexWrapper = document.createElement('div');
      indexWrapper.className = 'index-layout-wrapper';
      indexWrapper.innerHTML = '<div class="index-container"><div class="posts grid-transition"></div></div>';

      main.innerHTML = '';
      main.appendChild(indexWrapper);

      // Re-attach rescued pagination (preserves visibility state) or create a fresh hidden one
      if (existingPagContainer) {
        indexWrapper.appendChild(existingPagContainer);
      } else {
        indexWrapper.insertAdjacentHTML('beforeend',
          '<div class="pagination-container-fluid" style="display: none;">'
          + '<div class="pagination-wrapper bottom-pagination fixed-pagination"></div>'
          + '</div>');
      }

      posts = main.querySelector('.posts');
      replace = true; // Force replacement
    }

    const hash = new URL(url, window.location.origin).hash;

    // Show loading indicator
    if (navbar) navbar.classList.add("pbwork");

    if (replace && posts) {
      posts.classList.add('grid-transition');
      posts.classList.remove('show');
    }



    try {
      // ... same parameter extraction logic ...
      let page = 1;
      const pMatch = url.match(/\/p\/(\d+)/);
      if (pMatch) page = pMatch[1];

      let tag = null, user = null, mime = null, hall = null;
      const tagMatch = url.match(/\/tag\/([^/?]+)/);
      if (tagMatch) tag = decodeURIComponent(tagMatch[1]);

      const hallMatch = url.match(/\/h\/([^/?]+)/);
      if (hallMatch) hall = decodeURIComponent(hallMatch[1]);

      const userMatch = url.match(/\/user\/([^/]+)/);
      // Don't treat user-hall browse URLs as user filter — they have their own server-side route
      if (userMatch && !url.match(/\/user\/[^/]+\/(favs|f0cks|comments|hall|halls)/) && !isUserHall && !isUserHalls) {
        user = decodeURIComponent(userMatch[1]);
      }

      const favMatch = url.match(/\/user\/([^/]+)\/favs/);
      const f0cksMatch = url.match(/\/user\/([^/]+)\/f0cks/);

      let isFav = false;
      if (favMatch) {
        user = decodeURIComponent(favMatch[1]);
        isFav = true;
      } else if (f0cksMatch) {
        user = decodeURIComponent(f0cksMatch[1]);
      }

      const mimeMatch = url.match(/\/(image|audio|video)/);
      if (mimeMatch) mime = mimeMatch[1];

      let ajaxUrl = `/ajax/items/?page=${page}&mode=${window.activeMode}`;
      if (tag) ajaxUrl += `&tag=${encodeURIComponent(tag)}`;
      if (hall) ajaxUrl += `&hall=${encodeURIComponent(hall)}`;
      if (user) ajaxUrl += `&user=${encodeURIComponent(user)}`;
      if (isFav) ajaxUrl += `&fav=true`;
      if (mime) ajaxUrl += `&mime=${encodeURIComponent(mime)}`;

      const isRandom = document.cookie.includes('random_mode=1') || url.includes('random=1') || window.location.search.includes('random=1');
      if (isRandom) ajaxUrl += `&random=1`;
      ajaxUrl += `&_t=${Date.now()}`;
      const isStrict = window.f0ckSession?.strict_mode || (localStorage.getItem('search_strict') === 'true');
      if (isStrict || url.includes('strict=1') || window.location.search.includes('strict=1')) {
        ajaxUrl += (ajaxUrl.includes('?') ? '&' : '?') + 'strict=1';
      }

      const needsFullHtmlFetch = isProfile || isUserHall || isUserHalls || isTags || isHall || isHalls || isComments || isNotifs || isAdmin || isMod || isSettings || isStatic || isMessages || isAbyss;

      const fetchHeaders = { 'Credentials': 'include', 'Cache-Control': 'no-store' };
      if (!needsFullHtmlFetch) {
        fetchHeaders['X-Requested-With'] = 'XMLHttpRequest';
      }

      if (window.randomizeLogo) window.randomizeLogo();

      const response = await fetch(needsFullHtmlFetch ? url : ajaxUrl, {
        credentials: 'include',
        headers: fetchHeaders,
        cache: 'no-store'
      });

      if (needsFullHtmlFetch) {
        if (!main) {
          window.location.href = url;
          return;
        }

        // Fade out blurred background (set during item view) so it doesn't bleed into other pages
        const bgCanvas = document.getElementById('bg');
        if (bgCanvas) {
          bgCanvas.classList.add('fast-fade');
          bgCanvas.classList.remove('fader-in');
          bgCanvas.classList.add('fader-out');
        }

        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const incomingMain = doc.getElementById('main');

        // Detect if the response is a full page (with <html> and <body>) or a partial snippet
        const isFullPage = html.toLowerCase().includes('<body') || html.toLowerCase().includes('<html');

        if (incomingMain || !isFullPage) {
          // Sync HTML and Body state
          if (isFullPage && doc.documentElement) {
              // Full page: Sync attributes (CRITICAL for fullscreen and theme state)
              ['theme', 'res'].forEach(attr => {
                  const val = doc.documentElement.getAttribute(attr);
                  if (val !== null) document.documentElement.setAttribute(attr, val);
                  else document.documentElement.removeAttribute(attr);
              });

              // Sync body classes (CRITICAL for layout triggers)
              const persistClasses = ['sidebar-right-hidden', 'bg-active'];
              const currentlyActive = persistClasses.filter(c => document.body.classList.contains(c));
              
              document.body.className = doc.body.className;
              currentlyActive.forEach(c => document.body.classList.add(c));
          } else {
              // Partial: Reset to default shell state to prevent leakage
              document.documentElement.removeAttribute('res'); // Kill fullscreen
              
              // Ensure we keep a layout class but reset others
              document.body.classList.remove('item-layout-active', 'meme-layout-active'); // Kill known breakers
          }

          // Reset navbar to clean state
          const navbar = document.querySelector('nav.navbar');
          if (navbar) {
              navbar.classList.remove('scrolled', 'pbwork');
          }

          document.body.style.overflow = '';
          document.body.style.height = '';
          document.body.style.minHeight = '';

          window.f0ckDebug("[loadPageAjax] State synced for " + (isFullPage ? "full page" : "partial"));
          if (window.updateMimeLabel) window.updateMimeLabel();
        }

        if (incomingMain) {
          // Sync #main container class if it exists in response
          main.className = incomingMain.className || '';

          // Ensure main is ready for new content
          if (!main.classList.contains('grid-transition')) {
              main.classList.add('grid-transition');
              main.classList.remove('show');
          }

          // Sync classes carefully — preserve transition classes!
          const preserveClasses = ['grid-transition', 'show'];
          const currentPreserved = preserveClasses.filter(c => main.classList.contains(c));
          
          main.innerHTML = '';
          main.className = incomingMain.className || '';
          currentPreserved.forEach(c => main.classList.add(c));

          const loadedLinks = [];
          const head = document.head;

          // Collect hrefs of <link> tags that the incoming page needs so we can
          // remove previously-injected sheets that are NO LONGER needed.
          const incomingLinkHrefs = new Set();
          incomingMain.querySelectorAll('link[rel="stylesheet"]').forEach(l => {
              const href = l.getAttribute('href');
              if (href) incomingLinkHrefs.add(href.split('?')[0]); // ignore ?v= cache busters
          });
          // Also check direct children of the incoming main
          Array.from(incomingMain.children).forEach(child => {
              if (child.tagName === 'LINK' && child.rel === 'stylesheet') {
                  const href = child.getAttribute('href');
                  if (href) incomingLinkHrefs.add(href.split('?')[0]);
              }
          });

          // Remove any previously page-injected stylesheets not needed by the new page
          head.querySelectorAll('link[data-pjax-injected]').forEach(existing => {
              const bare = (existing.getAttribute('href') || '').split('?')[0];
              if (!incomingLinkHrefs.has(bare)) {
                  existing.remove();
              }
          });

          const waitLink = (link) => {
            return new Promise((resolve) => {
              link.onload = () => resolve();
              link.onerror = () => resolve(); // Resolve on error too to not block forever
              // Fallback for browsers that don't support onload on link
              setTimeout(resolve, 2000); 
            });
          };

          // Move children from incomingMain to main
          // IMPORTANT: Scripts moved from DOMParser are inert. We must clone them to execute.
          while (incomingMain.firstChild) {
            const child = incomingMain.firstChild;

            // SPECIAL CASE: Handle <link> tags specifically to prevent FOUC
            if (child.tagName === 'LINK' && child.rel === 'stylesheet') {
                const href = child.getAttribute('href');
                // Only inject if not already in head
                if (!head.querySelector(`link[href="${href}"]`)) {
                    const newLink = document.createElement('link');
                    Array.from(child.attributes).forEach(attr => newLink.setAttribute(attr.name, attr.value));
                    newLink.setAttribute('data-pjax-injected', '1'); // Mark for cleanup on future navigations
                    head.appendChild(newLink);
                    loadedLinks.push(waitLink(newLink));
                }
                child.remove(); // Don't add to #main
                continue;
            }

            main.appendChild(child);

            // Execute scripts
            if (child.tagName === 'SCRIPT') {
              const newScript = document.createElement('script');
              Array.from(child.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
              newScript.appendChild(document.createTextNode(child.innerHTML));
              child.parentNode.replaceChild(newScript, child);
            } else if (child.tagName === 'STYLE') {
              const newStyle = document.createElement('style');
              Array.from(child.attributes).forEach(attr => newStyle.setAttribute(attr.name, attr.value));
              newStyle.appendChild(document.createTextNode(child.innerHTML));
              child.parentNode.replaceChild(newStyle, child);
            } else if (child.querySelectorAll) {
              // Execute scripts inside child
              child.querySelectorAll('script').forEach(oldScript => {
                const newScript = document.createElement('script');
                Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
                newScript.appendChild(document.createTextNode(oldScript.innerHTML));
                oldScript.parentNode.replaceChild(newScript, oldScript);
              });
              // Execute styles inside child
              child.querySelectorAll('style').forEach(oldStyle => {
                const newStyle = document.createElement('style');
                Array.from(oldStyle.attributes).forEach(attr => newStyle.setAttribute(attr.name, attr.value));
                newStyle.appendChild(document.createTextNode(oldStyle.innerHTML));
                oldStyle.parentNode.replaceChild(newStyle, oldStyle);
              });
              // Collect nested links too (though discouraged)
              child.querySelectorAll('link[rel="stylesheet"]').forEach(oldLink => {
                const href = oldLink.getAttribute('href');
                if (!head.querySelector(`link[href="${href}"]`)) {
                    const newLink = document.createElement('link');
                    Array.from(oldLink.attributes).forEach(attr => newLink.setAttribute(attr.name, attr.value));
                    head.appendChild(newLink);
                    loadedLinks.push(waitLink(newLink));
                }
                oldLink.remove();
              });
            }
          }

          // Wait for all CSS to be ready before showing content
          if (loadedLinks.length > 0) {
              await Promise.all(loadedLinks);
          }

          // Small delay to ensure browser parsed the CSS and applied it
          requestAnimationFrame(() => {
              main.classList.add('grid-transition'); // Ensure it's there
              main.classList.add('show');
          });

          // ── Abyss PJAX: direct style takeover ──────────────────────────
          // Using injected CSS stylesheets loses to existing f0ckm.css rules due
          // to specificity, and height:100% on #main fails because .pagewrapper
          // has height:auto. Directly forcing inline styles is more reliable.
          if (isAbyss) {
            // Still inject scroller head styles (theming, snap, etc.)
            document.head.querySelectorAll('[data-pjax-abyss]').forEach(el => el.remove());
            doc.head.querySelectorAll('style').forEach(style => {
              const s = document.createElement('style');
              s.setAttribute('data-pjax-abyss', '1');
              s.textContent = style.textContent;
              document.head.appendChild(s);
            });
            document.body.classList.add('scroller-active');
            document.title = doc.title || document.title;

            // Direct element overrides—these win over any stylesheet, no specificity battles.
            document.body.style.overflow   = 'hidden';
            document.body.style.background = '#000';
            document.body.style.height     = '100dvh';

            const _nav = document.querySelector('nav.navbar');
            if (_nav) _nav.style.display = 'none';

            const _sb = document.querySelector('.global-sidebar-right');
            if (_sb) _sb.style.display = 'none';

            const _dz = document.getElementById('sidebar-drag-zone');
            if (_dz) _dz.style.display = 'none';

            const _pw = document.querySelector('.pagewrapper');
            if (_pw) {
              _pw.style.height   = '100dvh';
              _pw.style.padding  = '0';
              _pw.style.margin   = '0';
              _pw.style.overflow = 'hidden';
            }

            // #main must be full-screen so #scroller-feed { height:100% } resolves
            main.style.height   = '100dvh';
            main.style.overflow = 'hidden';
          }
        } else {
          console.warn("[loadPageAjax] DOMParser failed to find #main, falling back to window.location.refresh check");
          // Fallback if no #main found
          if (!replace) {
            window.location.href = url;
            return;
          }
          main.innerHTML = html;
        }

        // Sync pagination visibility and content across all layouts
        const incomingPagWrapper = doc.querySelector('.pagination-wrapper');
        
        if (incomingPagWrapper && incomingPagWrapper.innerHTML.trim().length > 10) {
            document.querySelectorAll('.pagination-wrapper').forEach(el => {
                el.innerHTML = incomingPagWrapper.innerHTML;
            });
            document.querySelectorAll('.pagination-container-fluid').forEach(el => {
                el.style.display = 'flex'; // Use flex explicitly
            });
        } else {
            // Hide pagination if not present in the incoming page
            document.querySelectorAll('.pagination-container-fluid').forEach(el => {
                el.style.display = 'none';
            });
        }

        // UPDATE HISTORY BEFORE INITIALIZING SCRIPTS
        if (!options.skipPush) {
          history.pushState({}, '', url);
        }

        // Sync sidebar and comments-list layout (Legacy View Only)
        if (document.body.classList.contains('legacy-view')) {
        }

        // Re-init infinite scroll if we just loaded a grid or profile or tags
        if (typeof reinitAllInfiniteScroll === 'function') {
          reinitAllInfiniteScroll();
        } else {
          main.querySelectorAll('.posts, .tags-grid, .subs-grid').forEach(p => initInfiniteScroll(p));
        }

        // Re-init user comments if applicable
        if (isComments) {
          const tryInit = (retries = 0) => {
            if (typeof window.initUserComments === 'function') {
              window.initUserComments();
            } else if (retries < 20) {
              setTimeout(() => tryInit(retries + 1), 50); // Wait 50ms * 20 = 1s max
            }
          };
          tryInit();
        }

        // SCROLL TO TOP ON EVERY NEW NAVIGATION
        if (!options.skipScroll) {
          window.scrollTo(0, 0);
        }

        // Re-init activity feed if applicable
        if (document.getElementById('activity-container')) {
          const tryInitActivity = (retries = 0) => {
            if (typeof window.initActivity === 'function') {
              window.initActivity();
            } else if (retries < 20) {
              setTimeout(() => tryInitActivity(retries + 1), 50);
            }
          };
          tryInitActivity();
        }

        // Re-init upload forms if applicable
        if (main.querySelector('.upload-form') && typeof window.autoInitUploadForms === 'function') {
          window.autoInitUploadForms();
        }

        // Re-init messages pages (inbox or conversation) after AJAX navigation
        if (document.getElementById('dm-inbox-list') || document.getElementById('dm-thread')) {
          const tryInitMessages = (retries = 0) => {
            if (typeof window.initMessagesPage === 'function') {
              window.initMessagesPage();
            } else if (retries < 20) {
              setTimeout(() => tryInitMessages(retries + 1), 50);
            }
          };
          tryInitMessages();
        }

        // Re-bind profile DM button after AJAX navigation to a user page
        if (document.getElementById('send-dm-btn') && window.DMSystem?.setupProfileDmBtn) {
          window.DMSystem.setupProfileDmBtn();
        }

        if (pathname.match(/\/notifications\/?(?:$|\?)/)) {
          document.title = `${window.f0ckDomain} - notifications`;

          // Highlight a specific notification if hash is present (#notif-123)
          const targetHash = urlObj.hash || window.location.hash;
          if (targetHash && targetHash.startsWith('#notif-')) {
            const notifId = targetHash.replace('#notif-', '');
            setTimeout(() => {
              const el = document.querySelector(`.notif-item[data-id="${notifId}"]`);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('notif-highlight');
                setTimeout(() => el.classList.remove('notif-highlight'), 2500);
              }
            }, 200);
          }
        }

        // Initial visibility set to none for special pages handled in finally block

        // Extract and populate pagination from loaded HTML if it contains pagination
        const loadedPagination = main.querySelector('.pagination');
        if (loadedPagination) {
          document.querySelectorAll('.pagination-wrapper').forEach(el => {
            el.innerHTML = loadedPagination.outerHTML;
          });
        }

        // Update Title from fetched document if available
        if (doc && doc.title) {
          document.title = doc.title;
        } else if (isProfile) {
          let username = isProfile[1];
          document.title = `${window.f0ckDomain} - user: ${username}`;
        } else if (isUserF0cks) {
          let username = isUserF0cks[1];
          document.title = `${window.f0ckDomain} - ${username}'s f0cks`;
        } else if (isUserFavs) {
          let username = isUserFavs[1];
          document.title = `${window.f0ckDomain} - ${username}'s favorites`;
        } else if (isTags) {
          document.title = `${window.f0ckDomain} - tags`;
        } else if (isGrid) {
          // Reconstruct title for standard grid
          let titleSuffix = '';
          if (tag) titleSuffix = ` - tag: ${tag}`;
          else if (user) titleSuffix = ` - user: ${user}`;
          else if (isHall) titleSuffix = ` - hall: ${isHall[1]}`;
          else if (mime) titleSuffix = ` - ${mime}s`;
          document.title = `${window.f0ckDomain}${titleSuffix}`;
        } else if (isStatic || isUpload) {
          // Fallback for static pages if doc.title failed
          const page = pathname.split('/').filter(Boolean).pop();
          document.title = `${window.f0ckDomain} - ${page}`;
        }

        window.updateVisitIndicators();
        window.initLazyLoading();

        // Notify extensions and re-init systems (e.g. CommentSystem)
        document.dispatchEvent(new Event('f0ck:contentLoaded'));
        if (window.initSidebarRightToggle) window.initSidebarRightToggle();

        // Instant jump to hash (e.g. #c123)
        if (hash) {
          setTimeout(() => {
            const target = document.querySelector(hash);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              if (hash.startsWith('#c')) target.classList.add('new-item-fade');
            }
          }, 500);
        }

        return;
      }

      const data = await response.json();

      if (data.success) {
    if (replace) {
          // Atomic replacement to prevent "jumping"
          posts.innerHTML = data.html;
          window.updateVisitIndicators();
          window.initLazyLoading();

          // Handle Scroll Position (Restore or Reset)
          if (options.skipPush && history.state && history.state.scroll !== undefined) {
             // Back/Forward Navigation: Restore saved scroll position
             requestAnimationFrame(() => window.scrollTo(0, history.state.scroll));
          } else if (replace) {
             // New Navigation: Reset to top
             window.scrollTo(0, 0);
          }

          // Trigger fade-in
          requestAnimationFrame(() => {
            posts.classList.add('show');
          });

          // Update header (h2) for tags/users
          const container = document.querySelector('.index-container');
          if (container && data.titleHtml !== undefined) {
            const oldH2 = container.querySelector('h2');
            if (oldH2) oldH2.remove();
            if (data.titleHtml) {
              posts.insertAdjacentHTML('beforebegin', data.titleHtml);
            }
          }

          // UPDATE STATE BEFORE INITIALIZING SCROLL
          // Update Document Title
          let titleSuffix = '';
          if (tag) titleSuffix = ` - tag: ${tag}`;
          else if (isFav && user) titleSuffix = ` - ${user}'s favorites`;
          else if (f0cksMatch && user) titleSuffix = ` - ${user}'s f0cks`;
          else if (user) titleSuffix = ` - user: ${user}`;
          else if (mime) titleSuffix = ` - ${mime}s`;
          document.title = `${window.f0ckDomain}${titleSuffix}`;

          // Update History
          if (!options.skipPush) {
            let pushUrl = url.replace(/[?&]strict=1/, '').replace(/[?&]$/, '');
            
            // If server returned a different page (clamped), sync URL
            if (data.currentPage !== undefined) {
              const hasP = pushUrl.match(/\/p\/\d+/);
              if (hasP) {
                pushUrl = pushUrl.replace(/\/p\/\d+/, `/p/${data.currentPage}`);
              } else if (data.currentPage > 1) {
                // Ensure we don't double slash if URL ends with /
                pushUrl = pushUrl.replace(/\/?$/, `/p/${data.currentPage}`);
              }
            }
            
            history.pushState({}, '', pushUrl);
          }

          // Update pagination (CRITICAL: Do this BEFORE initializing scroll so it captures fresh HTML)
          if (data.pagination) {
            document.querySelectorAll('.pagination-wrapper').forEach(el => el.innerHTML = data.pagination);
            document.querySelectorAll('.pagination-container-fluid').forEach(el => el.style.display = 'flex');
          } else {
            document.querySelectorAll('.pagination-wrapper').forEach(el => el.innerHTML = '');
            document.querySelectorAll('.pagination-container-fluid').forEach(el => el.style.display = 'none');
          }

          // Pass state to posts container for initInfiniteScroll
          if (data.hasMore !== undefined) {
            posts.dataset.hasMore = data.hasMore ? 'true' : 'false';
          }
          if (data.currentPage !== undefined) {
            posts.dataset.currentPage = data.currentPage;
          }

          // Initialize / Reset infinite scroll for the new content (Now with correct URL and Pagination)
          // Note: initInfiniteScroll handles cleanup of old state and scroll listeners
          if (typeof initInfiniteScroll === 'function') {
            initInfiniteScroll(posts);
          }
        } else {
          posts.insertAdjacentHTML('beforeend', data.html);
          if (data.pagination) {
            document.querySelectorAll('.pagination-wrapper').forEach(el => el.innerHTML = data.pagination);
          }
        }

        // Notify extensions and re-init systems (e.g. CommentSystem)
        document.dispatchEvent(new Event('f0ck:contentLoaded'));
        if (window.initSidebarRightToggle) window.initSidebarRightToggle();
        // Sync has-notif highlights after grid loads — handles PWA where visibilitychange doesn't fire
        window.NotificationSystemInstance?.pollDebounced?.();

        // Instant jump to hash (e.g. #c123)
        if (hash) {
          setTimeout(() => {
            const target = document.querySelector(hash);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              if (hash.startsWith('#c')) target.classList.add('new-item-fade');
            }
          }, 500);
        }
      } else {
        // Handle failure (e.g. no items found)
        if (replace && posts) {
          posts.innerHTML = '<div class="no-results">No f0cks found :(</div>';
          posts.classList.add('show');
          document.querySelectorAll('.pagination-wrapper').forEach(el => el.innerHTML = '');
        }
      }

    } catch (err) {
      console.error(err);
      window.location.href = url; // Fallback
    } finally {
      isNavigating = false;
      if (navbar) navbar.classList.remove("pbwork");
      if (window.updateStrictLinks && window.f0ckSession) window.updateStrictLinks(window.f0ckSession.strict_mode);
    }
  };

  let tt = false;
  const stimeout = 500;

  // Navbar scroll effect - make background black when scrolling
  if (navbar) {
    window.addEventListener('scroll', () => {
      const isScrolled = window.scrollY > 10;
      navbar.classList.toggle('scrolled', isScrolled);
    });
  }

  // Helper to immediately abort media downloads
  const stopMedia = () => {
    if (bgRafId) window.cancelAnimFrame(bgRafId);
    if (visualizerRafId) window.cancelAnimFrame(visualizerRafId);


    const media = document.querySelectorAll('video:not(#gchat-messages video), audio:not(#gchat-messages audio)');

    media.forEach(m => {
      try {
        m.pause();
        m.src = '';
        m.removeAttribute('src');
        m.preload = 'none'; // Prevent further buffering
        // m.load(); // Intentionally removed: calling load() with no src can fetch current page URL
        window.f0ckDebug("Media aborted:", m);
      } catch (e) { console.error("Error stopping media:", e); }
    });
  };

  /**
   * updateNavForMode(mode)
   * Re-fetches the current item with the new mode and directly patches
   * the href on #prev and #next elements. No DOM surgery — just href updates.
   */
  const updateNavForMode = async (mode) => {
    const pathSegments = window.location.pathname.split('/');
    const numericSegments = pathSegments.filter(s => /^\d+$/.test(s));
    if (numericSegments.length === 0) return;
    const itemid = numericSegments[numericSegments.length - 1];

    const params = new URLSearchParams();
    params.set('mode', mode);
    params.set('_t', Date.now());

    try {
      const fetchUrl = `/ajax/item/${itemid}?${params.toString()}`;
      window.f0ckDebug(`[updateNavForMode] mode=${mode} itemid=${itemid} → ${fetchUrl}`);
      const resp = await fetch(fetchUrl, { credentials: 'include' });
      if (!resp.ok) { console.warn('[updateNavForMode] bad response:', resp.status); return; }
      const data = await resp.json();
      if (!data?.html) { console.warn('[updateNavForMode] no html in response'); return; }

      const doc = new DOMParser().parseFromString(data.html, 'text/html');

      // Directly patch href on existing #prev / #next — most reliable approach
      const newPrev = doc.getElementById('prev');
      const newNext = doc.getElementById('next');
      const livePrev = document.getElementById('prev');
      const liveNext = document.getElementById('next');

      if (livePrev && newPrev) {
        const h = newPrev.getAttribute('href');
        livePrev.setAttribute('href', h);
        window.f0ckDebug(`[updateNavForMode] #prev → ${h}`);
      } else {
        console.warn(`[updateNavForMode] #prev missing: live=${!!livePrev} new=${!!newPrev}`);
      }
      if (liveNext && newNext) {
        const h = newNext.getAttribute('href');
        liveNext.setAttribute('href', h);
        window.f0ckDebug(`[updateNavForMode] #next → ${h}`);
      } else {
        console.warn(`[updateNavForMode] #next missing: live=${!!liveNext} new=${!!newNext}`);
      }

      // Also patch steuerung nav prev/next links by position
      const newSteuerung = doc.querySelector('.steuerung');
      const liveSteuerung = document.querySelector('.steuerung');
      if (newSteuerung && liveSteuerung) {
        liveSteuerung.replaceWith(newSteuerung.cloneNode(true));
      }
    } catch (e) {
      console.error('[updateNavForMode] error:', e);
    }
  };


  const loadItemAjax = async (url, inheritContext = true, options = {}) => {

    if (isNavigating) return;

    // Immediately restore scrollability and hide modals
    if (window.resetGlobalScrollState) window.resetGlobalScrollState();
    if (window.hideAllModals) window.hideAllModals();

    isNavigating = true;

    // ── Scroller-active cleanup (same as loadPageAjax) ───────────────────
    if (document.body.classList.contains('scroller-active')) {
      document.head.querySelectorAll('[data-pjax-abyss]').forEach(el => el.remove());
      document.body.classList.remove('scroller-active', 'gallery-open');
      ['overflow', 'background', 'height'].forEach(p => document.body.style.removeProperty(p));
      const _nav = document.querySelector('nav.navbar');
      if (_nav) _nav.style.removeProperty('display');
      const _sb = document.querySelector('.global-sidebar-right');
      if (_sb) _sb.style.removeProperty('display');
      const _dz = document.getElementById('sidebar-drag-zone');
      if (_dz) _dz.style.removeProperty('display');
      const _pw = document.querySelector('.pagewrapper');
      if (_pw) ['height', 'padding', 'margin', 'overflow'].forEach(p => _pw.style.removeProperty(p));
      const _m = document.getElementById('main');
      if (_m) ['height', 'overflow'].forEach(p => _m.style.removeProperty(p));
      // Stop all media
      document.querySelectorAll('video:not(#gchat-messages video), audio:not(#gchat-messages audio)').forEach(el => { try { el.pause(); el.removeAttribute('src'); el.load(); } catch {} });
      document.querySelectorAll('ruffle-player').forEach(el => { try { el.remove(); } catch {} });
    }

    // Dispatch pjax:start so navigation-aware listeners (e.g. metadata modal, image modal) can react
    if (!options.keepMedia) {
      window.dispatchEvent(new Event('pjax:start'));
    }

    const currentScroll = window.scrollY;

    // Save scroll position for current page (only for new navigations)
    if (!options.skipPush && !options.keepMedia) {
       const currentState = history.state || {};
       history.replaceState({ ...currentState, scroll: currentScroll }, document.title, window.location.href);
    }

    // Record current URL for session history before navigating away
    // Reverted to native-only

    if (!options.keepMedia) {
      stopMedia(); // Abort previous media immediately

      // Fade out background canvas for smooth transition
      const canvas = document.getElementById('bg');
      if (canvas) {
        canvas.classList.add('fast-fade');
        canvas.classList.remove('fader-in');
        canvas.classList.add('fader-out');
      }
    }

    // Show loading indicator
    if (navbar && !options.keepMedia) navbar.classList.add("pbwork");


    // Fix: Remove error overlay if present (from previous 404/error state)
    const errorWrapper = document.querySelector('._error_wrapper');
    if (errorWrapper) errorWrapper.remove();

    // Extract item ID from URL. Use the last numeric segment to avoid matching context IDs (like tag/1/...)
    // Split path, filter numeric, pop last.
    const pathSegments = new URL(url, window.location.origin).pathname.split('/');
    const numericSegments = pathSegments.filter(s => /^\d+$/.test(s));

    // Clear and Hide navbar pagination for Item View (Never show grid pagination on item view)
    // document.querySelectorAll('.pagination-wrapper').forEach(el => el.innerHTML = ''); // Don't destroy content (cached grid needs it)
    document.querySelectorAll('.pagination-container-fluid').forEach(el => el.style.display = 'none');

    if (numericSegments.length === 0) {
      console.warn("loadItemAjax: No ID match found in URL", url);
      // fallback for weird/external links
      window.location.href = url;
      return;
    }
    const itemid = numericSegments.pop();

    // Extract context from Target URL first
    let tag = null, user = null, isFavs = false, mime = null, hall = null, userHall = null, userHallOwner = null;
    const tagMatch = url.match(/\/tag\/([^/?]+)/);
    if (tagMatch) tag = decodeURIComponent(tagMatch[1]);

    // User hall: /user/:owner/hall/:slug/:id
    const userHallMatch = url.match(/\/user\/([^/]+)\/hall\/([^/]+)/);
    if (userHallMatch) {
      userHallOwner = decodeURIComponent(userHallMatch[1]);
      userHall = decodeURIComponent(userHallMatch[2]);
    }

    const userMatch = url.match(/\/user\/([^/]+)/);
    if (userMatch && !userHall) {
      user = decodeURIComponent(userMatch[1]);
      if (url.match(/\/user\/[^/]+\/favs(\/|$|\?)/)) isFavs = true;
    }
    
    const hallMatch = url.match(/\/h\/([^/?]+)/);
    if (hallMatch) hall = decodeURIComponent(hallMatch[1]);

    const mimeMatch = url.match(/\/((?:video|audio|image|,)+)(\/|$|\?)/);
    if (mimeMatch) mime = mimeMatch[1];
    
    // Check query params in the provided url too
    if (!mime && url.includes('mime=')) {
        const qMatch = url.match(/[?&]mime=([^&#]+)/);
        if (qMatch) mime = decodeURIComponent(qMatch[1]);
    }

    // If missing and inheritContext is true, check Window Location
    // IMPORTANT: Skip inheritance when target is a bare item URL like /1234 with no context
    // prefix (/h/, /tag/, /user/). Such URLs come from comment/notification sidebar links and
    // are explicitly context-free — they must not steal the current page's tag/hall/user.
    // Prev/next arrows in item view always use explicit /h/foo/<id> or /tag/foo/<id> hrefs
    // (via link.main), so they are unaffected by this guard.
    // Note: Notification links call loadItemAjax(href, false) to skip inheritance directly.
    if (inheritContext) {
      if (!tag) {
        const wTagMatch = window.location.href.match(/\/tag\/([^/?]+)/);
        if (wTagMatch) tag = decodeURIComponent(wTagMatch[1]);
      }
      if (!user && !userHall) {
        const wUserMatch = window.location.href.match(/\/user\/([^/?]+)/);
        if (wUserMatch && !window.location.href.match(/\/user\/[^/]+\/hall\//) ) {
          user = decodeURIComponent(wUserMatch[1]);
          if (window.location.href.match(/\/user\/[^/]+\/favs(\/|$|\?)/)) isFavs = true;
        }
      }
      if (!userHall) {
        const wUserHallMatch = window.location.href.match(/\/user\/([^/]+)\/hall\/([^/]+)/);
        if (wUserHallMatch) {
          userHallOwner = decodeURIComponent(wUserHallMatch[1]);
          userHall = decodeURIComponent(wUserHallMatch[2]);
        }
      }
      if (!hall) {
        const wHallMatch = window.location.href.match(/\/h\/([^/?]+)/);
        if (wHallMatch) hall = decodeURIComponent(wHallMatch[1]);
      }
    }
    // </context-preservation>

    try {
      // Construct AJAX URL
      let ajaxUrl = `/ajax/item/${itemid}`;

      const params = new URLSearchParams();
      params.append('mode', window.activeMode);
      if (tag) params.append('tag', tag);
      if (hall) params.append('hall', hall);
      if (userHall && userHallOwner) {
        params.append('userHall', userHall);
        params.append('userHallOwner', userHallOwner);
      } else if (user) {
        params.append('user', user);
      }
      if (isFavs) params.append('fav', 'true');

      const isStrict = window.f0ckSession?.strict_mode || (localStorage.getItem('search_strict') === 'true');

      if (isStrict || url.includes('strict=1') || window.location.search.includes('strict=1')) {
        params.append('strict', '1');
      }
      
      // Note: mime is no longer appended to params, server reads from cookie automatically
      params.append('_t', Date.now());

      const isRandom = document.cookie.includes('random_mode=1') || url.includes('random=1') || window.location.search.includes('random=1');
      if (isRandom) {
        params.append('random', '1');
      }

      // Explicit overrides for context (used for immediate mode switches)
      if (options.forceParams) {
        Object.keys(options.forceParams).forEach(key => {
          params.set(key, options.forceParams[key]);
        });
      }

      if (params.toString() !== '') {
        ajaxUrl += (ajaxUrl.includes('?') ? '&' : '?') + params.toString();
      }

      if (window.randomizeLogo) window.randomizeLogo();

      window.f0ckDebug("Fetching:", ajaxUrl);
      const tStart = performance.now();
      const response = await fetch(ajaxUrl, { credentials: 'include' });
      const tHeaders = performance.now();

      if (!response.ok) throw new Error(`Network response was not ok: ${response.status}`);

      const rawText = await response.text();
      const tBody = performance.now();

      window.f0ckDebug(`[CLIENT_DEBUG] Fetch timing for ${ajaxUrl}:
      - TTFB (Headers): ${(tHeaders - tStart).toFixed(2)}ms
      - Content Download: ${(tBody - tHeaders).toFixed(2)}ms
      - Total Network: ${(tBody - tStart).toFixed(2)}ms
      - Content Size: ${(rawText.length / 1024).toFixed(2)} KB`);

      let html, paginationHtml;

      try {
        // Optimistically try to parse as JSON first
        const data = JSON.parse(rawText);
        if (data && data.success === false) {
          console.warn("loadItemAjax: Server returned failure:", data.message);
          window.location.href = url; // Fallback to full page load
          return;
        }
        if (data && typeof data.html === 'string') {
          html = data.html;
          paginationHtml = data.pagination;
        } else {
          html = rawText;
        }
      } catch (e) {
        // If JSON parse fails, assume it's HTML text
        html = rawText;
      }
      
      // Track visit for guests
      window.trackVisit(itemid);

      let container = document.querySelector('#main .container') || (document.getElementById('main') && document.getElementById('main').classList.contains('item-view') ? document.getElementById('main') : null);
      const isStructuralPage = !!document.querySelector('.pagewrapper');
      const isModeratorPage = !!document.querySelector('.approval-grid, .audit-log-container, .mod-reports-page');
      const isNotificationsPage = !!document.querySelector('.notifications-page, .notif-history-container');
      const isIndexPage = !!document.querySelector('.index-container, .posts');
      const isStaticPage = !!document.querySelector('.static-page, .about-container, .upload-container');


      if (!options.keepMedia && (!container || isModeratorPage || isNotificationsPage || isIndexPage || isStaticPage || isStructuralPage)) {
        // Transition to Item View
        if (main) {
          // Check if we can cache the existing grid (Index Page only)
          const indexWrapper = main.querySelector('.index-layout-wrapper');
          const indexContainer = main.querySelector('.index-container');
          const nodeToCache = indexWrapper || indexContainer;

          if (nodeToCache && isIndexPage) {
             const cacheKey = window.location.pathname + window.location.search;
             const paginationWrapper = document.querySelector('.pagination-wrapper');
             gridCacheMap.set(cacheKey, {
                node: nodeToCache,
                scroll: currentScroll,
                pagination: paginationWrapper ? paginationWrapper.innerHTML : '' 
             });
             nodeToCache.remove();
          }
          
          main.className = 'item-view';

          // Correctly handle body classes for the current layout mode
          document.body.classList.remove('legacy-view', 'layout-modern', 'layout-legacy');
          if (window.f0ckSession && !window.f0ckSession.use_new_layout) {
            document.body.classList.add('layout-legacy');
          } else {
            document.body.classList.add('layout-modern');
          }
          if (window.syncNavbarHeight) window.syncNavbarHeight();

          // Toggle button lives permanently in body via header.html — no creation needed

          // HTML goes directly into #main without outdated .container wrapper for New Layout
          main.innerHTML = '';
          container = main; // HTML goes directly into #main
        }
      } else if (container && !options.keepMedia) {
        // Already in some kind of item view or compatible layout, just clear it
        container.innerHTML = '';
        container.removeAttribute('style'); // Ensure no carry-over styles
        if (main) main.className = 'item-view';
      }

      if (options.keepMedia) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        // Surgically update only navigation and metadata, leaving the media container untouched
        const selectors = [
          '.previous-post', 
          '.next-post', 
          '.steuerung', 
          '.sidebar-tags-container', 
          '.blahlol', 
          '.location', 
          '.gapRight', 
          '.tag-controls'
        ];
        
        selectors.forEach(sel => {
          const oldEl = container.querySelector(sel);
          const newEl = doc.querySelector(sel);
          if (oldEl && newEl) {
            oldEl.replaceWith(newEl.cloneNode(true));
          }
        });
      } else {
        container.insertAdjacentHTML('beforeend', html);
      }


      // Handle Scroll Position (Restore or Reset)
      if (options.skipPush && history.state && history.state.scroll !== undefined) {
         requestAnimationFrame(() => window.scrollTo(0, history.state.scroll));
      } else if (!options.keepMedia) {
         window.scrollTo(0, 0);
      }

      // NO PAGINATION UPDATE FOR ITEM VIEW (Fixes 30k flicker)
      // On Item view, we use .previous-post / .next-post in content only.

      // Construct proper History URL (Context Aware)
      // If we inherited context, we should reflect it in the URL
      const hash = new URL(url, window.location.origin).hash;
      let pushUrl = `/${itemid}`;
      // Logic from ajax.mjs context reconstruction:
      if (userHall && userHallOwner) {
        pushUrl = `/user/${encodeURIComponent(userHallOwner)}/hall/${encodeURIComponent(userHall)}/${itemid}`;
      } else if (user) {
        pushUrl = `/user/${encodeURIComponent(user)}/${itemid}`;
        if (isFavs) pushUrl = `/user/${encodeURIComponent(user)}/favs/${itemid}`;
      }
      else if (tag) pushUrl = `/tag/${encodeURIComponent(tag).replace(/%2C/g, ',').replace(/%20/g, ' ')}/${itemid}`;
      else if (hall) pushUrl = `/h/${encodeURIComponent(hall).replace(/%20/g, ' ')}/${itemid}`;
      
      if (mime) {
          // If it already has itemid at the end, insert mime before it
          pushUrl = pushUrl.replace(new RegExp(`/${itemid}$`), `/${mime}/${itemid}`);
      }



      // Re-append hash if present
      if (hash) pushUrl += hash;

      if (!options.keepMedia && !options.skipPush) {
        // We overwrite proper URL even if the link clicked was "naked"
        history.pushState({}, '', pushUrl);
      }

      if (!options.keepMedia) {
        setupMedia();
        // Remove fader-out and fast-fade to ensure canvas shows up if enabled
        const canvas = document.getElementById('bg');
        if (canvas) {
          canvas.classList.remove('fader-out', 'fast-fade');
        }
        if (window.initBackground) window.initBackground();
        if (window.initVisualizer) window.initVisualizer();
      }
      // Try to extract ID from response if possible or just use itemid
      document.title = `${window.f0ckDomain} - ${itemid}`;
      if (navbar) navbar.classList.remove("pbwork");
      window.f0ckDebug("AJAX load complete");

      // Notify extensions — also triggers CommentSystem init which renders comments
      document.dispatchEvent(new Event('f0ck:contentLoaded'));
      if (window.initSidebarRightToggle) window.initSidebarRightToggle();
      if (window.updateMimeLabel) window.updateMimeLabel();
      try {
        if (window.updateStrictLinks && window.f0ckSession) {
          window.updateStrictLinks(window.f0ckSession.strict_mode);
        }
      } catch (err) {
        console.error("updateStrictLinks error:", err);
      }

      // After comments have rendered (f0ck:contentLoaded above triggers synchronous render),
      // constrain the comments-list height via direct measurement (flex chain unreliable in AJAX).

      // Instant jump to hash (e.g. #c123) is now handled exclusively by CommentSystem
      // which has robust retry and timing logic. Redirecting to CommentSystem
      // by simply ensuring f0ck:contentLoaded is fired (already done above).

    } catch (err) {
      console.error("AJAX load failed:", err);
    } finally {
      isNavigating = false;
    }
  };

  const changePage = (e, pbwork = true) => {
    if (pbwork) {
      const nav = document.querySelector("nav.navbar");
      if (nav) nav.classList.add("pbwork");
    }
    // Trigger native click for navigation
    e.click();
  };

  // Intercept clicks
  document.addEventListener('click', (e) => {
    const target = e.target.nodeType === 3 ? e.target.parentElement : e.target;

    // Check for mode selection
    const modeBtn = target.closest('.mode-btn');
    if (modeBtn && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      // Update UI immediately for better UX
      const parent = modeBtn.parentElement;
      if (parent) {
        parent.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
      }
      modeBtn.classList.add('active');
      const modeMatch = modeBtn.href.match(/\/mode\/(\d)/);
      if (modeMatch) {
          window.activeMode = +modeMatch[1];
          document.dispatchEvent(new CustomEvent('f0ck:modeChanged', { detail: { mode: window.activeMode } }));
      }

      // Sync state immediately via cookie to avoid race conditions
      document.cookie = `mode=${window.activeMode}; Path=/; Max-Age=31536000`;

      // Keep filter modal open if the click came from inside it
      const fromFilterModal = !!modeBtn.closest('#excluded-tags-overlay');
      if (fromFilterModal) window._keepFilterModal = true;

      // Update mode via AJAX
      fetch(modeBtn.href, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include'
      })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            const modeName = modeBtn.textContent.trim().toUpperCase();
            window.flashMessage(`${modeName} MODE ACTIVATED`);

            // Invalidate all grid caches on mode change to ensure consistency
            gridCacheMap.clear();

            // Refresh content
            const isGridView = document.querySelector('.posts, .tags-grid');
            const isItemView = document.getElementById('prev') || document.getElementById('next');

            let reloadPromise = null;
            if (isGridView) {
              // Reload current page without ?mode= in the URL — server picks up mode from session/cookie
              const currentUrl = new URL(window.location.href);
              currentUrl.searchParams.delete('mode');
              reloadPromise = loadPageAjax(currentUrl.toString(), true, { skipCache: true });
            } else if (isItemView) {
              // Directly update nav links for the new mode without keepMedia complexity
              updateNavForMode(window.activeMode);
            }

            if (fromFilterModal) {
              Promise.resolve(reloadPromise).finally(() => { window._keepFilterModal = false; });
            }
          } else {
            if (fromFilterModal) window._keepFilterModal = false;
            // Fallback
            window.location.href = modeBtn.href;
          }
        })
        .catch(err => {
          if (fromFilterModal) window._keepFilterModal = false;
          console.error("Mode update failed:", err);
          window.location.href = modeBtn.href;
        });
      return;
    }

    // Check for thumbnail links on index page
    const thumbnail = target.closest('.posts > a:not(.notif-item)');
    if (thumbnail && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      // Thumbnails inherit context (e.g. from Tag Index)
      loadItemAjax(thumbnail.href, true);
      return;
    }

    const link = target.closest('#next, #prev, #back, #random, #nav-random, .id-link, .nav-next, .nav-prev');
    if (link && link.href && link.hostname === window.location.hostname && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      // Special check for random
      if (link.id === 'random' || link.id === 'nav-random') {
        e.preventDefault();
        stopMedia(); // Abort media BEFORE fetching random item

        // Fade out background canvas for smooth transition
        const canvas = document.getElementById('bg');
        if (canvas) {
          canvas.classList.add('fast-fade');
          canvas.classList.remove('fader-in');
          canvas.classList.add('fader-out');
        }

        const nav = document.querySelector("nav.navbar");
        if (nav) nav.classList.add("pbwork");

        // Extract current context from window location
        let randomUrl = '/api/v2/random';
        const params = new URLSearchParams();

        const wTagMatch = window.location.href.match(/\/tag\/([^/]+)/);
        if (wTagMatch) params.append('tag', decodeURIComponent(wTagMatch[1]));

        // Check for user hall FIRST — if we're in a user hall, don't also send user=
        // (the /user/:name part of the URL would otherwise incorrectly trigger user= filter)
        let wUserHall = null, wUserHallOwner = null;
        const wUserHallMatch = window.location.href.match(/\/user\/([^/]+)\/hall\/([^/]+)/);
        if (wUserHallMatch) {
          wUserHallOwner = decodeURIComponent(wUserHallMatch[1]);
          wUserHall = decodeURIComponent(wUserHallMatch[2]);
          params.append('userHall', wUserHall);
          params.append('userHallOwner', wUserHallOwner);
        } else {
          // Only add user= when NOT in a user hall context
          const wUserMatch = window.location.href.match(/\/user\/([^/]+)/);
          if (wUserMatch) {
            params.append('user', decodeURIComponent(wUserMatch[1]));
            if (window.location.href.match(/\/favs(\/|$|\?)/)) {
              params.append('fav', 'true');
            }
          }
        }

        const wHallMatch = window.location.href.match(/\/h\/([^/]+)/);
        if (wHallMatch) params.append('hall', decodeURIComponent(wHallMatch[1]));

        const urlParams = new URLSearchParams(window.location.search);
        const qMime = urlParams.get('mime');
        if (qMime) params.append('mime', qMime);
        else {
          const wMimeMatch = window.location.href.match(/\/((?:video|audio|image|,)+)(\/|$|\?)/);
          if (wMimeMatch) params.append('mime', wMimeMatch[1]);
          else {
            // Fallback to cookie
            const cookieMime = document.cookie.split('; ').find(row => row.startsWith('mime='));
            if (cookieMime) params.append('mime', cookieMime.split('=')[1]);
          }
        }

        const isStrict = window.f0ckSession?.strict_mode || window.location.search.includes('strict=1') || (localStorage.getItem('search_strict') === 'true');
        if (isStrict) {
          params.append('strict', '1');
        }

        if ([...params].length > 0) {
          randomUrl += '?' + params.toString();
        }

        fetch(randomUrl)
          .then(r => r.json())
          .then(data => {
            if (data.success && data.items && data.items.id) {
              // Navigate in the same context (user hall, tag, etc.)
              if (wUserHall && wUserHallOwner) {
                loadItemAjax(`/user/${encodeURIComponent(wUserHallOwner)}/hall/${encodeURIComponent(wUserHall)}/${data.items.id}`, true);
              } else {
                loadItemAjax(`/${data.items.id}`, true);
              }
            } else {
              window.location.href = link.href;
            }
          })
          .catch((err) => {
            console.error("Random fetch failed:", err);
            window.location.href = link.href;
          });
        return;
      }


      // Standard item links
      e.preventDefault();
      if (link.href.match(/\/p\/\d+/) || link.href.match(/[?&]page=\d+/)) {
        loadPageAjax(link.href);
      } else {
        loadItemAjax(link.href, true);
      }
      return;
    }

    // Intercept tag, user, and home links for AJAX Grid View transitions
    const anyLink = target.closest('a');
    if (anyLink && anyLink.hostname === window.location.hostname && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && anyLink.target !== '_blank') {
      const pathname = anyLink.pathname;
      const isSpecialLink = anyLink.classList.contains('removetag') || anyLink.classList.contains('admin-deltag') || anyLink.classList.contains('mode-btn') || anyLink.classList.contains('btn-approve-async') || anyLink.classList.contains('btn-deny-async') || anyLink.getAttribute('href') === '#';

      const targetUrl = anyLink.href;
      const currentUrl = window.location.href.split('#')[0];
      const targetUrlBase = targetUrl.split('#')[0];
      const hash = anyLink.hash;

      // If it's a same-page hash link, just jump and don't AJAX reload
      if (targetUrlBase === currentUrl && hash) {
        e.preventDefault();
        
        // If it's a comment link, use the robust CommentSystem logic
        if (hash.startsWith('#c') && window.commentSystem) {
          const id = hash.substring(2);
          window.commentSystem.scrollToComment(id);
        } else {
          const targetEl = document.querySelector(hash);
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Clear any previous highlight, then permanently mark this element
            document.querySelectorAll('.anchor-target').forEach(el => el.classList.remove('anchor-target'));
            targetEl.classList.add('anchor-target');
          }
        }
        
        // Update URL without reload
        history.replaceState(null, null, targetUrl);
        return;
      }

      // Intercept /register and /login — handle entirely client-side
      if (!isSpecialLink && (pathname === '/register' || pathname === '/login')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (window.f0ckSession && window.f0ckSession.logged_in) {
          window.showFlash('Already logged in lol', 'error');
        } else {
          if (pathname === '/login') openModal(loginModal, 'login');
          else openModal(registerModal);
        }

        return false;
      }

      if (!isSpecialLink && (pathname === '/' || pathname.startsWith('/halls') || pathname.startsWith('/h/') || pathname.startsWith('/notifications') || pathname.startsWith('/tag') || pathname.startsWith('/user/') || pathname.match(/^\/(image|video|audio)/) || pathname.match(/\/p\/\d+/) || pathname.match(/^\/\d+/) || pathname.match(/^\/(about|rules|terms|upload|subscriptions|stats|docs|settings|admin|mod|ranking|messages|meme|memes)/) || pathname.startsWith('/abyss'))) {
        e.preventDefault();
        e.stopImmediatePropagation();

        let targetUrl = anyLink.href;
        // Strip strict param if present to rely on session and keep URL clean
        if (targetUrl.includes('strict=1')) {
          targetUrl = targetUrl.replace(/[?&]strict=1/, '').replace(/[?&]$/, '');
        }

        const parts = pathname.split('/').filter(Boolean);
        const isItemLink = !pathname.match(/\/p\//) && (
          pathname.match(/^\/\d+/) || 
          (parts.length >= 3 && parts[0] === 'tag' && /^\d+$/.test(parts[parts.length - 1])) ||
          (parts.length >= 3 && parts[0] === 'user' && /^\d+$/.test(parts[parts.length - 1])) ||
          (parts.length >= 3 && parts[0] === 'h' && /^\d+$/.test(parts[parts.length - 1]))
        );
        if (isItemLink) {
          // Links inside comment bodies should not inherit tag/hall context
          const _inComment = anyLink.closest(".comment, .comment-content, .comment-body");
          loadItemAjax(targetUrl, !_inComment);
        } else {
          loadPageAjax(targetUrl, true);
        }
        return false;
      }
    }

    if (target.closest('#togglebg')) {
      e.preventDefault();
      window.toggleBackground();
    } else if (target.closest('#toggleautoplay')) {
      e.preventDefault();
      window.toggleAutoplay();
    } else if (target.closest('#a_oc')) {
      e.preventDefault();
      const ocBtn = target.closest('#a_oc');
      const id = ocBtn.dataset.itemId;

      fetch('/api/v2/toggle-oc', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRF-Token': window.f0ckSession?.csrf_token
          },
          body: new URLSearchParams({ postid: id })
      })
      .then(r => r.json())
      .then(data => {
          if (data.success) {
              const newOc = data.is_oc;
              ocBtn.dataset.isOc = newOc;
              ocBtn.setAttribute('title', newOc ? 'Remove OC status' : 'Mark as OC');
              // FA icon: toggle fa-solid / fa-regular
              ocBtn.classList.toggle('fa-solid', newOc);
              ocBtn.classList.toggle('fa-regular', !newOc);

              window.flashMessage((window.f0ckI18n && (newOc ? window.f0ckI18n.oc_marked : window.f0ckI18n.oc_removed)) || (newOc ? 'MARKED AS ORIGINAL CONTENT' : 'OC STATUS REMOVED'));
          } else {
              window.flashError(data.msg || 'Error toggling OC status');
          }
      })
      .catch(console.error);

    } else if (target.closest('#a_rethumb')) {
        e.preventDefault();
        const reBtn = target.closest('#a_rethumb');
        const itemId = reBtn.dataset.itemId;
        
        let fileInput = document.getElementById('rethumb-file-input');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.id = 'rethumb-file-input';
            fileInput.accept = 'image/png, image/jpeg, image/gif, image/webp';
            fileInput.style.display = 'none';
            document.body.appendChild(fileInput);
            
            fileInput.addEventListener('change', function(evt) {
                const file = evt.target.files[0];
                if (!file) return;
                
                if (file.size > 5 * 1024 * 1024) {
                    window.flashError('File is too large (max 5MB)');
                    fileInput.value = '';
                    return;
                }
                
                const currentItemId = fileInput.dataset.itemId;
                const fd = new FormData();
                fd.append('file', file);
                
                window.flashMessage(i18n.uploading || 'Uploading...');
                
                fetch(`/api/v2/items/${currentItemId}/thumbnail`, {
                    method: 'POST',
                    headers: {
                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                    },
                    body: fd
                })
                .then(r => r.json())
                .then(data => {
                    fileInput.value = '';
                    if (data.success) {
                        window.flashMessage(data.msg);
                        if (window.refreshItemThumbnails) {
                            window.refreshItemThumbnails(currentItemId);
                        }
                    } else {
                        window.flashError(data.msg || 'Upload failed');
                    }
                })
                .catch(err => {
                    fileInput.value = '';
                    window.flashError('Upload error');
                    console.error(err);
                });
            });
        }
        
        fileInput.dataset.itemId = itemId;
        fileInput.click();
    } else if (target.closest('button#a_toggle')) {
      e.preventDefault();
      const toggleBtn = target.closest('button#a_toggle');
      const idLink = document.querySelector("a.id-link");
      if (!idLink) return;
      const postid = +idLink.innerText;

      // Determine current rating
      let currentRating = 'sfw';
      if (toggleBtn.classList.contains('is-sfw')) currentRating = 'sfw';
      else if (toggleBtn.classList.contains('is-nsfw')) currentRating = 'nsfw';
      else if (toggleBtn.classList.contains('is-nsfl')) currentRating = 'nsfl';
      else if (toggleBtn.classList.contains('is-untagged')) currentRating = 'untagged';

      // Cycle SFW -> NSFW -> NSFL (if enabled) -> SFW
      let nextRating = 'sfw';
      if (currentRating === 'sfw') {
        nextRating = 'nsfw';
      } else if (currentRating === 'nsfw') {
        nextRating = (window.f0ckSession && window.f0ckSession.enable_nsfl) ? 'nsfl' : 'sfw';
      }

      const labels = { sfw: 'SFW', nsfw: 'NSFW', nsfl: 'NSFL', untagged: '?' };
      const nextLabel = labels[nextRating] || nextRating.toUpperCase();

      // Backup current state
      const oldClasses = [...toggleBtn.classList];
      const oldTextContent = toggleBtn.textContent;

      // Track active request ID to ignore out-of-order race conditions on rapid keypresses
      const reqId = (toggleBtn._lastCycleReqId || 0) + 1;
      toggleBtn._lastCycleReqId = reqId;

      // Increment active requests count to block incoming live SSE tag updates during cycle
      toggleBtn._activeRequestsCount = (toggleBtn._activeRequestsCount || 0) + 1;

      // Optimistically apply new state
      toggleBtn.classList.remove('is-sfw', 'is-nsfw', 'is-nsfl', 'is-untagged');
      toggleBtn.classList.add(`is-${nextRating}`);
      toggleBtn.textContent = nextLabel;

      // Optimistically update the sidebar tag list
      let originalTags = [];
      if (window.renderTags) {
        const tagsContainer = document.querySelector("#tags");
        const inner = tagsContainer ? (tagsContainer.querySelector(".tags-inner") || tagsContainer) : null;
        if (inner) {
          originalTags = [...inner.querySelectorAll(".badge")].filter(badge => {
            return !badge.querySelector('#a_addtag') && !badge.querySelector('#a_toggle') && !badge.classList.contains('tag-ac-wrapper');
          }).map(badge => {
            const a = badge.querySelector('a[href*="/tag/"]');
            const tagText = a ? a.innerText.trim() : '';
            const normalized = a ? a.getAttribute('href').split('/').pop() : '';
            const badgeClasses = [...badge.classList].filter(c => c !== 'badge' && c !== 'mr-2').join(' ');
            return {
              tag: tagText,
              normalized: normalized,
              badge: badgeClasses
            };
          });

          // Create the optimistic rating tag object
          const userStr = (window.f0ckSession && window.f0ckSession.user) || '';
          const dispName = (window.f0ckSession && window.f0ckSession.display_name) || userStr;
          let newRatingTag = null;
          if (nextRating === 'sfw') {
            newRatingTag = { id: 1, tag: 'sfw', normalized: 'sfw', badge: 'badge-success', user: userStr, display_name: dispName };
          } else if (nextRating === 'nsfw') {
            newRatingTag = { id: 2, tag: 'nsfw', normalized: 'nsfw', badge: 'badge-danger', user: userStr, display_name: dispName };
          } else if (nextRating === 'nsfl') {
            const nsfl_id = (window.f0ckSession && window.f0ckSession.nsfl_tag_id) || 3;
            newRatingTag = { id: nsfl_id, tag: 'nsfl', normalized: 'nsfl', badge: 'badge-nsfl', user: userStr, display_name: dispName };
          }

          // Combine tags: filter out old rating tags and place the new one at the front
          const optimisticTags = [];
          if (newRatingTag) {
            optimisticTags.push(newRatingTag);
          }
          originalTags.filter(t => t.normalized !== 'sfw' && t.normalized !== 'nsfw' && t.normalized !== 'nsfl').forEach(t => {
            optimisticTags.push(t);
          });

          window.renderTags(optimisticTags);
        }
      }

      const flashMsg = (window.f0ckI18n && window.f0ckI18n.mode_activated && window.f0ckI18n.mode_activated.replace('{mode}', nextLabel)) || ('RATING UPDATED: ' + nextLabel);
      window.flashMessage(flashMsg);

      // Enqueue the request to ensure sequential server execution in correct order
      if (!toggleBtn._requestQueue) {
        toggleBtn._requestQueue = Promise.resolve();
      }

      toggleBtn._requestQueue = toggleBtn._requestQueue.then(() => {
        return fetch(`/api/v2/item/${postid}/rating`, {
          method: 'POST',
          headers: { 
            "Content-Type": "application/json",
            "X-CSRF-Token": window.f0ckSession?.csrf_token 
          },
          body: JSON.stringify({ rating: nextRating })
        })
        .then(r => r.json())
        .then(res => {
          toggleBtn._activeRequestsCount = Math.max(0, (toggleBtn._activeRequestsCount || 1) - 1);
          
          // Verify we are still on the same post (prevent dynamic/PJAX page leaks)
          const activeIdLink = document.querySelector("a.id-link");
          const currentPostId = activeIdLink ? +activeIdLink.innerText : null;
          if (currentPostId !== postid) return;

          if (toggleBtn._lastCycleReqId !== reqId) return; // ignore stale responses
          if (res.success) {
            // Verify visual state and sync tags
            toggleBtn.classList.remove('is-sfw', 'is-nsfw', 'is-nsfl', 'is-untagged');
            toggleBtn.classList.add(`is-${res.rating}`);
            toggleBtn.textContent = labels[res.rating] || res.rating.toUpperCase();

            if (window.renderTags) {
              window.renderTags(res.tags);
            }
          } else {
            revert();
            window.flashMessage('Error: ' + (res.msg || 'Failed to update rating'), 3000, 'error');
          }
        })
        .catch(err => {
          toggleBtn._activeRequestsCount = Math.max(0, (toggleBtn._activeRequestsCount || 1) - 1);

          // Verify we are still on the same post (prevent dynamic/PJAX page leaks)
          const activeIdLink = document.querySelector("a.id-link");
          const currentPostId = activeIdLink ? +activeIdLink.innerText : null;
          if (currentPostId !== postid) return;

          if (toggleBtn._lastCycleReqId !== reqId) return;
          console.error('[RATING_TOGGLE_ERROR]', err);
          revert();
          window.flashMessage('Failed to toggle rating', 3000, 'error');
        });
      });

      function revert() {
        toggleBtn.className = '';
        oldClasses.forEach(cls => toggleBtn.classList.add(cls));
        toggleBtn.textContent = oldTextContent;
        if (window.renderTags && originalTags.length > 0) {
          window.renderTags(originalTags);
        }
      }
    }
  });

  window.addEventListener('popstate', (e) => {
    const url = window.location.href;
    const p = window.location.pathname;

    // ── Abyss handling ───────────────────────────────────────────────────
    const wasOnAbyss = document.body.classList.contains('scroller-active');

    if (p.startsWith('/abyss')) {
      if (wasOnAbyss) {
        // Within-abyss back/forward — let the scroller's own popstate handler manage it
        return;
      }
      // Coming BACK to abyss from a different page — full reload to reinitialize
      window.location.reload();
      return;
    }

    // Leaving abyss — stop all media
    if (wasOnAbyss) {
      document.querySelectorAll('video, audio').forEach(el => { try { el.pause(); el.removeAttribute('src'); el.load(); } catch {} });
      document.querySelectorAll('ruffle-player').forEach(el => { try { el.remove(); } catch {} });
    }

    // Item detection logic MUST match loadPageAjax/loadItemAjax analysis
    // Priorities: Item first, then Special/Grid
    const parts = p.split('/').filter(Boolean);
    const isItem = !p.match(/\/p\//) && (
      p.match(/^\/\d+/) || 
      (parts.length >= 3 && parts[0] === 'tag' && /^\d+$/.test(parts[parts.length - 1])) ||
      (parts.length >= 3 && parts[0] === 'user' && /^\d+$/.test(parts[parts.length - 1]))
    );
    const isSpecial = p.startsWith('/notifications') || p.startsWith('/tags') || p.startsWith('/user/') || p.startsWith('/subscriptions') || p.startsWith('/ranking');
    const isGridLike = url.match(/\/p\/\d+/) || url.match(/[?&]page=\d+/) || p === '/';

    window.f0ckDebug("[popstate] Navigation to:", url, { isItem, isSpecial, isGridLike });

    if (isItem) {
      loadItemAjax(url, true, { skipPush: true });
    } else if (isSpecial || isGridLike) {
      loadPageAjax(url, true, { skipPush: true });
    } else {
      // Fallback
      loadPageAjax(url, true, { skipPush: true });
    }
  });

  // <keybindings>
  const clickOnElementBinding = selector => () => (elem = document.querySelector(selector)) ? elem.click() : null;
  const clickOnNavBinding = selector => () => { const el = document.querySelector(selector); if (el && el.href && !el.href.endsWith('#')) el.click(); };
  const keybindings = {
    "ArrowLeft": clickOnNavBinding("#prev"),
    "a": clickOnNavBinding("#prev"),
    "ArrowRight": clickOnNavBinding("#next"),
    "d": clickOnNavBinding("#next"),
    "r": clickOnElementBinding("#random, #nav-random"),
    "p": clickOnElementBinding("button#a_toggle"),
    "f": clickOnElementBinding("#a_favo"),
    "i": clickOnElementBinding("a#a_addtag"),
    "l": () => window.toggleBackground(),
    "y": () => {
      const url = window.location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => window.flashMessage('URL copied to clipboard'));
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = url;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
          document.execCommand("copy");
          window.flashMessage((window.f0ckI18n && window.f0ckI18n.copied) || 'URL copied to clipboard');
        } catch (err) {
          console.error("Fallback copy failed:", err);
        }
        document.body.removeChild(textarea);
      }
    },
    " ": () => {
      if (video && typeof video.play === 'function') { // Check if video wrapper exists/is valid
        video[video.paused ? 'play' : 'pause']();
        const overlay = document.querySelector('.v0ck_overlay');
        if (overlay) overlay.classList[video.paused ? 'remove' : 'add']('v0ck_hidden');
      } else {
        const img = document.querySelector("#f0ck-image");
        if (img) img.click();
      }
    },
     "m": () => {
        window.randomizeLogo();
        const cookieMime = document.cookie.split('; ').find(row => row.startsWith('mime='));
        const mime = cookieMime ? cookieMime.split('=')[1] : null;
        loadPageAjax(mime ? `/${mime}` : '/');
      },
    "h": () => {
      if (typeof window.toggleSidebarRight === 'function') {
        window.toggleSidebarRight();
      }
    },
    "?": () => {
      const modal = document.getElementById('shortcuts-modal');
      if (modal) {
        if (modal.style.display === 'none') {
          openModal(modal);
        } else {
          closeModal(modal);
        }
      }
    },
    "ß": () => {
      const modal = document.getElementById('shortcuts-modal');
      if (modal) {
        if (modal.style.display === 'none') {
          openModal(modal);
        } else {
          closeModal(modal);
        }
      }
    },
    "q": () => {
      const modal = document.getElementById('metadata-modal');
      if (modal && modal.style.display !== 'none') {
        // Modal is open — close it
        modal.style.display = 'none';
        document.dispatchEvent(new Event('metadata-modal-close'));
      } else {
        const btn = document.getElementById('a_metadata');
        if (btn) btn.click();
      }
    },
    "z": () => {
      const btn = document.querySelector('.shuffle-btn');
      if (btn) btn.click();
    }
  };
  // Track whether the user has clicked inside the Ruffle player.
  // Ruffle renders in a shadow root / iframe so document.activeElement won't reflect it.
  let ruffleHasFocus = false;
  document.addEventListener('click', (e) => {
    const rc = document.getElementById('ruffle-container');
    ruffleHasFocus = !!(rc && rc.contains(e.target));
  }, true); // capture phase so it runs before anything else

  document.addEventListener("keydown", e => {
    // Block interaction if content warning is visible
    const cwModal = document.getElementById('content-warning-modal');
    if (cwModal && cwModal.style.display !== 'none') return;

    // Yield all keys to Ruffle when user has clicked inside the player
    if (ruffleHasFocus) return;

    // Don't fire global shortcuts on the scroller/abyss page — it has its own handler
    if (document.body && document.body.classList.contains('scroller-active')) return;

    if (e.key in keybindings && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
      const isHelpKey = e.key === '?' || e.key === 'ß';
      if (e.repeat || (e.shiftKey && e.key !== '?') || e.ctrlKey || e.metaKey || e.altKey)
        return;
      e.preventDefault();
      keybindings[e.key]();
    }
  });
  // </keybindings>

  // <wheeler>
  const wheelEventListener = function (event) {
    // User preference: enabled wheel navigation
    if (localStorage.getItem('wheelNavEnabled') !== 'true') return;

    // Block interaction if content warning is visible
    const cwModal = document.getElementById('content-warning-modal');
    if (cwModal && cwModal.style.display !== 'none') return;

    if (event.target.closest('.media-object, .steuerung') && !event.target.closest('#favs') && !event.target.closest('#ruffle-container')) {
      event.preventDefault(); // Prevent default scroll
      if (event.deltaY < 0) {
        const el = document.getElementById('prev');
        if (el && el.href && !el.href.endsWith('#')) el.click();
      } else if (event.deltaY > 0) {
        const el = document.getElementById('next');
        if (el && el.href && !el.href.endsWith('#')) el.click();
      }
    }
  };

  window.addEventListener('wheel', wheelEventListener, { passive: false });
  // </wheeler>

  // <infinite-scroll>
  const initInfiniteScroll = (postsContainer) => {
    if (!postsContainer || postsContainer.classList.contains('no-infinite-scroll')) return;
    
    // If already initialized, clean up the old scroll listener first
    if (postsContainer._infiniteState) {
      if (postsContainer._scrollHandler) {
        window.removeEventListener('scroll', postsContainer._scrollHandler);
        delete postsContainer._scrollHandler;
      }
      delete postsContainer._infiniteState;
    }

    // Infinite scroll state
    postsContainer._infiniteState = {
      loading: false,
      loadingUp: false,
      hasMore: true,
      hasPrev: false,
      currentPage: 1,
      firstPage: 1,
      lastScrollY: window.scrollY,
      navigationGracePeriod: Date.now() + 500, // No URL updates for 500ms after load
      loadedPages: new Set()
    };
    const infiniteState = postsContainer._infiniteState;

    // Extract context (tag/user/mime) from URL
    const getContext = () => {
      const ctx = {};
      const tagMatch = window.location.pathname.match(/\/tag\/([^/]+)/);
      if (tagMatch && !window.location.pathname.startsWith('/tags')) ctx.singleTag = decodeURIComponent(tagMatch[1]);

      const userMatch = window.location.pathname.match(/\/user\/([^/]+)/);
      if (userMatch) {
        ctx.user = decodeURIComponent(userMatch[1]);
        if (window.location.pathname.includes('/favs')) ctx.fav = true;
        if (window.location.pathname.includes('/f0cks')) ctx.f0cks = true;
      }

      const mimeMatch = window.location.pathname.match(/\/(image|audio|video)(?:\/|$)/);
      if (mimeMatch) ctx.mime = mimeMatch[1];

      const hallMatch = window.location.pathname.match(/\/h\/([^/]+)/);
      if (hallMatch) ctx.hall = decodeURIComponent(hallMatch[1]);
      const isNotif = window.location.pathname.startsWith('/notifications');
      if (isNotif) ctx.notif = true;
      const isTags = window.location.pathname.startsWith('/tags');
      if (isTags) ctx.tags = true;
      const isSubs = window.location.pathname.startsWith('/subscriptions');
      if (isSubs) ctx.subs = true;
      return ctx;
    };

    // Build URL path for history
    const buildUrl = (page) => {
      const ctx = getContext();
      if (ctx.notif) return page > 1 ? `/notifications?page=${page}` : '/notifications';
      if (ctx.tags) return page > 1 ? `/tags?page=${page}` : '/tags';
      if (ctx.subs) return page > 1 ? `/subscriptions?page=${page}` : '/subscriptions';
      let path = '/';
      if (ctx.singleTag) path += `tag/${ctx.singleTag}/`;
      if (ctx.hall) path += `h/${ctx.hall}/`;
      if (ctx.user) {
        path += `user/${ctx.user}/`;
        if (ctx.fav) path += `favs/`;
        else if (ctx.f0cks) path += `f0cks/`;
      }
      if (ctx.mime) path += `${ctx.mime}/`;
      if (page > 1) path += `p/${page}`;
      const resPath = path.replace(/\/$/, '') || '/';
      const isStrict = !window.f0ckSession && (localStorage.getItem('search_strict') === 'true');
      return isStrict ? `${resPath}?strict=1` : resPath;
    };

    // Extract current page from URL
    const pageMatch = window.location.pathname.match(/\/p\/(\d+)/);
    if (pageMatch) {
      const p = parseInt(pageMatch[1]);
      infiniteState.currentPage = p;
      infiniteState.firstPage = p;
    }

    // Check for pre-set state from AJAX page load (or initial server render)
    if (postsContainer.dataset.hasMore !== undefined) {
      infiniteState.hasMore = postsContainer.dataset.hasMore === 'true';
      delete postsContainer.dataset.hasMore; // Clear after reading
    }
    if (postsContainer.dataset.currentPage !== undefined) {
      const p = parseInt(postsContainer.dataset.currentPage);
      
      // If the server-provided page differs from the URL, synchronize the URL immediately
      if (infiniteState.currentPage !== p) {
        infiniteState.currentPage = p;
        infiniteState.firstPage = p;
        history.replaceState({}, '', buildUrl(p));
      }

      delete postsContainer.dataset.currentPage; // Clear after reading
    }

    // Track initially loaded page
    infiniteState.loadedPages.add(infiniteState.currentPage);

    // Check if we can scroll up (are we on page > 1?)
    infiniteState.hasPrev = infiniteState.firstPage > 1;

    // Track currently visible page for URL updates
    infiniteState.visiblePage = infiniteState.currentPage;

    // Helper to find the active page marker
    const updateUrlAndPagination = () => {
      const markers = [...document.querySelectorAll('[data-page-start]')];
      if (!markers.length) return;

      const triggerPoint = window.innerHeight / 3;
      let activeMarker = markers[0];

      // Find the marker that is currently most visible/active
      let maxVisibleHeight = 0;

      const viewportHeight = window.innerHeight;
      const scrollTop = window.scrollY;

      // Special case: if we are close to the bottom of the entire document, 
      // give priority to the last marker that is at least partially visible.
      // Increasing threshold to 150px for better resilience on high-res monitors.
      const isNearBottom = (viewportHeight + window.scrollY) >= (document.documentElement.scrollHeight - 150);

      // Heuristic: iterate markers and calculate how much vertical space each "page section" occupies in the viewport
      for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        const rect = marker.getBoundingClientRect();
        const nextMarker = markers[i + 1];

        // Start of this section (relative to viewport top)
        const start = rect.top;
        // End of this section (relative to viewport top). If no next marker, assume bottom of document/container
        // rect.top of next marker, or very large number
        const end = nextMarker ? nextMarker.getBoundingClientRect().top : 99999;

        // Intersection with viewport [0, viewportHeight]
        const visibleStart = Math.max(0, start);
        const visibleEnd = Math.min(viewportHeight, end);

        const visibleHeight = Math.max(0, visibleEnd - visibleStart);

        // Heuristic: If a page *starts* in the top 20% of the viewport, it's the active page
        // This fixes the "p55 -> p56" jump on load for short pages.
        // HOWEVER: If we are near the bottom of the document, we skip this early break 
        // to ensure the LAST visible marker (the actual last page) can be picked.
        if (!isNearBottom && start >= -50 && start < viewportHeight * 0.2) {
          activeMarker = marker;
          break; // Stop looking, we found the top-most page
        }

        if (isNearBottom && visibleHeight > 0) {
          activeMarker = marker; // Keep picking the last visible one as we loop
        } else if (visibleHeight > maxVisibleHeight) {
          maxVisibleHeight = visibleHeight;
          activeMarker = marker;
        }
      }

      const newPage = parseInt(activeMarker.dataset.pageStart);
      if (newPage !== infiniteState.visiblePage) {
        // Skip URL update if we are within the navigation grace period
        if (Date.now() < (infiniteState.navigationGracePeriod || 0)) {
           return;
        }

        // Update URL
        infiniteState.visiblePage = newPage;
        history.replaceState({}, '', buildUrl(newPage));

        // Update Pagination
        const paginationHtml = activeMarker.dataset.paginationHtml;
        if (paginationHtml) {
          document.querySelectorAll('.pagination-wrapper').forEach(el => el.innerHTML = paginationHtml);
        }
      }
    };

    // Initialize marker for the first page
    const initFirstPageMarker = () => {
      const firstItem = postsContainer.querySelector('a');
      const pag = document.querySelector('.pagination-wrapper');
      if (firstItem && !firstItem.dataset.pageStart) {
        firstItem.dataset.pageStart = infiniteState.currentPage;
        if (pag) firstItem.dataset.paginationHtml = pag.innerHTML;
      }
    };
    initFirstPageMarker();

    // Fetch and append more items
    const loadMoreItems = async () => {
      if (infiniteState.loading || !infiniteState.hasMore) return;
      if (isNavigating) return; // Don't load more while switching contexts

      const nextPage = infiniteState.currentPage + 1;
      // Check if we already loaded this page (prevent duplicates)
      if (infiniteState.loadedPages.has(nextPage)) {
        return;
      }



      infiniteState.loading = true;
      const foot = document.querySelector("div#footbar");
      if (foot) {
        foot.innerHTML = '<span class="loading-spinner"></span>';
        foot.style.color = 'var(--footbar-color)';
      }

      // nextPage already calculated above
      const ctx = getContext();

      const params = new URLSearchParams();
      params.append('page', nextPage);
      if (ctx.singleTag) params.append('tag', ctx.singleTag);
      if (ctx.hall) params.append('hall', ctx.hall);
      if (ctx.user) params.append('user', ctx.user);
      if (ctx.fav) params.append('fav', 'true');
      if (ctx.mime) params.append('mime', ctx.mime);

      const isStrict = window.f0ckSession?.strict_mode || (localStorage.getItem('search_strict') === 'true');
      if (document.cookie.includes('random_mode=1') || window.location.search.includes('random=1')) params.append('random', '1');
      if (isStrict) {
        params.append('strict', '1');
      }

      if (ctx.notif) {
        const notifTab = document.getElementById('notifications-container')?.dataset?.tab;
        if (notifTab) params.append('tab', notifTab);
      }

      const fetchUrl = ctx.notif ? `/ajax/notifications?${params.toString()}` :
        ctx.tags ? `/api/tags?ajax=true&${params.toString()}` :
          ctx.subs ? `/ajax/subscriptions?${params.toString()}` :
            `/ajax/items?${params.toString()}`;

      try {
        const response = await fetch(fetchUrl);
        const data = await response.json();

        if (data.success && data.html) {
          const currentPosts = postsContainer;
          if (currentPosts) {
            // Create elements from HTML string
            const temp = document.createElement('div');
            temp.innerHTML = data.html;
            const newItems = [...temp.children];

            if (newItems.length > 0) {
              // Mark the first item of the new page for URL updating
              const firstItem = newItems[0];
              if (firstItem) {
                firstItem.dataset.pageStart = data.currentPage;
                firstItem.dataset.paginationHtml = data.pagination;
              }


              // Append all new items
              newItems.forEach(item => currentPosts.appendChild(item));


              // Track loaded page
              infiniteState.loadedPages.add(data.currentPage);
              window.updateVisitIndicators();
              window.initLazyLoading();
            }
          }

          // Update state (last loaded page)
          infiniteState.currentPage = data.currentPage;
          infiniteState.hasMore = data.hasMore;


        } else {
          infiniteState.hasMore = false;
        }
      } catch (err) {
        console.error('Infinite scroll fetch error:', err);
      } finally {
        infiniteState.loading = false;
        if (foot) {
          if (infiniteState.hasMore) {
            foot.innerHTML = '&#9660;';
            foot.style.color = 'transparent';
          } else {
            const endMsg = foot.dataset.endMsg || '&#8212;';
            foot.innerHTML = endMsg;
            foot.style.color = 'var(--footbar-color, #888)';
          }
        }
      }
    };



    // Fetch and prepend previous items
    const loadPreviousItems = async () => {
      if (infiniteState.loadingUp || !infiniteState.hasPrev) return;
      if (isNavigating) return;

      const prevPage = infiniteState.firstPage - 1;
      // Check if we already loaded this page (prevent duplicates)
      if (infiniteState.loadedPages.has(prevPage)) {
        return;
      }



      infiniteState.loadingUp = true;
      const ctx = getContext();

      const params = new URLSearchParams();
      params.append('page', prevPage);
      if (ctx.singleTag) params.append('tag', ctx.singleTag);
      if (ctx.user) params.append('user', ctx.user);
      if (ctx.fav) params.append('fav', 'true');
      if (ctx.mime) params.append('mime', ctx.mime);

      const isStrict = window.f0ckSession?.strict_mode || (localStorage.getItem('search_strict') === 'true');
      if (document.cookie.includes('random_mode=1') || window.location.search.includes('random=1')) params.append('random', '1');
      if (isStrict) {
        params.append('strict', '1');
      }

      if (ctx.notif) {
        const notifTab = document.getElementById('notifications-container')?.dataset?.tab;
        if (notifTab) params.append('tab', notifTab);
      }

      const fetchUrl = ctx.notif ? `/ajax/notifications?${params.toString()}` :
        ctx.tags ? `/api/tags?ajax=true&${params.toString()}` :
          ctx.subs ? `/ajax/subscriptions?${params.toString()}` :
            `/ajax/items?${params.toString()}`;

      try {
        const response = await fetch(fetchUrl);
        const data = await response.json();

        // Capture height/scroll RIGHT BEFORE insertion to account for any user scrolling during fetch
        const oldHeight = postsContainer.scrollHeight;
        const oldScrollTop = window.scrollY;

        if (data.success && data.html) {
          const temp = document.createElement('div');
          temp.innerHTML = data.html;
          const newItems = [...temp.children];

          if (newItems.length > 0) {
            // Prepend items using DocumentFragment
            const fragment = document.createDocumentFragment();
            newItems.forEach(item => fragment.appendChild(item));

            // Mark the first item of the prepended page
            const firstItem = newItems[0];
            if (firstItem) {
              firstItem.dataset.pageStart = prevPage;
              firstItem.dataset.paginationHtml = data.pagination;
            }

            postsContainer.insertBefore(fragment, postsContainer.firstChild);

            // Track loaded page
            infiniteState.loadedPages.add(prevPage);
            window.updateVisitIndicators();
            window.initLazyLoading();

            // Restore scroll position
            const newHeight = postsContainer.scrollHeight;
            window.scrollTo(0, oldScrollTop + (newHeight - oldHeight));

            infiniteState.firstPage = prevPage;
            infiniteState.hasPrev = prevPage > 1;

          }
        } else {
          infiniteState.hasPrev = false;
        }
      } catch (err) {
        console.error('Infinite scroll (up) fetch error:', err);
      } finally {
        infiniteState.loadingUp = false;
      }
    };

    // Scroll detection - preload before reaching bottom
    const PRELOAD_OFFSET = 500; // pixels before bottom to trigger load

    const onScroll = () => {
      const currentContainer = postsContainer;
      // Only run if THIS container is the active one and still in DOM
      if (!currentContainer || !document.body.contains(currentContainer)) {
        window.removeEventListener('scroll', onScroll);
        return;
      }
      if (currentContainer.classList.contains('no-infinite-scroll')) return;
      if (!document.querySelector('#main')) return;

      updateUrlAndPagination();

      const scrollPosition = window.innerHeight + window.scrollY;
      const pageHeight = document.querySelector('#main').offsetHeight;
      const distanceFromBottom = pageHeight - scrollPosition;

      // Load more when within PRELOAD_OFFSET pixels of bottom
      if (distanceFromBottom < PRELOAD_OFFSET && infiniteState.hasMore && !infiniteState.loading) {
        loadMoreItems();
      }

      // Load previous when within PRELOAD_OFFSET pixels of top
      // Also ensure we aren't already at page 1
      if (window.scrollY < PRELOAD_OFFSET && infiniteState.hasPrev && !infiniteState.loadingUp) {
        loadPreviousItems();
      }

      infiniteState.lastScrollY = window.scrollY;
    };

    // Store scroll handler reference for cleanup
    postsContainer._scrollHandler = onScroll;
    window.addEventListener("scroll", onScroll);

    // Initial check (in case we loaded at top/bottom)
    setTimeout(onScroll, 100);
  };

  // Initial call on page load
  // Re-init logic
  const reinitAllInfiniteScroll = () => {
    document.querySelectorAll('div.posts, div.tags-grid, div.subs-grid').forEach(p => initInfiniteScroll(p));
  };

  reinitAllInfiniteScroll();
  // </infinite-scroll>
  // </infinite-scroll>



  // </visualizer> removed and moved to window.initVisualizer

  // <mediakeys>
  if (elem = document.querySelector("#my-video") && "mediaSession" in navigator) {
    const playpauseEvent = () => {
      video[video.paused ? 'play' : 'pause']();
      document.querySelector('.v0ck_overlay').classList[video.paused ? 'remove' : 'add']('v0ck_hidden');
    };
    navigator.mediaSession.setActionHandler('play', playpauseEvent);
    navigator.mediaSession.setActionHandler('pause', playpauseEvent);
    navigator.mediaSession.setActionHandler('stop', playpauseEvent);
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      if (link = document.querySelector(".pagination > .prev:not(.disabled)"))
        changePage(link);
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      if (link = document.querySelector(".pagination > .next:not(.disabled)"))
        changePage(link);
    });
  }
  // </mediakeys>

  // <scroller>

  // <search-overlay>
  const initSearch = () => {
    if (!document.getElementById('search-overlay')) {
      const i18n = window.f0ckI18n || {};
      const overlay = document.createElement('div');
      overlay.id = 'search-overlay';
      overlay.innerHTML = `
             <div id="search-close">&times;</div>
             <div class="search-container" style="width: 100%; display: flex; flex-direction: column; align-items: center;">
                <div style="width: 100%; max-width: 800px; position: relative;">
                    <input type="text" id="search-input" placeholder="${i18n.search_placeholder || 'Search Tags'}" autocomplete="off" enterkeyhint="search">
                    <div id="search-suggestions" class="tag-suggestions" style="display: none; top: 100% !important; bottom: auto !important; left: 0 !important; right: 0 !important; min-width: unset !important; max-width: none !important; z-index: 10001 !important;"></div>
                </div>
                <label class="strict-toggle" style="margin-top: 20px;">
                    <input type="checkbox" id="search-strict"> ${i18n.search_strict_mode || 'Strict Mode'}
                </label>
             </div>
         `;
      document.body.appendChild(overlay);

      const input = document.getElementById('search-input');
      const close = document.getElementById('search-close');
      const strict = document.getElementById('search-strict');
      const suggestions = document.getElementById('search-suggestions');
      const btns = document.querySelectorAll('#nav-search-btn');

      let debounceTimer = null;
      let highlightIdx = -1;

      const doSearch = () => {
        let val = input.value.trim();
        // Remove trailing commas and extra whitespace
        val = val.replace(/,+$/, '').trim();
        if (val) {
          toggleSearch(false);
          let targetUrl = `/tag/${encodeURIComponent(val).replace(/%2C/g, ',').replace(/%20/g, ' ')}`;
          // Use AJAX for faster transition and clean URL
          if (typeof loadPageAjax === 'function') {
            loadPageAjax(targetUrl, true);
          } else {
            window.location.href = targetUrl;
          }
        }
      };

      const renderSuggestions = (tagItems, titleItems) => {
        suggestions.innerHTML = '';
        highlightIdx = -1;
        const totalItems = (tagItems || []).length + (titleItems || []).length;
        if (!totalItems) {
          suggestions.style.display = 'none';
          return;
        }

        const addSectionHeader = (label) => {
          const hdr = document.createElement('div');
          hdr.className = 'tag-suggestion-header';
          hdr.textContent = label;
          suggestions.appendChild(hdr);
        };

        // --- Tag results ---
        if (tagItems && tagItems.length) {
          if (titleItems && titleItems.length) addSectionHeader('Tags');
          tagItems.forEach(s => {
            const div = document.createElement('div');
            div.className = 'tag-suggestion-item';
            div.dataset.type = 'tag';
            div.dataset.value = s.tag;

            const name = document.createElement('span');
            name.className = 'tag-suggestion-name';
            name.textContent = s.tag;

            const meta = document.createElement('span');
            meta.className = 'tag-suggestion-meta';
            meta.textContent = `${s.tagged}× · ${s.score.toFixed(2)}`;

            div.appendChild(name);
            div.appendChild(meta);

            div.addEventListener('mousedown', (e) => {
              e.preventDefault();
              const isStrict = strict && strict.checked;
              if (isStrict) {
                const parts = input.value.split(',');
                parts[parts.length - 1] = s.tag;
                input.value = parts.join(',') + ',';
              } else {
                input.value = s.tag;
              }
              suggestions.style.display = 'none';
              highlightIdx = -1;
              input.focus();
            });
            suggestions.appendChild(div);
          });
        }

        // --- Title results ---
        if (titleItems && titleItems.length) {
          if (tagItems && tagItems.length) addSectionHeader('Titles');
          titleItems.forEach(s => {
            const div = document.createElement('div');
            div.className = 'tag-suggestion-item tag-suggestion-item--title';
            div.dataset.type = 'title';
            div.dataset.id = s.id;
            div.dataset.title = s.title;

            const icon = document.createElement('span');
            icon.className = 'tag-suggestion-icon';
            icon.innerHTML = '<i class="fa-regular fa-file" aria-hidden="true"></i>';

            const name = document.createElement('span');
            name.className = 'tag-suggestion-name';
            name.textContent = s.title.length > 60 ? s.title.substring(0, 60) + '…' : s.title;

            const meta = document.createElement('span');
            meta.className = 'tag-suggestion-meta';
            meta.textContent = `#${s.id}`;

            div.appendChild(icon);
            div.appendChild(name);
            div.appendChild(meta);

            div.addEventListener('mousedown', (e) => {
              e.preventDefault();
              suggestions.style.display = 'none';
              highlightIdx = -1;
              toggleSearch(false);
              const target = `/tag/title:${encodeURIComponent(s.title)}/`;
              if (typeof loadPageAjax === 'function') {
                loadPageAjax(target, true);
              } else {
                window.location.href = target;
              }
            });
            suggestions.appendChild(div);
          });
        }

        suggestions.style.display = 'block';
      };

      input.addEventListener('input', () => {
        const isStrict = strict && strict.checked;
        const q = isStrict ? input.value.split(',').pop().trim() : input.value.trim();
        highlightIdx = -1;
        if (q.length < 1) {
          suggestions.style.display = 'none';
          return;
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            const [tagRes, titleRes] = await Promise.all([
              fetch(`/api/v2/tags/suggest?q=${encodeURIComponent(q)}`).then(r => r.json()).catch(() => ({ success: false })),
              fetch(`/api/v2/items/suggest?q=${encodeURIComponent(q)}`).then(r => r.json()).catch(() => ({ success: false }))
            ]);
            const tagSuggestions = (tagRes.success && tagRes.suggestions) ? tagRes.suggestions.slice(0, 6) : [];
            const titleSuggestions = (titleRes.success && titleRes.suggestions) ? titleRes.suggestions.slice(0, 4) : [];
            if (tagSuggestions.length || titleSuggestions.length) {
              renderSuggestions(tagSuggestions, titleSuggestions);
            } else {
              suggestions.style.display = 'none';
            }
          } catch (e) {
            suggestions.style.display = 'none';
          }
        }, 300);
      });

      input.addEventListener('keydown', e => {
        const items = suggestions.querySelectorAll('.tag-suggestion-item');
        if (!items.length || suggestions.style.display === 'none') return;

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (highlightIdx >= 0 && highlightIdx < items.length) items[highlightIdx].classList.remove('active');
          highlightIdx = highlightIdx < items.length - 1 ? highlightIdx + 1 : 0;
          items[highlightIdx].classList.add('active');
          items[highlightIdx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (highlightIdx >= 0 && highlightIdx < items.length) items[highlightIdx].classList.remove('active');
          highlightIdx = highlightIdx > 0 ? highlightIdx - 1 : items.length - 1;
          items[highlightIdx].classList.add('active');
          items[highlightIdx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Escape') {
          suggestions.style.display = 'none';
          highlightIdx = -1;
          e.stopPropagation();
        }
      });

      input.addEventListener('blur', () => {
        setTimeout(() => { suggestions.style.display = 'none'; }, 150);
      });

      // Load strict preference
      const savedStrict = localStorage.getItem('search_strict') === 'true';
      if (strict) strict.checked = savedStrict;

      const toggleSearch = (show) => {
        if (show) {
          overlay.style.display = 'flex';
          // Force reflow
          overlay.offsetHeight;
          overlay.classList.add('visible');
          if (window.innerWidth > 768) input.focus();
        } else {
          overlay.classList.remove('visible');
          suggestions.style.display = 'none';
          setTimeout(() => {
            overlay.style.display = 'none';
          }, 200);
        }
      };

      btns.forEach(btn => btn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleSearch(true);
      }));

      close.addEventListener('click', () => toggleSearch(false));

      if (strict) {
        // Init state from server if available, else localStorage
        if (window.f0ckSession && window.f0ckSession.logged_in && typeof window.f0ckSession.strict_mode !== 'undefined') {
          strict.checked = window.f0ckSession.strict_mode;
          localStorage.setItem('search_strict', strict.checked); // Sync local
        } else {
          strict.checked = localStorage.getItem('search_strict') === 'true';
        }

        // Helper to visualy toggle strict parameter on tag links
        window.updateStrictLinks = (isStrict) => {
          document.querySelectorAll('a[href*="/tag/"]').forEach(a => {
            let href = a.getAttribute('href');
            if (href && (href.startsWith('/tag/') || href.includes(window.location.origin + '/tag/'))) {
              if (isStrict) {
                if (!href.includes('strict=1')) {
                  href += (href.includes('?') ? '&' : '?') + 'strict=1';
                }
              } else {
                if (href.includes('strict=1')) {
                  href = href.replace(/[?&]strict=1/, '').replace(/[?&]$/, '');
                }
              }
              a.setAttribute('href', href);
            }
          });
        };

        // Init placeholder and links
        if (strict.checked) {
          input.placeholder = "tag1, tag2...";
          window.updateStrictLinks(true);
        }

        strict.addEventListener('change', () => {
          localStorage.setItem('search_strict', strict.checked);
          if (window.f0ckSession) window.f0ckSession.strict_mode = strict.checked;

          window.updateStrictLinks(strict.checked);

          // Sync with server
          fetch('/strict/' + (strict.checked ? 1 : 0));

          if (strict.checked) {
            input.placeholder = "tag1, tag2...";
          } else {
            input.placeholder = "Search Tags...";
          }
        });
      }

      // Close on click outside (background)
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) toggleSearch(false);
      });

      // ESC to close
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('visible')) {
          toggleSearch(false);
        }
        // "k" to open
        if (e.key === 'k' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && !overlay.classList.contains('visible')) {
          e.preventDefault();
          toggleSearch(true);
        }
        // Shift + S to toggle strict mode globally
        if (e.shiftKey && (e.key === 'S' || e.key === 's') && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          if (strict) strict.click();
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          // If a suggestion is highlighted, use it
          if (highlightIdx >= 0) {
            const items = suggestions.querySelectorAll('.tag-suggestion-item');
            if (items[highlightIdx]) {
              const el = items[highlightIdx];
              // Title results: go to the search page showing all items with this title
              if (el.dataset.type === 'title') {
                suggestions.style.display = 'none';
                highlightIdx = -1;
                toggleSearch(false);
                const target = `/tag/title:${encodeURIComponent(el.dataset.title)}/`;
                if (typeof loadPageAjax === 'function') {
                  loadPageAjax(target, true);
                } else {
                  window.location.href = target;
                }
                return;
              }
              // Tag results: fill input
              const selectedTag = el.querySelector('.tag-suggestion-name').textContent;
              const isStrict = strict && strict.checked;
              if (isStrict) {
                const parts = input.value.split(',');
                parts[parts.length - 1] = selectedTag;
                input.value = parts.join(',') + ',';
              } else {
                input.value = selectedTag;
              }
              highlightIdx = -1;
              suggestions.style.display = 'none';
              return;
            }
          }
          // Snapshot before hiding — if there are only title matches and no tag matches,
          // go to the title search page instead of a futile tag search.
          const tagItems   = suggestions.querySelectorAll('.tag-suggestion-item[data-type="tag"]');
          const titleItems = suggestions.querySelectorAll('.tag-suggestion-item[data-type="title"]');
          suggestions.style.display = 'none';
          if (tagItems.length === 0 && titleItems.length > 0) {
            toggleSearch(false);
            const q = input.value.trim();
            const target = `/tag/title:${encodeURIComponent(q)}/`;
            if (typeof loadPageAjax === 'function') {
              loadPageAjax(target, true);
            } else {
              window.location.href = target;
            }
            return;
          }
          doSearch();
        }
      });
    }
  };
  const initExcludedTagsModal = () => {
    if (window.f0ckSession && !window.f0ckSession.logged_in) return;

    const overlay = document.getElementById('excluded-tags-overlay');
    if (!overlay) return;

    const input = document.getElementById('nav_exclude_tag_input');
    const close = document.getElementById('excluded-tags-close');

    const list = document.getElementById('nav_excluded_tags_list');
    const suggestions = document.getElementById('nav_exclude_suggestions');
    const filterBtn = document.getElementById('nav-filter-btn');

    const toggleModal = (show) => {
      if (show) {
        overlay.style.display = 'flex';
        overlay.offsetHeight;
        overlay.classList.add('visible');
        document.body.style.overflow = 'hidden';
        renderTags();
        if (window.innerWidth > 768) input.focus();
      } else {
        overlay.classList.remove('visible');
        document.body.style.overflow = '';
        suggestions.style.display = 'none';
        setTimeout(() => {
          overlay.style.display = 'none';
        }, 200);
      }
    };

    const renderTags = async () => {
      try {
        const res = await fetch('/api/v2/settings/excluded_tags');
        const data = await res.json();
        if (data.success) {
          list.innerHTML = '';
          if (data.tags.length === 0) {
            list.innerHTML = `<em style="color: #666;">${(window.f0ckI18n && window.f0ckI18n.no_tags_excluded) || 'No tags excluded'}</em>`;
          }
          data.tags.forEach(tag => {
            const span = document.createElement('span');
            span.className = 'badge badge-secondary';
            span.style.cssText = 'padding: 5px 12px; border-radius: 20px; background: rgba(255,255,255,0.1); display: flex; align-items: center; gap: 8px; font-size: 0.9em;';
            const removeLink = document.createElement('a');
            removeLink.href = '#';
            removeLink.className = 'remove-excluded-tag';
            removeLink.dataset.tag = tag.normalized;
            removeLink.style.color = '#ff4444';
            removeLink.style.textDecoration = 'none';
            removeLink.style.fontWeight = 'bold';
            removeLink.style.fontSize = '1.2em';
            removeLink.style.lineHeight = '1';
            removeLink.innerHTML = '&times;';

            span.textContent = tag.tag + ' ';
            span.appendChild(removeLink);
            list.appendChild(span);
          });
        }
      } catch (e) {
        console.error('Failed to load excluded tags', e);
      }
    };

    if (filterBtn) {
      filterBtn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleModal(true);
      });
    }

    close.addEventListener('click', () => toggleModal(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) toggleModal(false);
    });

    const addTag = async () => {
      const tagname = input.value.trim();
      if (!tagname) return;
      suggestions.style.display = 'none';
      try {
        const res = await fetch('/api/v2/settings/excluded_tags', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            tagname
          })
        });
        const data = await res.json();
        if (data.success) {
          renderTags();
          input.value = '';
        } else {
          window.flashMessage(data.msg || 'Error adding tag', 3000, 'error');
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (window.innerWidth > 768) input.focus();
      }
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // If a suggestion is highlighted, use it
        if (highlightIdx >= 0) {
          const items = suggestions.querySelectorAll('.tag-suggestion-item');
          if (items[highlightIdx]) {
            input.value = items[highlightIdx].querySelector('.tag-suggestion-name').textContent;
          }
        }
        suggestions.style.display = 'none';
        addTag();
      }
    });

    list.addEventListener('click', async e => {
      if (e.target.classList.contains('remove-excluded-tag')) {
        e.preventDefault();
        const tag = e.target.getAttribute('data-tag');
        try {
          const res = await fetch(`/api/v2/settings/excluded_tags/${encodeURIComponent(tag)}`, {
            method: 'DELETE'
          });
          const data = await res.json();
          if (data.success) renderTags();
        } catch (e) {
          console.error(e);
        }
      }
    });

    // Autocomplete with dropdown suggestions
    let debounceTimer = null;
    let highlightIdx = -1;

    const renderSuggestions = (items) => {
      suggestions.innerHTML = '';
      highlightIdx = -1;
      if (!items.length) {
        suggestions.style.display = 'none';
        return;
      }
      items.forEach(s => {
        const div = document.createElement('div');
        div.className = 'tag-suggestion-item';

        const name = document.createElement('span');
        name.className = 'tag-suggestion-name';
        name.textContent = s.tag;

        const meta = document.createElement('span');
        meta.className = 'tag-suggestion-meta';
        meta.textContent = `${s.tagged}× · ${s.score.toFixed(2)}`;

        div.appendChild(name);
        div.appendChild(meta);

        div.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = s.tag;
          suggestions.style.display = 'none';
          addTag();
        });
        suggestions.appendChild(div);
      });
      suggestions.style.display = 'block';
    };

    input.addEventListener('input', () => {
      const q = input.value.trim();
      highlightIdx = -1;
      if (q.length < 1) {
        suggestions.style.display = 'none';
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/v2/tags/suggest?q=${encodeURIComponent(q)}`);
          const json = await res.json();
          if (json.success && json.suggestions) {
            renderSuggestions(json.suggestions.slice(0, 8));
          } else {
            suggestions.style.display = 'none';
          }
        } catch (e) {
          suggestions.style.display = 'none';
        }
      }, 300);
    });

    input.addEventListener('keydown', e => {
      const items = suggestions.querySelectorAll('.tag-suggestion-item');
      if (!items.length || suggestions.style.display === 'none') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (highlightIdx >= 0 && highlightIdx < items.length) items[highlightIdx].classList.remove('active');
        highlightIdx = highlightIdx < items.length - 1 ? highlightIdx + 1 : 0;
        items[highlightIdx].classList.add('active');
        items[highlightIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (highlightIdx >= 0 && highlightIdx < items.length) items[highlightIdx].classList.remove('active');
        highlightIdx = highlightIdx > 0 ? highlightIdx - 1 : items.length - 1;
        items[highlightIdx].classList.add('active');
        items[highlightIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Escape') {
        suggestions.style.display = 'none';
        highlightIdx = -1;
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => { suggestions.style.display = 'none'; }, 150);
    });

    // ESC to close, "e" to open
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('visible')) {
        toggleModal(false);
      }
      // 'e' opens the filter modal on non-/abyss pages
      if (e.key === 'e' || e.key === 'E') {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
        if (window.location.pathname.startsWith('/abyss')) return;
        e.preventDefault();
        toggleModal(!overlay.classList.contains('visible'));
      }
    });

    // ── xD Score filter ────────────────────────────────────────────────────
    const navXdInput         = document.getElementById('nav_min_xd_score');
    const navXdSaveBtn        = document.getElementById('nav_xd_save_btn');
    const navXdTier           = document.getElementById('nav_xd_tier_label');
    const navXdStatus         = document.getElementById('nav_xd_status');
    const navXdVal            = document.getElementById('nav_xd_val');
    const navXdSliderContainer = document.getElementById('nav_xd_slider_container');
    let   navXdCustomFill     = null; // set during custom slider init below

    const XD_TIERS_NAV = [null,
      { cls: 'xd-tier-1', label: 'xD' },
      { cls: 'xd-tier-2', label: 'xDD' },
      { cls: 'xd-tier-3', label: 'xDDD' },
      { cls: 'xd-tier-4', label: 'xDDDD' },
      { cls: 'xd-tier-5', label: 'xDDDDD+' },
    ];
    const getNavXdTier = (s) => {
      s = +s;
      if (s < 1)           return 0;
      if (s < 200)         return 1;
      if (s < 1000)        return 2;
      if (s < 100000)      return 3;
      if (s < 200000000)   return 4;
      return 5;
    };
    const XD_TIER_COLORS = ['#888', '#5a9e5a', '#8ac449', '#d4a017', '#e07b2a', '#ff5500'];
    const updateNavXdUI = (score) => {
      score = +score;
      if (navXdVal) navXdVal.textContent = score;
      const tier = getNavXdTier(score);
      const color = XD_TIER_COLORS[tier];
      // Update custom slider fill colour
      if (navXdCustomFill) navXdCustomFill.style.background = color;
      if (navXdVal) navXdVal.style.color = color;
      // Keep hidden native input in sync (save button reads it)
      if (navXdInput) navXdInput.value = score;
      if (!navXdTier) return;
      if (!tier || score <= 0) { navXdTier.style.display = 'none'; return; }
      const t = XD_TIERS_NAV[tier];
      navXdTier.className = `xd-score-badge ${t.cls}`;
      navXdTier.textContent = `≥ ${score} · ${t.label}`;
      navXdTier.style.display = 'inline-flex';
    };

    if (navXdInput) {
      updateNavXdUI(+navXdInput.value);
    }

    // Custom mobile-friendly slider for xD score
    if (navXdInput && navXdSliderContainer) {
      const xdMin = 0, xdMax = +navXdInput.max || 100;
      const xdContainer = navXdSliderContainer;
      xdContainer.style.cssText = 'position:relative;height:28px;flex:1;cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;';

      const xdTrack = document.createElement('div');
      xdTrack.style.cssText = 'position:absolute;left:8px;right:8px;height:4px;background:#333;border-radius:2px;top:50%;transform:translateY(-50%);';

      const xdFill = document.createElement('div');
      xdFill.style.cssText = 'position:absolute;left:0;height:100%;background:#888;border-radius:2px;pointer-events:none;';
      navXdCustomFill = xdFill;

      const xdThumb = document.createElement('div');
      xdThumb.style.cssText = 'position:absolute;width:18px;height:18px;background:#888;border-radius:50%;top:50%;transform:translate(-50%,-50%);box-shadow:0 0 6px rgba(0,0,0,.6);pointer-events:none;transition:transform .1s;';

      const xdSetRatio = (r) => {
        xdFill.style.width  = (r * 100) + '%';
        xdThumb.style.left  = `calc(8px + ${r} * (100% - 16px))`;
      };
      xdSetRatio((+navXdInput.value - xdMin) / (xdMax - xdMin));

      xdTrack.appendChild(xdFill);
      xdContainer.appendChild(xdTrack);
      xdContainer.appendChild(xdThumb);

      const xdValueFromClientX = (clientX) => {
        const rect = xdTrack.getBoundingClientRect();
        const r    = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        xdSetRatio(r);
        return Math.round(xdMin + r * (xdMax - xdMin));
      };

      xdContainer.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        xdContainer.setPointerCapture(e.pointerId);
        xdThumb.style.transform = 'translate(-50%,-50%) scale(1.25)';
        updateNavXdUI(xdValueFromClientX(e.clientX));
        // also tint thumb with current tier colour
        xdThumb.style.background = XD_TIER_COLORS[getNavXdTier(+navXdInput.value)];
      }, { passive: false });

      xdContainer.addEventListener('pointermove', (e) => {
        if (!xdContainer.hasPointerCapture(e.pointerId)) return;
        const val = xdValueFromClientX(e.clientX);
        xdThumb.style.background = XD_TIER_COLORS[getNavXdTier(val)];
        updateNavXdUI(val);
      });

      const xdOnEnd = (e) => {
        if (!xdContainer.hasPointerCapture(e.pointerId)) return;
        xdContainer.releasePointerCapture(e.pointerId);
        xdThumb.style.transform = 'translate(-50%,-50%) scale(1)';
      };
      xdContainer.addEventListener('pointerup',     xdOnEnd);
      xdContainer.addEventListener('pointercancel', xdOnEnd);

      // Sync thumb colour on init
      updateNavXdUI(+navXdInput.value);
      xdThumb.style.background = XD_TIER_COLORS[getNavXdTier(+navXdInput.value)];
    }

    if (navXdSaveBtn && navXdInput) {
      navXdSaveBtn.addEventListener('click', async () => {
        const min_xd_score = parseInt(navXdInput.value, 10) || 0;
        navXdSaveBtn.disabled = true;
        navXdSaveBtn.textContent = '...';
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
            if (window.f0ckSession) window.f0ckSession.min_xd_score = min_xd_score;
            if (navXdStatus) {
              navXdStatus.textContent = min_xd_score > 0 ? `✓ Filter active — xD ≥ ${min_xd_score}` : '✓ Disabled';
              setTimeout(() => { navXdStatus.textContent = ''; }, 3000);
            }
            // Reload grid to apply filter
            toggleModal(false);
            if (typeof loadPageAjax === 'function') loadPageAjax(window.location.pathname);
            else window.location.reload();
          } else {
            window.flashMessage(data.msg || 'Error saving', 3000, 'error');
          }
        } catch (err) {
          window.flashMessage('Failed to save xD filter', 3000, 'error');
        } finally {
          navXdSaveBtn.disabled = false;
          navXdSaveBtn.textContent = 'Save';
        }
      });
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    initSearch();
    initExcludedTagsModal();
    if (window.updateFilterBadge) window.updateFilterBadge();
  });
  // </search-overlay>

  // <random-mode>
  const updateRandomModeUI = () => {
    const isRandom = document.cookie.includes('random_mode=1');
    document.querySelectorAll('.shuffle-btn').forEach(btn => {
      if (isRandom) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    if (window.updateFilterBadge) window.updateFilterBadge();
  };

  const handleShuffleBtnClick = (btn) => {
    // Trigger spin animation
    btn.classList.add('is-shuffling');
    setTimeout(() => btn.classList.remove('is-shuffling'), 450);

    const isCurrentlyRandom = document.cookie.includes('random_mode=1');
    
    // Toggle cookie (expires in 30 days)
    if (isCurrentlyRandom) {
        document.cookie = "random_mode=0; path=/; max-age=" + (60 * 60 * 24 * 30);
    } else {
        document.cookie = "random_mode=1; path=/; max-age=" + (60 * 60 * 24 * 30);
    }

    updateRandomModeUI();
    window.flashMessage(isCurrentlyRandom ? ((window.f0ckI18n && window.f0ckI18n.zomg_off) || 'ZOMG Mode deactivated') : ((window.f0ckI18n && window.f0ckI18n.zomg_on) || 'ZOMG Mode activated'));

    // Clear grid cache when switching random mode to prevent showing non-randomized versions
    if (typeof gridCacheMap !== 'undefined') {
        gridCacheMap.clear();
    }

    // Reload content to apply new order
    // If on item view, we just stay here but next/prev links will be random in next fetches
    // If on grid view, we reload the grid
    const postsEl = document.querySelector('.posts');
    if (postsEl) {
        // Grid view: reload current page with random flag
        loadPageAjax(window.location.pathname);
    } else {
        // Item view: reload current item with forced random flag to ensure next/prev update correctly
        const url = new URL(window.location.href);
        if (!isCurrentlyRandom) url.searchParams.set('random', '1');
        else url.searchParams.delete('random');
        loadItemAjax(url.toString(), true, { keepMedia: true });
    }
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.shuffle-btn');
    if (btn) {
      e.preventDefault();
      handleShuffleBtnClick(btn);
    }
  });

  document.addEventListener('f0ck:contentLoaded', () => {
    updateRandomModeUI();
  });

  // Initialize UI on startup
  updateRandomModeUI();
  // </random-mode>

  // <xd-score-live-update>
  // updateXdBadgeFromScore: called by the SSE handler with the server-authoritative xd_score.
  // Updates:
  //   1. The item-page badge (if the user is currently viewing that item)
  //   2. Any grid thumbnail indicators for that item (on any page)
  const XD_TIER_META = [
    null,
    { cls: 'xd-tier-1', label: 'xD',      min: 1         },
    { cls: 'xd-tier-2', label: 'xDD',     min: 200       },
    { cls: 'xd-tier-3', label: 'xDDD',    min: 1000      },
    { cls: 'xd-tier-4', label: 'xDDDD',   min: 100000    },
    { cls: 'xd-tier-5', label: 'xDDDDD+', min: 200000000 },
  ];

  const getXdTierFromScore = (score) => {
    if (score < 1)           return 0;
    if (score < 200)         return 1;
    if (score < 1000)        return 2;
    if (score < 100000)      return 3;
    if (score < 200000000)   return 4;
    return 5;
  };

  // Update the thumbnail grid indicator for a specific item
  const updateThumbXdIndicator = (itemId, score) => {
    const thumbs = document.querySelectorAll(`a.thumb[href$="/${itemId}"], a.lazy-thumb[href$="/${itemId}"]`);
    thumbs.forEach(thumb => {
      const indicators = thumb.querySelector('.thumb-indicators');
      if (!indicators) return;

      // Remove existing indicator
      indicators.querySelectorAll('.thumb-xd-indicator').forEach(el => el.remove());

      if (score <= 0) return;

      const tier = getXdTierFromScore(score);
      const span = document.createElement('span');
      span.className = `thumb-xd-indicator xd-tier-${tier}`;
      span.title = `xD Score: ${score}`;
      span.textContent = 'xD';
      indicators.appendChild(span);
    });
  };

  // Update the item-view badge (only when viewing that item)
  const updateItemPageXdBadge = (itemId, score) => {
    const container = document.getElementById('comments-container');
    if (!container) return;
    const pageItemId = container.dataset.itemId;
    if (pageItemId && String(pageItemId) !== String(itemId)) return;

    document.querySelectorAll('.xd-score-wrapper').forEach(w => w.remove());

    if (score <= 0) return;

    const tier = getXdTierFromScore(score);
    const meta = XD_TIER_META[tier];
    const newWrapper = document.createElement('div');
    newWrapper.className = 'xd-score-wrapper';
    newWrapper.innerHTML = `<span class="xd-score-badge ${meta.cls}" tooltip="xD Score: ${score} pts" flow="up">${meta.label} <span class="xd-score-num">${score}</span></span>`;

    // Insert inside container, before .comments-list — matching the position
    // that comments.js uses after each render.
    const commentsList = container.querySelector('.comments-list');
    if (commentsList) {
      container.insertBefore(newWrapper, commentsList);
    } else {
      container.parentNode.insertBefore(newWrapper, container);
    }
  };

  window.updateXdBadgeFromScore = (itemId, score) => {
    if (window.f0ckSession && window.f0ckSession.enable_xd_score === false) return;
    updateItemPageXdBadge(itemId, score);
    updateThumbXdIndicator(itemId, score);
  };
  // </xd-score-live-update>

  const swipeRT = {
    xDown: null,
    yDown: null,
    xDiff: null,
    yDiff: null,
    timeDown: null,
    startEl: null,
    isDraggingSidebar: false,
    isSidebarCandidate: false,  // Touch started in sidebar zone but not yet committed
    sidebarWidth: 280,
    sidebarEl: null,
    _steuerungPreventedTarget: null, // iOS Safari: target whose touchstart we preventDefault'd
  };
  const swipeOpt = {
    treshold: 20, // 20px
    timeout: 500  // 500ms
  };

  document.addEventListener('touchstart', e => {
    if (window.f0ckSession?.disable_swiping) return;
    if (document.body.classList.contains('modal-open')) return;
    
    const touch = e.touches[0];
    swipeRT.startEl = e.target;
    swipeRT.timeDown = Date.now();
    swipeRT.xDown = touch.clientX;
    swipeRT.yDown = touch.clientY;
    swipeRT.xDiff = 0;
    swipeRT.yDiff = 0;
    swipeRT.isDraggingSidebar = false;
    swipeRT.startedInSidebarZone = false;

    // Coordinate-based steuerung detection — more reliable than e.target.closest() on iOS Safari
    // where e.target can be misreported for touch events on complex DOM hierarchies
    const steuerungEl = document.querySelector('.steuerung');
    if (steuerungEl) {
      const sr = steuerungEl.getBoundingClientRect();
      const touch0 = e.touches[0];
      swipeRT.startedInSteuerung = (
        touch0.clientX >= sr.left && touch0.clientX <= sr.right &&
        touch0.clientY >= sr.top  && touch0.clientY <= sr.bottom
      );
    } else {
      swipeRT.startedInSteuerung = false;
    }

    // Mobile Sidebar Drag Logic
    if (window.innerWidth < 1000) {
      const sidebar = document.querySelector('.global-sidebar-right, .item-sidebar-right, .index-sidebar-right');
      if (sidebar) {
        swipeRT.sidebarEl = sidebar;
        swipeRT.sidebarWidth = sidebar.offsetWidth;
        const isHidden = document.body.classList.contains('sidebar-right-hidden');
        
        // Mark as candidate — direction will be confirmed on first touchmove
        if (isHidden) {
          // Only set sidebar candidate if NOT starting inside .steuerung
          if (touch.clientX > window.innerWidth - 100 && !swipeRT.startedInSteuerung) {
            swipeRT.isSidebarCandidate = true;
            swipeRT.startedInSidebarZone = true;
          }
        } else {
          // Sidebar is open: candidate if touch starts inside sidebar bounding box
          // Use coordinates, not e.target — iOS Safari can mis-report target in scrollable containers
          if (!swipeRT.startedInSteuerung) {
            const sr = sidebar.getBoundingClientRect();
            if (touch.clientX >= sr.left && touch.clientX <= sr.right &&
                touch.clientY >= sr.top  && touch.clientY <= sr.bottom) {
              swipeRT.isSidebarCandidate = true;
              swipeRT.startedInSidebarZone = true;
            }
          }
        }
      }
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (window.f0ckSession?.disable_swiping) return;
    if (document.body.classList.contains('modal-open')) return;
    if (!swipeRT.xDown || !swipeRT.yDown) return;

    const touch = e.touches[0];
    swipeRT.xDiff = swipeRT.xDown - touch.clientX;
    swipeRT.yDiff = swipeRT.yDown - touch.clientY;

    // Determine sidebar drag direction on first significant movement
    if (swipeRT.isSidebarCandidate && !swipeRT.isDraggingSidebar && swipeRT.sidebarEl) {
      const absX = Math.abs(swipeRT.xDiff);
      const absY = Math.abs(swipeRT.yDiff);

      // iOS Safari: claim the gesture early — the moment horizontal >= vertical,
      // call preventDefault to prevent iOS from locking this as a vertical scroll.
      // With touch-action:pan-y on the sidebar, horizontal touchmoves are cancellable.
      if (absX >= absY && absX > 2 && e.cancelable) {
        e.preventDefault();
      }

      // Require at least 12px horizontal AND horizontal clearly dominates (2.5x more than vertical)
      if (absX >= 12 && absX > absY * 2.5) {
        swipeRT.isDraggingSidebar = true;
        swipeRT.isSidebarCandidate = false;
      } else if (absY > absX * 1.5) {
        // Clearly scrolling vertically — cancel sidebar drag entirely
        swipeRT.isSidebarCandidate = false;
      }
    }

    if (swipeRT.isDraggingSidebar && swipeRT.sidebarEl) {
      if (e.cancelable) e.preventDefault();
      
      const isHidden = document.body.classList.contains('sidebar-right-hidden');
      
      // xDiff > 0: dragging left (opening)
      // xDiff < 0: dragging right (closing)
      let dragX = swipeRT.xDiff;
      
      if (isHidden) {
        // Limit: can only drag left (up to sidebarWidth)
        dragX = Math.max(0, Math.min(swipeRT.sidebarWidth, dragX));
      } else {
        // Limit: can only drag right (down to -sidebarWidth)
        dragX = Math.max(-swipeRT.sidebarWidth, Math.min(0, dragX));
      }
      
      // Apply transform: translateX(-dragX) moves left if positive, right if negative
      const transform = `translateX(${-dragX}px)`;
      swipeRT.sidebarEl.style.transition = 'none';
      swipeRT.sidebarEl.style.transform = transform;
      return;
    }

    // Prevent scrolling if swiping horizontally
    if (Math.abs(swipeRT.xDiff) > Math.abs(swipeRT.yDiff)) {
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('touchend', e => {
    if (window.f0ckSession?.disable_swiping) return;
    if (document.body.classList.contains('modal-open')) return;
    const timeDiff = Date.now() - swipeRT.timeDown;
    let elem;

    if (swipeRT.isDraggingSidebar && swipeRT.sidebarEl) {
      const sidebar = swipeRT.sidebarEl;
      const isHidden = document.body.classList.contains('sidebar-right-hidden');
      const dist = Math.abs(swipeRT.xDiff);
      const threshold = swipeRT.sidebarWidth / 4;
      const quickSwipe = dist > 30 && timeDiff < 250;

      let shouldOpen = !isHidden;
      if (isHidden) {
        if (swipeRT.xDiff > threshold || (swipeRT.xDiff > 30 && quickSwipe)) {
          shouldOpen = true;
        }
      } else {
        if (swipeRT.xDiff < -threshold || (swipeRT.xDiff < -30 && quickSwipe)) {
          shouldOpen = false;
        }
      }

      const stateChanging = shouldOpen !== !isHidden;

      // Target transform positions:
      // When OPEN (right:0): stay=translateX(0), close=translateX(+width)
      // When HIDDEN (right:-width): stay=translateX(0), open=translateX(-width)
      // These match the CSS resting positions once transform is cleared and class is toggled.
      let targetTranslate;
      if (isHidden) {
        targetTranslate = shouldOpen ? -swipeRT.sidebarWidth : 0;
      } else {
        targetTranslate = shouldOpen ? 0 : swipeRT.sidebarWidth;
      }

      // Use !important to override the CSS's own "transition: right 0.3s !important"
      // so that our transform animation actually plays.
      sidebar.style.setProperty('transition', 'transform 0.3s ease-in-out', 'important');
      sidebar.style.transform = `translateX(${targetTranslate}px)`;

      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;

        // Freeze all transitions (override CSS !important) so the class toggle
        // doesn't trigger an additional right-property animation.
        sidebar.style.setProperty('transition', 'none', 'important');

        if (stateChanging) {
          const toHidden = !shouldOpen;
          document.body.classList.toggle('sidebar-right-hidden', toHidden);
          localStorage.setItem('sidebarRightHidden', toHidden);
        }

        // Force reflow so class change commits with no transition
        void sidebar.offsetWidth;

        // Clear transform — sidebar is now exactly where CSS says it should be
        sidebar.style.transform = '';

        // Restore CSS-controlled transitions on the next frame
        requestAnimationFrame(() => {
          sidebar.style.removeProperty('transition');
          swipeRT.isDraggingSidebar = false;
        });
      };

      // Filter by propertyName so we only act on the transform transition,
      // not any other transitioning property (right, visibility, etc.)
      const onTransitionEnd = (e) => {
        if (e.propertyName !== 'transform') return;
        sidebar.removeEventListener('transitionend', onTransitionEnd);
        settle();
      };
      sidebar.addEventListener('transitionend', onTransitionEnd);
      // Fallback in case transitionend doesn't fire (e.g. already at target)
      setTimeout(settle, 350);

      swipeRT.xDown = null;
      swipeRT.yDown = null;
      swipeRT.timeDown = null;
      return;
    }

    if (Math.abs(swipeRT.xDiff) > Math.abs(swipeRT.yDiff)) {
      // Skip navigation if this touch started in the sidebar zone
      if (!swipeRT.startedInSidebarZone) {
        // On item pages with .steuerung, only navigate if swipe started inside it
        const steuerung = document.querySelector('.steuerung');
        const allowNav = !steuerung || swipeRT.startedInSteuerung;
        if (allowNav && Math.abs(swipeRT.xDiff) > swipeOpt.treshold && timeDiff < swipeOpt.timeout) {
          if (swipeRT.xDiff > 0) {
            // swipe left -> next
            elem = document.querySelector("#next:not([href='#']), .nav-next:not([href='#'])");
          } else {
            // swipe right -> prev
            elem = document.querySelector("#prev:not([href='#']), .nav-prev:not([href='#'])");
          }
        }
      }
    }

    swipeRT.xDown = null;
    swipeRT.yDown = null;
    swipeRT.timeDown = null;

    if (elem) {
      changePage(elem);
    }

    // iOS Safari: re-fire click for taps where we called e.preventDefault() on touchstart
    // (preventDefault blocks native click events as a side-effect)
    if (swipeRT._steuerungPreventedTarget && !elem) {
      const dist = Math.hypot(swipeRT.xDiff || 0, swipeRT.yDiff || 0);
      if (dist < 15 && timeDiff < 400) {
        swipeRT._steuerungPreventedTarget.click();
      }
      swipeRT._steuerungPreventedTarget = null;
    }
  }, { passive: true });
  // </swipe>

  // iOS Safari: non-passive touchstart on .steuerung to prevent native history-swipe gesture
  // from intercepting our swipe-to-navigate. Since preventDefault() also kills native click
  // events, touchend manually re-dispatches clicks for taps.
  document.addEventListener('touchstart', e => {
    if (window.f0ckSession?.disable_swiping) return;
    if (document.body.classList.contains('modal-open')) return;
    swipeRT._steuerungPreventedTarget = null;
    const steuerungEl = document.querySelector('.steuerung');
    if (!steuerungEl) return;
    const sr = steuerungEl.getBoundingClientRect();
    const t = e.touches[0];
    if (t.clientX >= sr.left && t.clientX <= sr.right &&
        t.clientY >= sr.top  && t.clientY <= sr.bottom) {
      e.preventDefault(); // Block iOS native back/forward gesture
      swipeRT._steuerungPreventedTarget = e.target;
    }
  }, { passive: false });

  // <mouse-sidebar-drag> — desktop mirror of the touch handlers
  // Use pointer:fine to detect actual mouse devices (not touch screens with narrow windows)
  const isMouseDevice = () => window.matchMedia('(pointer: fine)').matches;

  const mouseRT = {
    active: false,
    xDown: 0,
    yDown: 0,
    xDiff: 0,
    yDiff: 0,
    timeDown: 0,
    isDragging: false,
    isCandidate: false,
    sidebarEl: null,
    sidebarWidth: 300,
  };

  document.addEventListener('mousedown', e => {
    if (!isMouseDevice()) return;
    if (document.body.classList.contains('modal-open')) return;
    if (e.button !== 0) return; // Left button only

    const sidebar = document.querySelector('.global-sidebar-right, .item-sidebar-right, .index-sidebar-right');
    if (!sidebar) return;

    mouseRT.active = true;
    mouseRT.isDragging = false;
    mouseRT.isCandidate = false;
    mouseRT.xDown = e.clientX;
    mouseRT.yDown = e.clientY;
    mouseRT.xDiff = 0;
    mouseRT.yDiff = 0;
    mouseRT.timeDown = Date.now();
    mouseRT.sidebarEl = sidebar;
    mouseRT.sidebarWidth = sidebar.offsetWidth;

    const isHidden = document.body.classList.contains('sidebar-right-hidden');
    if (isHidden) {
      // Open zone: 80px from right edge
      if (e.clientX > window.innerWidth - 30) {
        mouseRT.isCandidate = true;
      }
    } else {
      // Close: only from the left-edge grab strip (first 16px of sidebar) OR the edgeZone overhang
      const dragZone = document.getElementById('sidebar-drag-zone');
      const sidebarLeft = sidebar.getBoundingClientRect().left;
      const inGrabStrip = e.clientX >= sidebarLeft && e.clientX <= sidebarLeft + 16;
      if (inGrabStrip || e.target === dragZone) {
        mouseRT.isCandidate = true;
      }
    }
  });

  document.addEventListener('mousemove', e => {
    if (!mouseRT.active) return;

    mouseRT.xDiff = mouseRT.xDown - e.clientX;
    mouseRT.yDiff = mouseRT.yDown - e.clientY;

    // Direction lock — commit to sidebar drag once clearly horizontal
    if (mouseRT.isCandidate && !mouseRT.isDragging) {
      const absX = Math.abs(mouseRT.xDiff);
      const absY = Math.abs(mouseRT.yDiff);
      if (absX >= 8 && absX > absY * 2) {
        mouseRT.isDragging = true;
        mouseRT.isCandidate = false;
        document.body.style.userSelect = 'none';
        window.getSelection()?.removeAllRanges(); // clear any selection that formed before threshold
      } else if (absY > absX) {
        mouseRT.isCandidate = false; // Scrolling — bail
      }
    }

    if (!mouseRT.isDragging || !mouseRT.sidebarEl) return;

    const isHidden = document.body.classList.contains('sidebar-right-hidden');
    let dragX = mouseRT.xDiff;
    if (isHidden) {
      dragX = Math.max(0, Math.min(mouseRT.sidebarWidth, dragX));
    } else {
      dragX = Math.max(-mouseRT.sidebarWidth, Math.min(0, dragX));
    }

    mouseRT.sidebarEl.style.setProperty('transition', 'none', 'important');
    mouseRT.sidebarEl.style.transform = `translateX(${-dragX}px)`;
    document.body.style.cursor = 'grabbing';
  });

  document.addEventListener('mouseup', e => {
    if (!mouseRT.active) return;
    mouseRT.active = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    const wasDragging = mouseRT.isDragging;

    if (!mouseRT.isDragging || !mouseRT.sidebarEl) {
      mouseRT.isDragging = false;
      return;
    }

    const sidebar = mouseRT.sidebarEl;
    sidebar.style.cursor = '';
    mouseRT.isDragging = false;

    const isHidden = document.body.classList.contains('sidebar-right-hidden');
    const dist = Math.abs(mouseRT.xDiff);
    const timeDiff = Date.now() - mouseRT.timeDown;
    const threshold = mouseRT.sidebarWidth / 4;
    const quickSwipe = dist > 30 && timeDiff < 300;

    let shouldOpen = !isHidden;
    if (isHidden) {
      if (mouseRT.xDiff > threshold || (mouseRT.xDiff > 30 && quickSwipe)) shouldOpen = true;
    } else {
      if (mouseRT.xDiff < -threshold || (mouseRT.xDiff < -30 && quickSwipe)) shouldOpen = false;
    }

    const stateChanging = shouldOpen !== !isHidden;
    const targetTranslate = isHidden
      ? (shouldOpen ? -mouseRT.sidebarWidth : 0)
      : (shouldOpen ? 0 : mouseRT.sidebarWidth);

    sidebar.style.setProperty('transition', 'transform 0.3s ease-in-out', 'important');
    sidebar.style.transform = `translateX(${targetTranslate}px)`;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      sidebar.style.setProperty('transition', 'none', 'important');

      if (stateChanging) {
        const toHidden = !shouldOpen;
        document.body.classList.toggle('sidebar-right-hidden', toHidden);
        localStorage.setItem('sidebarRightHidden', toHidden);
      }

      void sidebar.offsetWidth;
      sidebar.style.transform = '';
      requestAnimationFrame(() => {
        sidebar.style.removeProperty('transition');
      });
    };

    const onEnd = ev => {
      if (ev.propertyName !== 'transform') return;
      sidebar.removeEventListener('transitionend', onEnd);
      settle();
    };
    sidebar.addEventListener('transitionend', onEnd);
    setTimeout(settle, 350);

    // Swallow the click event the browser fires after mouseup on the element
    // under the cursor — prevents links from activating after a drag.
    if (wasDragging) {
      document.addEventListener('click', e => e.stopPropagation() || e.preventDefault(), {
        capture: true, once: true
      });
    }
  });
  // Prevent native browser image-drag from hijacking our mouse drag
  document.addEventListener('dragstart', e => {
    if (mouseRT.active) e.preventDefault();
  });

  // Right-edge drag-zone cursor indicator — desktop only
  // A thin invisible overlay on the right edge that shows a grab cursor
  // when the sidebar is hidden, hinting that it can be dragged open.
  const edgeZone = document.createElement('div');
  edgeZone.id = 'sidebar-drag-zone';
  edgeZone.style.cssText = [
    'position: fixed',
    'top: 0',
    'right: 0',
    'bottom: 0',
    'width: 80px',
    'z-index: 899',
    'cursor: pointer',
    'pointer-events: none',
  ].join(';');
  document.body.appendChild(edgeZone);

  const syncEdgeZone = () => {
    const hidden = document.body.classList.contains('sidebar-right-hidden');
    if (hidden) {
      // Sidebar hidden: show 30px zone at the right edge for open gesture (all devices)
      edgeZone.style.pointerEvents = 'all';
      edgeZone.style.right = '0';
      edgeZone.style.width = '30px';
    } else {
      // Sidebar open: show 25px overhang just to the left of the sidebar on ALL devices
      // Touch devices tap it to close; mouse devices drag or click to close
      const s = document.querySelector('.global-sidebar-right, .item-sidebar-right, .index-sidebar-right');
      const sw = s ? s.offsetWidth : 300;
      edgeZone.style.right = sw + 'px';
      edgeZone.style.width = '25px';
      edgeZone.style.pointerEvents = 'all';
    }
  };

  syncEdgeZone();

  // Keep in sync when sidebar state changes
  new MutationObserver(syncEdgeZone).observe(document.body, {
    attributes: true, attributeFilter: ['class']
  });
  window.addEventListener('resize', syncEdgeZone, { passive: true });

  // Touchend on edgeZone: instant tap-to-toggle (no 300ms synthetic click delay)
  edgeZone.addEventListener('touchend', e => {
    // Only if it was a clean tap (no significant swipe movement)
    if (Math.abs(swipeRT.xDiff || 0) < 15 && Math.abs(swipeRT.yDiff || 0) < 15) {
      e.preventDefault();
      edgeZone.dispatchEvent(new Event('click'));
    }
  }, { passive: false });

  // Smoothly toggle sidebar open/closed
  window.toggleSidebarRight = () => {
    const sidebar = document.querySelector('.global-sidebar-right, .item-sidebar-right, .index-sidebar-right');
    if (!sidebar) return;

    const isHidden = document.body.classList.contains('sidebar-right-hidden');
    const sidebarWidth = sidebar.offsetWidth || 300;
    const targetTranslate = isHidden ? -sidebarWidth : sidebarWidth;

    sidebar.style.setProperty('transition', 'transform 0.3s ease-in-out', 'important');
    sidebar.style.transform = `translateX(${targetTranslate}px)`;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      sidebar.style.setProperty('transition', 'none', 'important');
      const toHidden = !isHidden;
      document.body.classList.toggle('sidebar-right-hidden', toHidden);
      localStorage.setItem('sidebarRightHidden', toHidden);
      void sidebar.offsetWidth;
      sidebar.style.transform = '';
      requestAnimationFrame(() => sidebar.style.removeProperty('transition'));
    };

    const onEnd = ev => {
      if (ev.propertyName !== 'transform') return;
      sidebar.removeEventListener('transitionend', onEnd);
      settle();
    };
    sidebar.addEventListener('transitionend', onEnd);
    setTimeout(settle, 350);
  };

  // Click on edgeZone: smoothly toggle sidebar open/closed
  edgeZone.addEventListener('click', () => {
    window.toggleSidebarRight();
  });
  // </mouse-sidebar-drag>


  // Export loaders for external systems (like NotificationSystem)
  window.loadPageAjax = loadPageAjax;
  window.loadItemAjax = loadItemAjax;
  // Continued...

const sbtForm = document.getElementById('sbtForm');
if (sbtForm) {
  sbtForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('sbtInput').value.trim();
    if (input) {
      window.location.href = `/tag/${encodeURIComponent(input)}`;

    }
  });
}

// Notification System
class NotificationSystem {
  // Notification type categorization
  static USER_TYPES = ['comment_reply', 'subscription', 'mention', 'upload_comment'];
  static SYSTEM_TYPES = ['approve', 'deny', 'item_deleted', 'upload_success', 'upload_error', 'admin_pending', 'report'];

  constructor() {
    this.bell = document.getElementById('nav-notif-btn');
    this.dropdown = document.getElementById('notif-dropdown');
    this.countBadge = this.bell ? this.bell.querySelector('.notif-count') : null;
    this.list = this.dropdown ? this.dropdown.querySelector('.notif-list') : null;
    this.markAllBtn = document.getElementById('mark-all-read');
    this.customEmojis = {};
    this.retryCount = 0;
    this.maxRetries = 20; // Increased retries
    this.pendingNotifIds = new Set(); // item IDs notified before thumbnail was in the grid
    this.activeTab = 'user'; // 'user' or 'system'
    this._cachedUser = [];
    this._cachedSystem = [];

    // Generate/retrieve unique tab ID
    this.tabId = sessionStorage.getItem('f0ck_tab_id');
    if (!this.tabId) {
        this.tabId = Math.random().toString(36).slice(2);
        sessionStorage.setItem('f0ck_tab_id', this.tabId);
    }

    // Initialize even if bell is missing (for guests MOTD)
    this.init();
  }

  debounce(func, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  async loadEmojis() {
    try {
      const res = await fetch('/api/v2/emojis');
      const data = await res.json();
      if (data.success) {
        data.emojis.forEach(e => {
          this.customEmojis[e.name] = e.url;
        });
      }
    } catch (e) {
      console.error("Failed to load emojis in NotificationSystem", e);
    }
  }

  init() {
    if (this._initialized) return;
    this._initialized = true;

    if (this.bell && this.dropdown && this.list) {
      this.loadEmojis();
      this.bindEvents();
      this.poll();
      this.pollDebounced = this.debounce(() => this.poll(), 500);
    }
    this.initSSE();

    // Signal server that this tab is active
    const signalActive = () => {
        if (document.hidden) return;
        fetch(`/api/notifications/active?tabId=${this.tabId}`).catch(() => {});
        // If SSE is closed, reconnect
        if (!this.es || this.es.readyState === 2) {
            window.f0ckDebug("[NotificationSystem] SSE was closed, reconnecting as active tab...");
            this.initSSE();
        }
    };

    // When a tab with a #c<id> URL hash regains focus, browsers natively jump
    // to the anchor element. scrollTo() cannot override this because the native
    // scroll fires after JS event handlers at the rendering-engine level.
    //
    // Solution: on tab show, immediately strip the hash via history.replaceState
    // so the browser has no anchor to jump to. We then restore the saved scroll
    // position and re-apply the comment highlight manually — no visible change.
    let _savedScrollYOnHide = null;
    let _savedHashOnHide = null;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // Snapshot both scroll position and the current hash before hiding.
        if (window.location.hash && window.location.hash.startsWith('#c')) {
          _savedScrollYOnHide = window.scrollY;
          _savedHashOnHide = window.location.hash;
        } else {
          _savedScrollYOnHide = null;
          _savedHashOnHide = null;
        }
        return;
      }

      // Tab just became visible.
      if (_savedScrollYOnHide !== null && _savedHashOnHide) {
        const snapY = _savedScrollYOnHide;
        const snapHash = _savedHashOnHide;
        _savedScrollYOnHide = null;
        _savedHashOnHide = null;

        // 1. Strip the hash NOW — this is the key step.
        //    history.replaceState does NOT trigger scrolling, and with no hash
        //    the browser has nothing to anchor-jump to.
        history.replaceState(null, '', window.location.pathname + window.location.search);

        // 2. Restore scroll position immediately.
        window.scrollTo({ top: snapY, behavior: 'instant' });

        // 3. Silently put the hash back and re-highlight (no scroll side-effects).
        requestAnimationFrame(() => {
          window.scrollTo({ top: snapY, behavior: 'instant' });
          history.replaceState(null, '', window.location.pathname + window.location.search + snapHash);
          const hashId = snapHash.substring(2); // strip '#c'
          const el = document.getElementById('c' + hashId);
          if (el) el.classList.add('comment-highlighted');
        });
      }

      window.f0ckDebug("[NotificationSystem] Tab visible, signaling active...");
      // If SSE died while hidden, restart it now
      if (!this.es) {
        window.f0ckDebug("[NotificationSystem] SSE was dead, restarting on tab visible.");
        this.retryCount = 0;
        this.initSSE();
      }
      if (this.pollDebounced) this.pollDebounced();
      if (this.checkForNewItems) this.checkForNewItems();
      // Note: emojis_updated dispatch was removed from here — it caused emoji cache flush +
      // async re-fetch + re-render that could fight the scroll-position restoration.
      // Emojis rarely change while a tab is hidden; SSE will deliver a targeted emojis_updated
      // event if they actually changed.
      signalActive();
      // Sync display name in case it was changed while this tab was inactive
      if (window.f0ckSession?.logged_in) this.syncDisplayName();
      // Refresh comments on item pages to catch up on any SSE events missed while hidden.
      // Guard: only refresh if the container is still attached to the live DOM —
      // avoids writing into a detached node left behind by a previous PJAX navigation.
      // Skip if the user is actively typing to avoid clobbering their draft.
      if (window.commentSystem && typeof window.commentSystem.loadComments === 'function') {
        const container = window.commentSystem.container;
        const isAttached = container && document.contains(container);
        const userTyping = isAttached && container.querySelector('textarea:focus, input:focus');
        if (isAttached && !userTyping) {
          // Kill the stabilization ResizeObserver SYNCHRONOUSLY before anything else.
          // If it's still alive from the initial anchor-load, it will fire when the
          // browser repaints the tab and re-scroll to the comment — that's the bug.
          window.commentSystem.stopStabilization();
          // Lock preservingScroll NOW (before the async fetch) so any scroll guards
          // in render/reconcile/emoji-load paths see the flag immediately.
          window.commentSystem.preservingScroll = true;
          // preserveScroll=true: prevent jump-to-top when re-focusing tab while scrolled down
          window.commentSystem.loadComments(null, true);
        }
      }
    });

    window.addEventListener('focus', () => {
        signalActive();
    });
  }

  initSSE() {
    if (this.es) {
      this.es.close();
    }

    window.f0ckDebug(`[NotificationSystem] Initializing SSE connection (tabId: ${this.tabId})...`);
    this.es = new EventSource(`/api/notifications/stream?tabId=${this.tabId}`);

    this.es.onopen = () => {
      window.f0ckDebug("[NotificationSystem] SSE connection established");
      this.retryCount = 0;
      document.documentElement.dataset.sseReady = '1';
      document.dispatchEvent(new CustomEvent('f0ck:sse_ready'));
    };

    this.es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        window.f0ckDebug(`[SSE] Received message:`, data.type);
        if (data.type === 'notify') {
          this.pollDebounced();
          const dnd = window.f0ckSession?.do_not_disturb === true;
          // Haptic feedback on mobile (supported: Chrome for Android, not iOS)
          if (!dnd && navigator.vibrate) navigator.vibrate([200, 80, 200]);
          // Live Grid Highlight
          if (data.data && data.data.item_id) {
            const itemId = data.data.item_id;
            const notifType = data.data.type;
            window.f0ckDebug(`[SSE] Live notification for item ${itemId} (type: ${notifType})`);

            // System notifications (deletion, deny, reports) require explicit acknowledgment —
            // never auto-mark them as read just because the user is viewing that item.
            const isSystemNotif = ['item_deleted', 'deny', 'admin_pending', 'report'].includes(notifType);

            // If the user is currently viewing this item, mark comment-type notifications as read immediately
            // (they are live on the thread, so no need to show a badge/highlight)
            const currentPath = window.location.pathname;
            if (!isSystemNotif && (currentPath === `/${itemId}` || currentPath === `/${itemId}/`)) {
              window.f0ckDebug(`[SSE] Notification for current item ${itemId} — auto-marking as read`);
              fetch(`/api/notifications/item/${itemId}/read`, {
                method: 'POST',
                keepalive: true
              }).catch(err => console.error('[SSE] Failed to auto-mark notification as read', err));
              // Still refresh the badge count in the dropdown
              // (pollDebounced above will update the count)
            } else {
              const thumbs = document.querySelectorAll(`a.thumb[href$="/${itemId}"]`);
              if (thumbs.length > 0) {
                thumbs.forEach(el => el.classList.add('has-notif'));
              } else {
                // Thumb not in grid yet (new_item SSE may arrive after notify)
                // Store pending so handleNewItem can apply it when the thumb is created
                this.pendingNotifIds.add(String(itemId));
              }
            }
          }
        } else if (data.type === 'activity') {
          // Trigger Navbar Glow
          const btn = document.getElementById('nav-activity-btn') || document.getElementById('nav-activity-btn-guest');
          if (btn) {
            const svg = btn.querySelector('svg');
            if (svg) {
              svg.classList.remove('activity-glowing');
              void svg.offsetWidth;
              svg.classList.add('activity-glowing');
              setTimeout(() => {
                svg.classList.remove('activity-glowing');
              }, 1000); // Remove after animation duration (1s)
            }
          }
          this.handleActivity(data.data);
        } else if (data.type === 'tags') {
          window.f0ckDebug(`[SSE] Tag update received for item ${data.data?.item_id}`);
          this.handleTagsUpdate(data.data);
        } else if (data.type === 'favorites') {
          window.f0ckDebug(`[SSE] Favorite update received for item ${data.data?.item_id}`);
          this.handleFavoritesUpdate(data.data);
        } else if (data.type === 'comments') {
          window.f0ckDebug(`[SSE] Comment update received:`, data.data);
          if (data.data.type === 'comment') {
            // New comment posted — update xD badge from server-authoritative score
            if (typeof data.data.xd_score === 'number') {
              updateXdBadgeFromScore(data.data.item_id, data.data.xd_score);
            }
          } else if (data.data.type === 'delete') {
            if (window.commentSystem && typeof window.commentSystem.handleLiveDeletion === 'function') {
              window.commentSystem.handleLiveDeletion(data.data);
            }
            // Also handle activity feed removal (find all instances of this comment ID)
            document.querySelectorAll('#c' + data.data.comment_id).forEach(el => {
              if (el.closest('#activity-container')) {
                el.classList.add('deleted');
                const contentEl = el.querySelector('.comment-content');
                if (contentEl) contentEl.innerHTML = '<span class="deleted-msg">[deleted]</span>';
              }
            });
            // Also vanish from sidebar
            const sidebarEl = document.getElementById('sc' + data.data.comment_id);
            if (sidebarEl) {
              sidebarEl.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
              sidebarEl.style.opacity = '0';
              sidebarEl.style.transform = 'scale(0.95)';
              setTimeout(() => sidebarEl.remove(), 300);
            }
            if (window._sidebarActivityCache) {
              window._sidebarActivityCache = window._sidebarActivityCache.filter(c => String(c.id) !== String(data.data.comment_id));
            }
          } else if (data.data.type === 'edit') {
            if (window.commentSystem && typeof window.commentSystem.handleLiveEdit === 'function') {
              window.commentSystem.handleLiveEdit(data.data);
            }
            // Dispatch event for other potential listeners (like Activity Feed)
            window.dispatchEvent(new CustomEvent('f0ck:comment_edited', { detail: data.data }));
          }
        } else if (data.type === 'emojis_updated') {
          window.f0ckDebug("[SSE] Emojis updated, refreshing caches...");
          this.loadEmojis();
          window.dispatchEvent(new CustomEvent('f0ck:emojis_updated'));
        } else if (data.type === 'motd') {
          window.f0ckDebug(`[SSE] MOTD update received:`, data.data.motd);
          if (typeof window.updateMotdUI === 'function') {
            window.updateMotdUI(data.data.motd);
          }
        } else if (data.type === 'rethumb') {
          window.f0ckDebug(`[SSE] Rethumb update received for item ${data.data?.item_id}`);
          if (data.data && data.data.item_id && window.refreshItemThumbnails) {
            window.refreshItemThumbnails(data.data.item_id);
          }
        } else if (data.type === 'new_item') {
          window.f0ckDebug(`[SSE] New item received:`, data.data);
          this.handleNewItem(data.data);
        } else if (data.type === 'delete_item') {
          const delId = data.data?.id;
          if (!delId) return;
          window.f0ckDebug(`[SSE] Item deleted: ${delId}`);

          // Remove from main grid — a.thumb is the anchor, li is its parent card
          const thumb = document.querySelector(`a.thumb[href$="/${delId}"], a.lazy-thumb[href$="/${delId}"]`);
          if (thumb) {
            const card = thumb.closest('li') || thumb;
            card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
            setTimeout(() => card.remove(), 300);
          }

          // If currently viewing this item, navigate to next item using soft AJAX nav
          const currentItemId = window.currentItemId || document.querySelector('[data-item-id]')?.dataset?.itemId;
          if (currentItemId && +currentItemId === delId) {
            // Skip navigation if the current user is the admin/mod who deleted this item
            // (admin.js sets this flag immediately on delete, and shows a "deleted" placeholder)
            const weDeletedIt = window._adminJustDeletedItem === delId;
            const mediaObj = document.querySelector('.media-object');
            const alreadyShowingPlaceholder = mediaObj && mediaObj.querySelector('h1') && mediaObj.querySelector('h1').textContent.includes('Deleted');
            if (!weDeletedIt && !alreadyShowingPlaceholder) {
              const next = document.querySelector('[data-next-id]')?.dataset?.nextId
                         || document.querySelector('.nav-next')?.href?.match(/\/(\d+)/)?.[1];
              if (next) {
                if (typeof window.loadItemAjax === 'function') {
                  window.loadItemAjax(`/${next}`, true);
                } else {
                  window.location.href = `/${next}`;
                }
              }
            }
          }

          // Remove from sidebar activity if present
          document.querySelectorAll(`#sidebar-activity-container [data-item="${delId}"]`).forEach(el => el.remove());
        } else if (data.type === 'emojis_updated') {
          window.f0ckDebug(`[SSE] Emoji update event received`);
          if (window.commentSystem && typeof window.commentSystem.loadEmojis === 'function') {
            window.commentSystem.loadEmojis();
          }
          // Global dispatch for other listeners (e.g. Admin Dashboard)
          document.dispatchEvent(new Event('f0ck:emojis_updated'));
        } else if (data.type === 'warning') {
          window.f0ckDebug(`[SSE] Warning received:`, data.data);
          const warningModal = document.getElementById('warning-modal');
          if (warningModal) {
              document.getElementById('warning-reason').textContent = data.data.reason;
              document.getElementById('warning-id').value = data.data.warning_id;
              warningModal.style.display = 'flex';
              document.body.classList.add('modal-open');
          }
        } else if (data.type === 'private_message') {
          window.f0ckDebug(`[SSE] Private message received from user ${data.data?.sender_id}`);
          // Haptic feedback for DMs (distinct double-pulse pattern)
          if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
          // Dispatch event for messages.js thread live-update
          window.dispatchEvent(new CustomEvent('dm:incoming', { detail: data.data }));
          if (window.DMSystem) {
            // If the user is already viewing this exact DM thread, messages.js will mark
            // the message as read and refresh the badge itself. Don't increment here or
            // the badge flashes 0→1→0 before settling back at 0.
            const dmThread = document.getElementById('dm-thread');
            const threadOtherId = dmThread ? parseInt(dmThread.dataset.otherId, 10) : null;
            const senderId = data.data?.sender_id;
            const isViewingThread = dmThread && threadOtherId && Number(senderId) === threadOtherId && !document.hidden;

            if (!isViewingThread) {
              // Not viewing this thread — show the badge immediately
              if (typeof window.DMSystem.incrementDmBadge === 'function') {
                window.DMSystem.incrementDmBadge();
              }
            }
            // Always sync exact count from server in background
            if (typeof window.DMSystem.refreshDmBadge === 'function') {
              window.DMSystem.refreshDmBadge();
            }
          }
        } else if (data.type === 'profile_update') {
          const { display_name, user } = data.data;
          this.applyDisplayNameUpdate(display_name, user);
          // Sync preferences to global session object for client-side gating (like DND)
          if (window.f0ckSession && data.data.user_id === window.f0ckSession.id) {
            for (const key in data.data) {
              if (key !== 'user_id') window.f0ckSession[key] = data.data[key];
            }
          }
        } else if (data.type === 'global_chat') {
          document.dispatchEvent(new CustomEvent('f0ck:global_chat', { detail: data.data }));
        } else if (data.type === 'global_chat_clear') {
          document.dispatchEvent(new CustomEvent('f0ck:global_chat_clear'));
        } else if (data.type === 'global_chat_delete') {
          document.dispatchEvent(new CustomEvent('f0ck:global_chat_delete', { detail: data.data }));
        } else if (data.type === 'global_chat_background') {
          document.dispatchEvent(new CustomEvent('f0ck:global_chat_background', { detail: data.data }));
        } else if (data.type === 'global_chat_topic') {
          document.dispatchEvent(new CustomEvent('f0ck:global_chat_topic', { detail: data.data }));
        } else if (data.type === 'global_chat_presence') {
          document.dispatchEvent(new CustomEvent('f0ck:global_chat_presence', { detail: data.data }));
        }
      } catch (err) {
        console.error('SSE data parse error', err);
      }
    };

    // Helper: apply a display name change to all relevant DOM nodes
    this.applyDisplayNameUpdate = (display_name, user) => {
      // Capture old value before overwriting — needed for thumb matching below
      const oldDisplayName = window.f0ckSession?.display_name || null;
      if (window.f0ckSession) window.f0ckSession.display_name = display_name || null;
      const navBtn = document.getElementById('nav-user-toggle');
      if (navBtn) {
        const nameSpan = document.getElementById('nav-display-name');
        if (nameSpan) {
          nameSpan.textContent = display_name || window.f0ckSession?.user || '';
        }
      }
      const userName = user || window.f0ckSession?.user;
      if (userName) {
        const userHref = `/user/${userName}`;
        // Sidebar / thread comment author links
        document.querySelectorAll(`.comment-author[href="${userHref}"]`).forEach(el => {
          el.textContent = display_name || userName;
        });
        // Item view: the [username] link next to the item ID
        const aUsername = document.getElementById('a_username');
        if (aUsername && aUsername.getAttribute('href') === userHref) {
          aUsername.textContent = display_name || userName;
        }
        // Grid thumbnails: update data-user attribute (shown as CSS content on hover)
        document.querySelectorAll('.thumb[data-user]').forEach(el => {
          const cur = el.getAttribute('data-user');
          if (cur === userName || (oldDisplayName && cur === oldDisplayName)) {
            el.setAttribute('data-user', display_name || userName);
          }
        });
      }
    };

    // Poll fresh display_name from DB — used on tab focus to catch missed SSE events
    this.syncDisplayName = async () => {
      try {
        const res = await fetch('/api/v2/settings/me', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success) return;
        // Always apply — the helper handles session + all DOM surfaces
        this.applyDisplayNameUpdate(data.display_name, data.user);
      } catch (e) { /* silent — best-effort background sync */ }
    };

    this.es.onerror = (err) => {
      console.warn('Notification SSE connection lost', err);
      if (this.es) {
          this.es.close();
          this.es = null;
      }

      // If tab is hidden, don't retry now — visibilitychange will restart SSE when visible again
      if (document.hidden) {
          window.f0ckDebug("[NotificationSystem] Tab hidden, deferring SSE retry until visible.");
          return;
      }

      // Exponential backoff, capped at 30s
      const delay = Math.min(Math.pow(2, this.retryCount) * 1000, 30000);
      if (this.retryCount < this.maxRetries) {
        window.f0ckDebug(`[NotificationSystem] Retrying SSE in ${delay}ms... (attempt ${this.retryCount + 1}/${this.maxRetries})`);
        setTimeout(() => this.initSSE(), delay);
        this.retryCount++;
      } else {
        // Past max retries — keep trying every 30s indefinitely, reset counter so backoff starts fresh
        console.warn("[NotificationSystem] Max SSE retries reached, falling back to 30s polling.");
        this.retryCount = 0;
        setTimeout(() => this.initSSE(), 30000);
      }
    };
  }

  get isOpen() {
    return this.dropdown.classList.contains('visible');
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  _positionDropdown() {
    if (window.innerWidth <= 768) {
      const bellRect = this.bell.getBoundingClientRect();
      this.dropdown.style.top   = (bellRect.bottom + 6) + 'px';
      this.dropdown.style.right = '0';
      this.dropdown.style.left  = 'auto';
    } else {
      this.dropdown.style.top   = '';
      this.dropdown.style.right = '';
      this.dropdown.style.left  = '';
    }
  }

  open() {
    this._positionDropdown();
    this.dropdown.classList.add('visible');
    this.bell.classList.add('is-active');

    // Live-track position while open (handles resize + layout shifts)
    if (!this._resizeHandler) {
      this._resizeHandler = () => {
        if (this.isOpen) {
          if (this._rafId) cancelAnimationFrame(this._rafId);
          this._rafId = requestAnimationFrame(() => this._positionDropdown());
        }
      };
      window.addEventListener('resize', this._resizeHandler, { passive: true });
    }
  }

  close() {
    this.dropdown.classList.remove('visible');
    this.bell.classList.remove('is-active');
  }

  bindEvents() {
    // Open/Close
    this.bell.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (this.isOpen && !this.dropdown.contains(e.target) && !this.bell.contains(e.target)) {
        this.close();
      }
    });

    // Mark all as read
    if (this.markAllBtn) {
      this.markAllBtn.addEventListener('click', () => this.markAllRead());
    }

    // Tab switching in dropdown
    if (this.dropdown) {
      this.dropdown.querySelectorAll('.notif-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const tabName = tab.dataset.tab;
          if (tabName === this.activeTab) return;
          this.activeTab = tabName;
          // Update active class
          this.dropdown.querySelectorAll('.notif-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          if (this.list) this.list.dataset.activeTab = tabName;
          // Re-render with cached data
          this._renderActiveTab();
        });
      });
    }

    // Single Notification Click Handler (Delegated)
    // Handles both Dropdown and History Page
    const handleNotificationClick = (e) => {
      const link = e.target.closest('.notif-item');
      if (!link) return;

      // Handle "Mark as Read"
      if (link.dataset.id && link.classList.contains('unread')) {
        window.f0ckDebug(`[NotificationSystem] Marking ${link.dataset.id} as read...`);
        // Fire and forget (keepalive ensures it survives navigation)
        fetch(`/api/notifications/${link.dataset.id}/read`, {
          method: 'POST',
          keepalive: true
        }).catch(err => console.error("Failed to mark read", err));

        // Decrement badge count
        if (this.countBadge) {
          let count = parseInt(this.countBadge.textContent) || 0;
          if (count > 0) {
            count--;
            this.countBadge.textContent = count;
            if (count === 0) {
              this.countBadge.style.display = 'none';
            }
          }
        }

        // Optimistically mark as read in UI
        link.classList.remove('unread');
      }

      // On the full history page: just mark as read + navigate — don't remove from list
      const isHistoryPage = !!link.closest('.notifications-list-full');

      if (!isHistoryPage) {
        // Dropdown: fade out and remove the item
        link.classList.add('notif-fade-out');
        setTimeout(() => {
          const list = link.closest('.notif-list');
          link.remove();
          if (list && list.children.length === 0) {
            list.innerHTML = `<div class="notif-empty">${window.f0ckI18n?.no_notifications || 'No new notifications'}</div>`;
          }
        }, 300);

        // Close the dropdown
        this.close();
      }

      // Handle Navigation (SPA)
      const href = link.getAttribute('href');
      if (href && href !== '#') {
        e.preventDefault();

        // Immediately restore scrollability and hide modals for better UX
        if (window.resetGlobalScrollState) window.resetGlobalScrollState();
        if (window.hideAllModals) window.hideAllModals();

        // Close dropdown
        if (this.isOpen) this.close();

        // Check if we are already on the target page
        // href format: /123 or /123#c456
        const [targetPath, targetHash] = href.split('#');
        const isAdmin = !!targetPath.match(/^\/admin/);
        const isMod = !!targetPath.match(/^\/mod/);

        if (targetPath === window.location.pathname && !isAdmin && !isMod) {
          if (targetHash) {
            const commentId = targetHash.startsWith('c') ? targetHash.substring(1) : (targetHash.startsWith('#c') ? targetHash.substring(2) : null);
            if (commentId && window.commentSystem) {
              window.commentSystem.scrollToComment(commentId);
              
              // scrollToComment handles scrolling + comment-highlighted
              // No need to re-apply new-item-fade here (would restart the animation)

              // Update URL hash without reload
              history.pushState(null, null, href);
              return; // Skip AJAX load
            }
          }
        }

        if (typeof window.loadItemAjax === 'function' && href.match(/^\/\d+/)) {
          window.loadItemAjax(href, false);
        } else if (typeof window.loadPageAjax === 'function') {
          window.loadPageAjax(href, true);
        } else {
          window.location.href = href;
        }
      } else {
        e.preventDefault();
      }
    };

    // Attach to dropdown list
    if (this.list) {
      this.list.addEventListener('click', handleNotificationClick);
    }

    // Attach to global document (for History Page items)
    // We filter for .notif-item inside the handler
    // Note: We avoid double-handling if clicking inside dropdown (stopPropagation wouldn't help if we attach to doc)
    // So we check container.
    document.addEventListener('click', (e) => {
      const item = e.target.closest('.notif-item');
      if (item) {
        // If it's inside dropdown, we already handled it via this.list listener? 
        // Actually, let's just use ONE document listener for complexity reduction.
        // BUT this.list listener is scoped to the class instance (good).

        // Let's just catch .notifications-list-full clicks here
        if (item.closest('.notifications-list-full')) {
          handleNotificationClick(e);
        }
      }
    });

    // Close on clicking 'View all' or 'Manage subscriptions'
    this.dropdown.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        this.dropdown.classList.remove('visible');
      });
    });
  }

  async poll() {
    if (document.hidden) return; // Do not poll if tab is backgrounded
    try {
      const res = await fetch('/api/notifications');
      const data = await res.json();
      if (data.success) {
        this.updateUI(data.notifications);
      }
    } catch (e) {
      // Silently ignore JSON parse errors during poll (often happens if server is restarting or returning HTML error)
      if (!(e instanceof SyntaxError)) {
        console.error('Notification poll error', e);
      }
    }
  }

  async checkForNewItems() {
    // Only check if we are on a grid page
    const grid = document.querySelector('.posts');
    if (!grid) return;

    // Skip for random mode as 'newest' doesn't apply
    if (document.cookie.includes('random_mode=1') || window.location.search.includes('random=1')) return;

    // Get max ID in the current grid
    const thumbs = Array.from(grid.querySelectorAll('a.thumb, a.lazy-thumb'));
    if (thumbs.length === 0) return;

    const ids = thumbs.map(t => {
      const match = t.getAttribute('href').match(/\/(\d+)$/);
      return match ? parseInt(match[1]) : 0;
    }).filter(id => id > 0);

    if (ids.length === 0) return;
    const maxId = Math.max(...ids);

    window.f0ckDebug(`[NotificationSystem] Checking for items newer than ${maxId}...`);

    try {
      // Build filters from URL
      const url = window.location.pathname;
      let tag = null, user = null, mime = null, hall = null;
      
      const tagMatch = url.match(/\/tag\/([^/?]+)/);
      if (tagMatch) tag = decodeURIComponent(tagMatch[1]);
      const hallMatch = url.match(/\/h\/([^/?]+)/);
      if (hallMatch) hall = decodeURIComponent(hallMatch[1]);
      const userMatch = url.match(/\/user\/([^/]+)/);
      if (userMatch && !url.match(/\/user\/[^/]+\/(favs|f0cks|comments)/)) user = decodeURIComponent(userMatch[1]);
      const favMatch = url.match(/\/user\/([^/]+)\/favs/);
      const f0cksMatch = url.match(/\/user\/([^/]+)\/f0cks/);
      let isFav = false;
      if (favMatch) {
        user = decodeURIComponent(favMatch[1]);
        isFav = true;
      } else if (f0cksMatch) {
        user = decodeURIComponent(f0cksMatch[1]);
      }
      const mimeMatch = url.match(/\/(image|audio|video)/);
      if (mimeMatch) mime = mimeMatch[1];

      let ajaxUrl = `/ajax/items/?newer=${maxId}&mode=${window.activeMode}`;
      if (tag) ajaxUrl += `&tag=${encodeURIComponent(tag)}`;
      if (hall) ajaxUrl += `&hall=${encodeURIComponent(hall)}`;
      if (user) ajaxUrl += `&user=${encodeURIComponent(user)}`;
      if (isFav) ajaxUrl += `&fav=true`;
      if (mime) ajaxUrl += `&mime=${encodeURIComponent(mime)}`;
      
      const isStrict = window.f0ckSession?.strict_mode || (localStorage.getItem('search_strict') === 'true') || window.location.search.includes('strict=1');
      if (isStrict) ajaxUrl += `&strict=1`;
      ajaxUrl += `&_t=${Date.now()}`;

      const res = await fetch(ajaxUrl, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const data = await res.json();

      if (data.success && data.html) {
        window.f0ckDebug(`[NotificationSystem] Loaded new items for grid.`);
        const temp = document.createElement('div');
        temp.innerHTML = Sanitizer.clean(data.html);
        
        // Items are returned in desc order, so we reverse them to prepend one by one?
        // Actually, if we prepend the whole block, the block itself should be descending.
        // If block is [3, 2] and grid is [1], prepending block results in [3, 2, 1]. Correct.
        
        // We should skip items that are already in the grid (duplicates)
        const entries = Array.from(temp.querySelectorAll('a.thumb, a.lazy-thumb'));
        entries.reverse().forEach(entry => {
          const idMatch = entry.href.match(/\/(\d+)$/);
          if (idMatch && !grid.querySelector(`a[href$="/${idMatch[1]}"]`)) {
             const pinnedItems = grid.querySelectorAll('.is-pinned');
             if (pinnedItems.length > 0) {
               pinnedItems[pinnedItems.length - 1].after(entry);
             } else {
               grid.prepend(entry);
             }
             // Animate in
             entry.style.opacity = '0';
             entry.style.transform = 'scale(0.9)';
             requestAnimationFrame(() => {
               entry.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
               entry.style.opacity = '1';
               entry.style.transform = 'scale(1)';
             });
          }
        });

        if (window.initLazyLoading) window.initLazyLoading();
      }
    } catch (e) {
      console.error('[NotificationSystem] Failed to check for new items', e);
    }
  }

  updateUI(notifications) {
    if (!this.countBadge || !this.list) return;

    // Split into user and system categories
    this._cachedUser = notifications.filter(n => NotificationSystem.USER_TYPES.includes(n.type));
    this._cachedSystem = notifications.filter(n => NotificationSystem.SYSTEM_TYPES.includes(n.type));

    const userUnread = this._cachedUser.filter(n => !n.is_read).length;
    const systemUnread = this._cachedSystem.filter(n => !n.is_read).length;
    const totalUnread = userUnread + systemUnread;

    // Update main bell badge (total unread)
    if (totalUnread > 0) {
      this.countBadge.textContent = totalUnread;
      this.countBadge.style.display = 'block';
    } else {
      this.countBadge.style.display = 'none';
    }

    // Update per-tab badges
    const userBadge = document.getElementById('notif-tab-badge-user');
    const systemBadge = document.getElementById('notif-tab-badge-system');
    if (userBadge) {
      userBadge.textContent = userUnread;
      userBadge.style.display = userUnread > 0 ? '' : 'none';
    }
    if (systemBadge) {
      systemBadge.textContent = systemUnread;
      systemBadge.style.display = systemUnread > 0 ? '' : 'none';
    }

    // Forward count to Abyss scroller notification badge if active
    if (typeof window._scrollerNotifHook === 'function') {
      window._scrollerNotifHook(totalUnread);
    }

    // Sync .has-notif highlights on main grid thumbnails for all unread notifications.
    const currentPath = window.location.pathname;
    const unreadItemIds = new Set();
    notifications.forEach(n => {
      if (!n.is_read && n.item_id) {
        unreadItemIds.add(String(n.item_id));
        if (currentPath === `/${n.item_id}` || currentPath === `/${n.item_id}/`) return;
        document.querySelectorAll(`a.thumb[href$="/${n.item_id}"], a.lazy-thumb[href$="/${n.item_id}"]`).forEach(el => {
          el.classList.add('has-notif');
        });
      }
    });

    // Remove .has-notif from any thumb whose item is no longer in the unread set.
    document.querySelectorAll('a.thumb.has-notif, a.lazy-thumb.has-notif').forEach(el => {
      const match = el.getAttribute('href')?.match(/\/(\d+)$/);
      if (match && !unreadItemIds.has(match[1])) {
        el.classList.remove('has-notif');
      }
    });

    // Render the active tab
    this._renderActiveTab();

    // Live update for History Page
    const historyContainer = document.querySelector('.notifications-list-full');
    if (historyContainer) {
      const historyTab = historyContainer.dataset.tab || 'user';
      const tabNotifs = historyTab === 'system' ? this._cachedSystem : this._cachedUser;
      tabNotifs.forEach(n => {
        const existing = historyContainer.querySelector(`.notif-item[data-id="${n.id}"]`);
        if (!existing) {
          window.f0ckDebug("[NotificationSystem] Adding new item to history:", n.id);
          const html = this.renderHistoryItem(n);
          const temp = document.createElement('div');
          temp.innerHTML = Sanitizer.clean(html);
          const node = temp.firstElementChild;
          node.classList.add('new-item-fade');
          historyContainer.prepend(node);
        } else {
          window.f0ckDebug("[NotificationSystem] Item already exists:", n.id);
        }
      });
    }
  }

  _renderActiveTab() {
    if (!this.list) return;
    const items = this.activeTab === 'system' ? this._cachedSystem : this._cachedUser;
    if (items.length === 0) {
      this.list.innerHTML = `<div class="notif-empty">${window.f0ckI18n?.no_notifications || 'No new notifications'}</div>`;
      return;
    }
    this.list.innerHTML = Sanitizer.clean(items.map(n => this.renderItem(n)).join(''));
  }

  renderHistoryItem(n) {
    let link = `/${n.item_id}`;
    let msg = '';
    let user = n.from_display_name || n.from_user || 'System';

    if (n.type === 'deny' || n.type === 'item_deleted') {
      const i18n = window.f0ckI18n || {};
      const isDeleted = n.type === 'item_deleted';
      const label = isDeleted ? (i18n.notif_upload_deleted || 'A moderator deleted your upload') : (i18n.notif_upload_denied || 'Your Upload was denied');
      const userLabel = isDeleted ? (i18n.notif_moderation || 'Moderation') : (i18n.notif_system || 'System');
      const itemLink = `/${n.item_id}`;
      return `
        <a href="${itemLink}" class="notif-item ${n.is_read ? '' : 'unread'} notif-with-thumb" data-id="${n.id}">
            <div class="notif-thumb"><img src="/mod/deleted/t/${n.item_id}.webp" alt="thumb" onerror="this.onerror=null;this.src='/t/${n.item_id}.webp';this.onerror=function(){this.style.display='none';}"></div>
            <div class="notif-content">
                <div class="notif-user"><strong>${userLabel}</strong></div>
                <div class="notif-msg">
                    <strong>${label} #${n.item_id}</strong>
                    <div class="notif-reason">${i18n.notif_reason_label || 'Reason:'} ${n.reason || (i18n.notif_no_reason || 'No reason provided')}</div>
                </div>
                <div class="notif-time">${new Date(n.created_at).toLocaleString()}</div>
            </div>
        </a>
      `;
    }

    if (n.type === 'approve') {
      msg = (window.f0ckI18n && window.f0ckI18n.notif_upload_approved) || 'Your Upload has been approved';
      user = (window.f0ckI18n && window.f0ckI18n.notif_system) || 'System';
    } else if (n.type === 'upload_success') {
      msg = (window.f0ckI18n && window.f0ckI18n.notif_upload_success) || 'Your background upload is finished!';
      user = (window.f0ckI18n && window.f0ckI18n.notif_system) || 'System';
    } else if (n.type === 'upload_error') {
      msg = (window.f0ckI18n && window.f0ckI18n.notif_upload_error) || 'Your background upload failed.';
      if (n.data?.msg) msg += ` <br><span style="color: #ff6060; font-size: 0.9em;">${n.data.msg}</span>`;
      if (n.data?.url) msg += ` <br><small style="opacity: 0.6; word-break: break-all;">${n.data.url}</small>`;
      user = (window.f0ckI18n && window.f0ckI18n.notif_system) || 'System';
      link = n.item_id ? `/${n.item_id}` : '#';
    } else if (n.type === 'admin_pending') {
      link = '/mod/approve';
      user = (window.f0ckI18n && window.f0ckI18n.notif_admin) || 'Admin';
      msg = (window.f0ckI18n && window.f0ckI18n.notif_upload_pending) || 'A new upload needs approval';
    } else if (n.type === 'report') {
      link = '/mod/reports';
      user = (window.f0ckI18n && window.f0ckI18n.notif_moderation) || 'Moderator';
      msg = (window.f0ckI18n && window.f0ckI18n.notif_new_report) || 'A new user report has been submitted';
    } else {
      // Comment notification
      link = `/${n.item_id}#c${n.comment_id || n.reference_id}`;
      if (n.type === 'comment_reply') msg = (window.f0ckI18n && window.f0ckI18n.notif_replied) || 'replied to you';
      else if (n.type === 'subscription') msg = (window.f0ckI18n && window.f0ckI18n.notif_subscribed) || 'commented in a thread you follow';
      else if (n.type === 'mention') msg = (window.f0ckI18n && window.f0ckI18n.notif_mentioned) || 'highlighted you';
      else msg = (window.f0ckI18n && window.f0ckI18n.notif_commented) || 'commented';
    }

    // For admin_pending the thumbnail lives in /mod/pending/t/ until approved
    let thumbSrc, thumbOnerror;
    if (n.type === 'admin_pending') {
      thumbSrc = `/mod/pending/t/${n.item_id}.webp`;
      thumbOnerror = `this.onerror=null;this.src='/t/${n.item_id}.webp';this.onerror=function(){this.style.display='none';}`;
    } else {
      thumbSrc = `/t/${n.item_id}.webp`;
      thumbOnerror = `this.onerror=null;this.src='/mod/pending/t/${n.item_id}.webp';this.onerror=function(){this.onerror=null;this.src='/mod/deleted/t/${n.item_id}.webp';this.onerror=function(){this.style.display='none';};}`;
    }
    const thumb = n.item_id ? `<div class="notif-thumb"><img src="${thumbSrc}" alt="thumb" onerror="${thumbOnerror}"></div>` : '';
    return `
      <a href="${link}" class="notif-item ${n.is_read ? '' : 'unread'} notif-with-thumb" data-id="${n.id}">
          ${thumb}
          <div class="notif-content">
            <div class="notif-user"><strong ${n.username_color ? `style="color: ${n.username_color}"` : ''}>${user}</strong></div>
            <div class="notif-msg">${msg}</div>
            <div class="notif-time">${new Date(n.created_at).toLocaleString()}</div>
          </div>
      </a>
    `;
  }

  renderItem(n) {
    if (n.type === 'approve') {
      const link = `/${n.item_id}`;
      return `
            <a href="${link}" class="notif-item ${n.is_read ? '' : 'unread'} notif-with-thumb" data-id="${n.id}">
                <div class="notif-thumb"><img src="/t/${n.item_id}.webp" alt="thumb" onerror="this.onerror=null;this.src='/mod/pending/t/${n.item_id}.webp';this.onerror=function(){this.onerror=null;this.src='/mod/deleted/t/${n.item_id}.webp';this.onerror=function(){this.style.display='none';};}"></div>
                <div class="notif-content">
                    <div>
                    <strong>${(window.f0ckI18n && window.f0ckI18n.notif_upload_approved) || 'Your Upload has been approved'}</strong>
                    </div>
                    <small class="notif-time">${new Date(n.created_at).toLocaleString()}</small>
                </div>
            </a>
        `;
    }

    if (n.type === 'upload_success') {
        const link = `/${n.item_id}`;
        return `
            <a href="${link}" class="notif-item ${n.is_read ? '' : 'unread'} notif-with-thumb" data-id="${n.id}">
                <div class="notif-thumb"><img src="/t/${n.item_id}.webp" alt="thumb" onerror="this.style.display='none';"></div>
                <div class="notif-content">
                    <div>
                    <strong>${(window.f0ckI18n && window.f0ckI18n.notif_upload_success) || 'Your background upload is finished!'}</strong>
                    </div>
                    <small class="notif-time">${new Date(n.created_at).toLocaleString()}</small>
                </div>
            </a>
        `;
    }

    if (n.type === 'upload_error') {
        const url = n.data?.url || '';
        const errMsg = n.data?.msg || '';
        const errDisplay = errMsg ? `<div style="color: #ffbaba; font-size: 0.85em; margin-top: 2px;">${errMsg}</div>` : '';
        const urlDisplay = url ? `<div style="font-size: 0.8em; opacity: 0.7; margin-top: 4px; word-break: break-all; max-height: 3.2em; overflow: hidden;">${url}</div>` : '';
        const link = n.item_id ? `/${n.item_id}` : '#';
        return `
            <a href="${link}" class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}">
                <div class="notif-content">
                    <div>
                    <strong>${(window.f0ckI18n && window.f0ckI18n.notif_upload_error) || 'Your background upload failed.'}</strong>
                    ${errDisplay}
                    ${urlDisplay}
                    </div>
                    <small class="notif-time">${new Date(n.created_at).toLocaleString()}</small>
                </div>
            </a>
        `;
    }

    if (n.type === 'deny' || n.type === 'item_deleted') {
      const isDeleted = n.type === 'item_deleted';
      const label = isDeleted ? ((window.f0ckI18n && window.f0ckI18n.notif_upload_deleted) || 'A moderator deleted your upload') : ((window.f0ckI18n && window.f0ckI18n.notif_upload_denied) || 'Your upload was denied');
      const link = `/notifications#notif-${n.id}`;
      return `
            <a href="${link}" class="notif-item ${n.is_read ? '' : 'unread'} notif-with-thumb" data-id="${n.id}" data-notif-nav="true">
                <div class="notif-thumb"><img src="/mod/deleted/t/${n.item_id}.webp" alt="thumb" onerror="this.onerror=null;this.src='/t/${n.item_id}.webp';this.onerror=function(){this.style.display='none';}"></div>
                <div class="notif-content">
                    <div>
                        <strong>${label} #${n.item_id}</strong>
                        <div style="font-size: 0.85em; color: #ffb8b8; margin-top: 3px;">${(window.f0ckI18n && window.f0ckI18n.notif_click_reason) || 'Click to see reason'}</div>
                    </div>
                    <small class="notif-time">${new Date(n.created_at).toLocaleString()}</small>
                </div>
            </a>
        `;
    }

    if (n.type === 'admin_pending') {
      const link = '/mod/approve';
      return `
            <a href="${link}" class="notif-item ${n.is_read ? '' : 'unread'} notif-with-thumb" data-id="${n.id}">
                <div class="notif-thumb"><img src="/mod/pending/t/${n.item_id}.webp" alt="thumb" onerror="this.onerror=null;this.src='/t/${n.item_id}.webp';this.onerror=function(){this.style.display='none';}"></div>
                <div class="notif-content">
                    <div>
                        <strong>${(window.f0ckI18n && window.f0ckI18n.notif_upload_pending) || 'A new upload needs approval'}</strong>
                    </div>
                    <small class="notif-time">${new Date(n.created_at).toLocaleString()}</small>
                </div>
            </a>
        `;
    }

    if (n.type === 'report') {
      const link = '/mod/reports';
      return `
            <a href="${link}" class="notif-item ${n.is_read ? '' : 'unread'} notif-with-thumb" data-id="${n.id}">
                <div class="notif-thumb"><img src="/t/${n.item_id}.webp" alt="thumb" onerror="this.onerror=null;this.src='/mod/pending/t/${n.item_id}.webp';this.onerror=function(){this.onerror=null;this.src='/mod/deleted/t/${n.item_id}.webp';this.onerror=function(){this.style.display='none';};}"></div>
                <div class="notif-content">
                    <div>
                        <strong>${(window.f0ckI18n && window.f0ckI18n.notif_new_report) || 'A new user report has been submitted'}</strong>
                    </div>
                    <small class="notif-time">${new Date(n.created_at).toLocaleString()}</small>
                </div>
            </a>
        `;
    }

    let typeText = 'Start';
    if (n.type === 'comment_reply') typeText = (window.f0ckI18n && window.f0ckI18n.notif_replied) || 'replied to you';
    else if (n.type === 'subscription') typeText = (window.f0ckI18n && window.f0ckI18n.notif_subscribed) || 'commented in a thread you follow';
    else if (n.type === 'mention') typeText = (window.f0ckI18n && window.f0ckI18n.notif_mentioned) || 'highlighted you';
    else if (n.type === 'upload_comment') typeText = `${(window.f0ckI18n && window.f0ckI18n.notif_commented) || 'commented on your upload'} #${n.item_id}`;

    const cid = n.comment_id || n.reference_id;
    const link = `/${n.item_id}#c${cid}`;

      const thumb = n.item_id ? `<div class="notif-thumb"><img src="/t/${n.item_id}.webp" alt="thumb" onerror="this.style.display='none'"></div>` : '';
      return `
            <a href="${link}" class="notif-item ${n.is_read ? '' : 'unread'} notif-with-thumb" data-id="${n.id}">
                ${thumb}
                <div class="notif-content">
                    <div>
                        <strong ${n.username_color ? `style="color: ${n.username_color}"` : ''}>${escHTML(n.from_display_name || n.from_user)}</strong> ${typeText}
                    </div>
                    <small class="notif-time">${new Date(n.created_at).toLocaleString()}</small>
                </div>
            </a>
        `;
  }


  async markAllRead() {
    try {
      const res = await fetch('/api/notifications/read', { 
        method: 'POST',
        headers: { 'X-CSRF-Token': window.f0ckSession?.csrf_token }
      });
      const data = await res.json();
      if (data.success) {
        this.markAllReadUI();
      }
    } catch (e) {
      console.error('Failed to mark all read', e);
    }
  }

  markAllReadUI() {
    this.countBadge.style.display = 'none';
    // Clear per-tab badges
    const userBadge = document.getElementById('notif-tab-badge-user');
    const systemBadge = document.getElementById('notif-tab-badge-system');
    if (userBadge) userBadge.style.display = 'none';
    if (systemBadge) systemBadge.style.display = 'none';
    // Clear cached data
    this._cachedUser = [];
    this._cachedSystem = [];
    if (this.list) {
      this.list.innerHTML = `<div class="notif-empty">${window.f0ckI18n?.no_notifications || 'No new notifications'}</div>`;
    }
    // Also update History page items if present
    document.querySelectorAll('.notifications-list-full .notif-item.unread').forEach(el => el.classList.remove('unread'));
  }

  handleTagsUpdate(data) {
    if (!data || !data.item_id) {
      console.warn("[NotificationSystem] Malformed tag update data:", data);
      return;
    }

    // Check if we are currently viewing this item
    const idLink = document.querySelector('.id-link');
    const currentId = idLink ? parseInt(idLink.innerText) : null;

    window.f0ckDebug(`[NotificationSystem] Processing tag update for #${data.item_id}. Current view is #${currentId}`);

    if (currentId !== parseInt(data.item_id)) {
      window.f0ckDebug("[NotificationSystem] Item ID mismatch, ignoring update.");
      return;
    }

    // Ignore incoming live SSE tag updates if an optimistic rating cycle is currently active on the page
    const toggleBtn = document.querySelector('button#a_toggle');
    if (toggleBtn && toggleBtn._activeRequestsCount > 0) {
      window.f0ckDebug("[NotificationSystem] Live Tag Update ignored - Optimistic rating cycle in progress.");
      return;
    }

    const tagsContainer = document.querySelector('#tags');
    if (!tagsContainer) {
      console.warn("[NotificationSystem] #tags container not found!");
      return;
    }

    // DO NOT re-render if the user is currently typing a new tag (has an active input)
    if (tagsContainer.querySelector('input')) {
      window.f0ckDebug("[NotificationSystem] Live Tag Update deferred - User is currently typing.");
      return;
    }

    window.f0ckDebug("[NotificationSystem] Re-rendering tags for item:", data.item_id);

    const inner = tagsContainer.querySelector('.tags-inner') || tagsContainer;

    // Filter out existing badges to replace with new ones
    // We keep the "add tag" and "toggle" links which are usually at the end
    const badges = inner.querySelectorAll('.badge');
    badges.forEach(b => {
      // Don't remove the container for addtag, nor the rating switch toggles
      if (!b.querySelector('#a_addtag') && !b.querySelector('#a_toggle') && !b.id && !b.classList.contains('tag-ac-wrapper')) {
        b.remove();
      }
    });

    // Generate new tags HTML
    if (Array.isArray(data.tags)) {
      // Cast to boolean to handle potentially numeric truthy values (1/0)
      const isAdminBySession = !!(window.f0ckSession?.is_admin || window.f0ckSession?.is_moderator);
      const hasSession = !!window.f0ckSession;

      window.f0ckDebug(`[NotificationSystem] Rendering ${data.tags.length} tags. isAdmin: ${isAdminBySession}, hasSession: ${hasSession}`);

      const fragment = document.createDocumentFragment();
      data.tags.forEach(tag => {
        const span = document.createElement('span');
        span.className = `badge ${tag.badge} mr-2`;
        if (hasSession) span.setAttribute('tooltip', tag.display_name || tag.user);

        const a = document.createElement('a');
        a.href = `/tag/${tag.normalized}`;
        a.textContent = tag.tag;
        span.appendChild(a);

        if (isAdminBySession) {
          // Match template exactly: &nbsp;<a class="removetag admin-deltag" href="#"><i class="fa-solid fa-xmark"></i></a>
          span.insertAdjacentHTML('beforeend', '&nbsp;<a class="removetag admin-deltag" href="#"><i class="fa-solid fa-xmark"></i></a>');
        }
        fragment.appendChild(span);
      });
      
      // Insert before the first control button if it exists, or just append to inner
      const controls = inner.querySelector('.tag-controls, #a_addtag, .tag-btn');
      if (controls) {
          inner.insertBefore(fragment, controls);
      } else {
          inner.appendChild(fragment);
      }
    }
  }

  handleFavoritesUpdate(data) {
    if (!data || !data.item_id) return;

    // Check if we are currently viewing this item
    const idLink = document.querySelector('#main .id-link');
    if (!idLink || parseInt(idLink.innerText) !== parseInt(data.item_id)) return;

    const favsContainer = document.querySelector('#favs');
    if (!favsContainer) return;

    window.f0ckDebug("[NotificationSystem] Live Favorite Update for item:", data.item_id);

    // Sync the heart icon for the current user
    const currentUser = window.f0ckSession?.user?.toLowerCase();
    const favoBtn = document.querySelector('#a_favo');
    if (favoBtn && currentUser) {
      const isNowFav = Array.isArray(data.favs) && data.favs.some(f => f.user?.toLowerCase() === currentUser);
      favoBtn.classList.toggle('fa-solid', isNowFav);
      favoBtn.classList.toggle('fa-regular', !isNowFav);
    }

    if (!Array.isArray(data.favs) || data.favs.length === 0) {
      favsContainer.innerHTML = '';
      favsContainer.hidden = true;
      return;
    }

    // Build DOM nodes imperatively (avoids Sanitizer stripping inline border-color)
    const fragment = document.createDocumentFragment();
    data.favs.forEach(fav => {
      const avatarUrl = fav.avatar_file
        ? `/a/${fav.avatar_file}`
        : (fav.avatar ? `/t/${fav.avatar}.webp` : '/a/default.png');

      const a = document.createElement('a');
      a.href = `/user/${fav.user.toLowerCase()}`;
      a.setAttribute('tooltip', fav.display_name || fav.user);
      a.setAttribute('flow', 'up');

      const img = document.createElement('img');
      img.src = avatarUrl;
      img.style.height = '32px';
      img.style.width = '32px';
      if (fav.username_color) img.style.borderColor = fav.username_color;

      a.appendChild(img);
      fragment.appendChild(a);
    });

    favsContainer.innerHTML = '';
    favsContainer.appendChild(fragment);
    favsContainer.hidden = false;
  }

  handleNewItem(data) {
    // Only prepend to the grid on the main/index page
    const grid = document.querySelector('.posts');
    if (!grid) return;

    // Don't live-update on filtered views (tags, halls, users)
    if (window.location.pathname.includes('/tag/') || 
        window.location.pathname.includes('/h/') || 
        window.location.pathname.includes('/user/')) return;

    // Respect mode filter
    if (typeof window.activeMode !== 'undefined' && window.activeMode !== 3) { // 3 is ALL
      if (window.activeMode === 0 && data.tag_id !== 1) return; // SFW mode, item is not SFW
      if (window.activeMode === 1 && data.tag_id !== 2) return; // NSFW mode, item is not NSFW
      if (window.activeMode === 4 && data.tag_id != window.f0ckSession?.nsfl_tag_id) return;   // NSFL mode, item is not NSFL
      if (window.activeMode === 2) return; // Untagged mode, new uploads are never untagged
    }

    // Don't add duplicates
    if (grid.querySelector(`a[href$="/${data.id}"]`)) return;

    // Determine the link prefix from existing items
    const firstThumb = grid.querySelector('a.thumb, a.lazy-thumb');
    const linkBase = firstThumb ? firstThumb.getAttribute('href').replace(/\d+$/, '') : '/';

    // Respect mode filter
    const nsflId = window.f0ckSession?.nsfl_tag_id;
    const mode = data.tag_id ? (data.tag_id === 1 ? 'sfw' : (data.tag_id === 2 ? 'nsfw' : (data.tag_id == nsflId ? 'nsfl' : 'null'))) : 'null';

    const thumb = document.createElement('a');
    thumb.href = `${linkBase}${data.id}`;
    thumb.className = 'thumb lazy-thumb';
    thumb.dataset.file = data.dest;
    thumb.dataset.mime = data.mime;
    thumb.dataset.user = data.display_name || data.username;
    thumb.dataset.ext = data.mime.split('/')[1].replace('youtube', 'yt').toUpperCase();
    thumb.dataset.mode = mode;
    thumb.dataset.bg = `/t/${data.id}.webp`;
    thumb.dataset.size = '1'; // New items start with no contributions → tier 1
    thumb.style.backgroundImage = `url('/t/${data.id}.webp')`;
    thumb.style.opacity = '0';
    thumb.style.transform = 'scale(0.9)';
    thumb.innerHTML = '<p></p>' + (data.is_oc ? '<span class="oc-indicator anim">OC</span>' : '');

    // Apply pending notification highlight if notify SSE arrived before new_item
    if (this.pendingNotifIds.has(String(data.id))) {
      thumb.classList.add('has-notif');
      this.pendingNotifIds.delete(String(data.id));
    }

    const pinnedItems = grid.querySelectorAll('.is-pinned');
    if (pinnedItems.length > 0) {
      pinnedItems[pinnedItems.length - 1].after(thumb);
    } else {
      grid.prepend(thumb);
    }

    // Animate in
    requestAnimationFrame(() => {
      thumb.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
      thumb.style.opacity = '1';
      thumb.style.transform = 'scale(1)';
    });

    // Refresh lazy loading for the newly added item
    if (typeof window.initLazyLoading === 'function') {
        window.initLazyLoading();
    }
  }

  handleActivity(data) {
    // 1. Dispatch to global CommentSystem if active (for Item Page)
    if (window.commentSystem && typeof window.commentSystem.handleLiveComment === 'function') {
      window.commentSystem.handleLiveComment(data);
    }

    // Respect mode filter
    if (typeof window.activeMode !== 'undefined' && window.activeMode !== 3) { // 3 is ALL
      if (window.activeMode === 0 && data.tag_id !== 1) return; // SFW mode, item is not SFW
      if (window.activeMode === 1 && data.tag_id !== 2) return; // NSFW mode, item is not NSFW
      if (window.activeMode === 4 && data.tag_id != window.f0ckSession?.nsfl_tag_id) return;   // NSFL mode, item is not NSFL
      if (window.activeMode === 2) return; // Untagged mode, new uploads are never untagged
    }

    // 2. Dispatch for external listeners (e.g. sidebar-activity)
    document.dispatchEvent(new CustomEvent('f0ck:activityReceived', { detail: data }));

    // 3. Handle Activity Feed
    const activityContainer = document.getElementById('activity-container');
    if (activityContainer) {
      window.f0ckDebug("[NotificationSystem] New Activity:", data);
      const html = this.renderActivityItem(data);
      const temp = document.createElement('div');
      temp.innerHTML = Sanitizer.clean(html);
      const node = temp.firstElementChild;
      node.classList.add('new-item-fade');
      activityContainer.prepend(node);

      // Optional: Remove last item to keep list from growing forever if needed
    }
  }

  renderActivityItem(c) {
    const avatar = c.avatar_file ? `/a/${c.avatar_file}` : (c.avatar && c.avatar > 0 ? `/t/${c.avatar}.webp` : '/a/default.png');

    let content = c.body || '';

    if (typeof marked !== 'undefined') {
      try {
        // Pre-process (greentext, html escape) similar to comments.js
        let safe = content
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");

        const renderer = new marked.Renderer();
        renderer.blockquote = function (quote) {
          let text = (typeof quote === 'string') ? quote : (quote.text || '');
          text = text.replace(/<p>|<\/p>/g, '');
          return text.split('\n').map(line => {
            if (!line.trim()) return '';
            return `<span class="greentext">&gt;${line}</span><br>`;
          }).join('');
        };

        const siteOrigin = window.location.origin;
        renderer.link = function (href, title, text) {
          if (typeof href === 'object' && href !== null) {
            title = href.title; text = href.text || text; href = href.href;
          }
          if (!href) return text || '';
          const isExternal = href.startsWith('http://') || href.startsWith('https://');
          const isSameSite = href.startsWith(siteOrigin);
          const titleAttr = title ? ` title="${title}"` : '';

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

        // Pre-process mentions before marked (skip greentext lines)
        safe = safe.split('\n').map(line => {
          if (line.trimStart().startsWith('>')) return line;
          return line.replace(/(?<!\[)@([a-zA-Z0-9_\-\.]+)(?!\])/g, '[@$1](/user/$1)');
        }).join('\n');

        content = marked.parse(safe, {
          gfm: true,
          breaks: true,
          renderer: renderer
        });
      } catch (e) {
        console.error('Marked error in w0bm.js', e);
        // Fallback
        content = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        content = content.replace(/^&gt;(.*)/gm, '<span class="greentext">&gt;$1</span>');
      }
    } else {
      // Fallback if marked not loaded
      content = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      content = content.replace(/^&gt;(.*)/gm, '<span class="greentext">&gt;$1</span>');
    }

    // Emoji replacement
    content = content.replace(/:([a-z0-9_]+):/g, (match, name) => {
      if (this.customEmojis[name]) {
        return `<img src="${this.customEmojis[name]}" style="height:24px;vertical-align:middle;" alt="${name}" title=":${name}:">`;
      }
      return match;
    });

    let itemPreview = '';
    // If we have item mime (which we now send from backend), we can show the preview
    if (c.mime) {
      let mediaHtml = '';
      if (c.mime.startsWith('image')) {
        mediaHtml = `<img src="/t/${c.item_id}.webp" style="width: 48px; height: 48px; object-fit: cover; border-radius: 2px;" />`;
      } else if (c.mime.startsWith('video')) {
        mediaHtml = `
                <div style="position: relative; display: block; width: 48px; height: 48px; background: #000; border-radius: 2px; overflow: hidden;">
                    <img src="/t/${c.item_id}.webp" style="width: 100%; height: 100%; object-fit: cover; opacity: 0.6;" />
                    <svg style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 20px; height: 20px; color: #fff;" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>`;
      } else {
        mediaHtml = `
                <div style="display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; background: #333; border-radius: 2px;">
                     <svg style="width: 24px; height: 24px; color: #666;" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>
                </div>`;
      }

      itemPreview = `
            <div class="item-preview" style="margin-top: 10px; display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,0.2); padding: 5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05);">
                <a href="/${c.item_id}">${mediaHtml}</a>
                <a href="/${c.item_id}#c${c.id}" style="font-size: 0.8em; color: var(--accent); text-decoration: none;">View Context &raquo;</a>
            </div>`;
    }

    return `
        <div class="comment" id="c${c.id}" style="margin-bottom: 20px; border-bottom: 1px solid #333; padding-bottom: 20px;">
            <div class="comment-avatar">
                <a href="/user/${c.username.toLowerCase()}">
                    <img src="${avatar}" alt="av">
                </a>
            </div>
            <div class="comment-body">
                <div class="comment-meta">
                    <a href="/user/${c.username.toLowerCase()}" class="comment-author" tooltip="ID: ${c.user_id}">${escHTML(c.display_name || c.username)}</a>
                    <span class="comment-time">Just now</span>
                </div>
                <div class="comment-content" style="white-space: pre-wrap;">${content}</div>
                ${itemPreview}
            </div>
        </div>`;
  }
}

// <pagination-ajax>
document.addEventListener('click', (e) => {
  // Only intercept clicks on pagination links
  const link = e.target.closest('a');
  if (link && link.closest('.pagination') && !link.classList.contains('disabled')) {
    const href = link.getAttribute('href');

    // Ensure it's not a modifier click
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;

    // Ensure it's an internal link
    if (href && (href.startsWith('/') || href.startsWith(window.location.origin)) && !href.startsWith('#')) {
      e.preventDefault();
      loadPageAjax(href);
    }
  }
});
// </pagination-ajax>

// Tag Show More/Less Logic
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('show-tags-toggle')) {
    e.preventDefault();
    const container = e.target.closest('#tags');
    if (!container) return;
    const isExpanded = container.classList.toggle('tags-expanded');
    const count = e.target.dataset.count;
    e.target.textContent = isExpanded ? 'show less' : `show ${count} more`;
  }
});

// Init Notifications
window.addEventListener('load', () => {
  window.NotificationSystemInstance = new NotificationSystem();
});

// Navbar & MOTD Logic
document.addEventListener("DOMContentLoaded", function () {
  // Toggle logic for dropdowns on mobile
  function setupToggle(btnId, menuId) {
    var btn = document.getElementById(btnId);
    var menu = document.getElementById(menuId);
    if (btn && menu) {
      btn.addEventListener('click', function (e) {
        if (window.innerWidth <= 700) {
          e.preventDefault();
          menu.classList.toggle('show-mobile');
        }
      });
    }
  }
  setupToggle('nav-user-toggle', 'nav-user-menu');
  setupToggle('nav-visitor-toggle', 'nav-visitor-menu');
  setupToggle('nav-mime-toggle', 'nav-mime-menu');
  setupToggle('nav-visitor-mime-toggle', 'nav-visitor-mime-menu');

  if (window.updateMimeLabel) window.updateMimeLabel();

  // Multi-Select MIME Logic
  const handleMimeChange = (menu) => {
    const checked = Array.from(menu.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
    
    // Construct new state
    let newMime = checked.join(',');
    
    // Briefly force the menu to stay open to prevent flickering/closing during the AJAX load
    const dropdown = menu.closest('.nav-mime-dropdown');
    if (dropdown) {
        dropdown.classList.add('stay-open');
        setTimeout(() => dropdown.classList.remove('stay-open'), 1000);
    }
    
    // Persist via cookie
    document.cookie = `mime=${newMime}; path=/; max-age=31536000; SameSite=Lax`;

    // Strip mime from URL immediately for a clean address bar
    const url = new URL(window.location.href);
    url.searchParams.delete('mime');
    // Also clean up path-based MIME if any (backward compatibility)
    let newPath = url.pathname.replace(/\/((?:video|audio|image|,)+)/, '').replace(/\/+/g, '/');
    if (newPath === '') newPath = '/';
    url.pathname = newPath;
    
    // Update the browser URL without reloading
    history.replaceState({}, '', url.toString());

    // Sync UI immediately (Before AJAX)
    if (window.updateMimeLabel) window.updateMimeLabel();

    // Trigger reload context-aware
    const fromModal = !!menu.closest('#excluded-tags-overlay');
    const postsEl = document.querySelector('.posts, .tags-grid');
    let reloadPromise = null;

    // Set flag so hideAllModals (called inside loadPageAjax) skips the filter overlay
    if (fromModal) window._keepFilterModal = true;

    if (postsEl) {
        reloadPromise = window.loadPageAjax ? window.loadPageAjax(url.toString(), { skipPush: true }) : null;
    } else if (document.getElementById('main')?.classList.contains('item-view') || document.querySelector('.item-layout-container, .item-main-content')) {
        // On item view, refresh the context but KEEP media playing
        reloadPromise = window.loadItemAjax ? window.loadItemAjax(url.toString(), true, { keepMedia: true }) : null;
    } else {
        // Fallback for non-AJAX pages
        if (!fromModal) window.location.reload();
    }

    // Clear the flag once the reload finishes (or immediately if no promise)
    if (fromModal) {
        Promise.resolve(reloadPromise).finally(() => {
            window._keepFilterModal = false;
        });
    }
  };

  document.querySelectorAll('.nav-mime-menu').forEach(menu => {
    menu.addEventListener('change', (e) => {
      if (e.target.type === 'checkbox') {
        handleMimeChange(menu);
      }
    });

    // Prevent menu closure on click inside
    menu.addEventListener('click', (e) => {
        e.stopPropagation();
    });
  });

  document.querySelectorAll('.nav-mime-clear').forEach(btn => {
      btn.addEventListener('click', (e) => {
          const menu = btn.closest('.nav-mime-menu');
          menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
          handleMimeChange(menu);
      });
  });

  // Close nav-collapse when clicking anywhere outside the navbar
  var navContent = document.getElementById('navbarContent');
  var navToggler = document.getElementById('nav-toggler');
  if (navContent) {
    document.addEventListener('click', function (e) {
      if (!navContent.classList.contains('show')) return;
      // If click is inside the navContent or on the toggler button, do nothing
      if (navContent.contains(e.target) || (navToggler && navToggler.contains(e.target))) return;
      // Close
      navContent.classList.remove('show');
      if (navToggler) navToggler.classList.remove('is-open');
    });

    // Auto-close when clicking any link inside the menu
    var contentLinks = navContent.querySelectorAll('a');
    contentLinks.forEach(function (link) {
      link.addEventListener('click', function (e) {
        if (window.innerWidth <= 768) {
          if (this.id === 'nav-notif-btn') {
            e.preventDefault();
            e.stopPropagation();
            return; // Do not close menu for notification bell
          }
          navContent.classList.remove('show');
          if (navToggler) navToggler.classList.remove('is-open');

          // Also collapse any sub-menus (dropdowns)
          var menus = navContent.querySelectorAll('.nav-user-menu');
          menus.forEach(function (m) {
            m.classList.remove('show-mobile');
          });
        }
      });
    });
  }

  // SSE for MOTD live updates
  window.updateMotdUI = function (motd) {
    const containers = [document.getElementById('motd-container')];
    const displays = [document.getElementById('motd-display')];
    const dataStores = [document.getElementById('motd-data')];
    const userPrefEl = document.getElementById('user-pref-show-motd');

    // Check visibility preference
    let showPref = true;
    if (userPrefEl) {
      showPref = userPrefEl.innerText.trim() === 'true';
    }

    // Local session override (hidden via 'X' button)
    // Reset dismissal if a NEW non-empty MOTD comes in
    const currentData = (dataStores[0] || dataStores[1])?.innerText || '';
    if (motd && motd !== currentData) {
      window['motd_dismissed'] = false;
    }

    if (userPrefEl && window['motd_dismissed']) showPref = false;

    if (typeof marked !== 'undefined') {
      let mdSafe = escHTML(motd || '');
      const bs = String.fromCharCode(92);
      // Fix the shruggie specifically since markdown eats it
      // Match ¯\_(ツ)_/¯ or ¯_(ツ)_/¯
      const pattern = new RegExp('¯' + bs + bs + '?_\\(ツ\\)_/¯', 'g');
      mdSafe = mdSafe.replace(pattern, '¯' + bs + bs + bs + '_(ツ)' + bs + '_/¯');
      const rendered = marked.parseInline(mdSafe);
      displays.forEach((display, i) => {
        if (display) {
          if (dataStores[i]) dataStores[i].innerText = motd;
          display.innerHTML = Sanitizer.clean(rendered);
          if (containers[i]) {
            const shouldShow = showPref && motd && motd.trim() !== '';
            containers[i].style.display = shouldShow ? 'block' : 'none';
          }
        }
      });
    }
  };

  // Handle "X" button dismiss site-wide
  document.addEventListener('click', async (e) => {
    if (e.target.classList.contains('motd-close')) {
      window['motd_dismissed'] = true;

      // Hide immediately
      const container = document.getElementById('motd-container');
      if (container) container.style.display = 'none';

      // Persist preference
      const userPrefEl = document.getElementById('user-pref-show-motd');
      if (userPrefEl) {
        // User: Update DB
        userPrefEl.innerText = 'false';
        try {
          await fetch('/api/v2/settings/motd', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ show: false })
          });
        } catch (err) { console.error('Failed to save MOTD pref:', err); }
      }
    }
  });

  // Initial render from hidden data
  const initialMotdEl = document.getElementById('motd-data');
  if (initialMotdEl) {
    updateMotdUI(initialMotdEl.innerText);
  }
});

// Mod Action Modal
class ModAction {
  static confirm(title, promptHtml, callback, options = {}) {
    const modal = document.getElementById('mod-action-modal');
    if (!modal) return window.flashMessage('Error: Mod modal not found', 3000, 'error');
    const titleEl = document.getElementById('mod-action-title');
    const contentEl = document.getElementById('mod-action-content');
    const reasonEl = document.getElementById('mod-reason');
    const confirmBtn = document.getElementById('mod-action-confirm');
    const cancelBtn = document.getElementById('mod-action-cancel');
    const errorEl = document.getElementById('mod-action-error');

    const singleLine = options.singleLine || false;
    const hideReason = options.hideReason || false;
    const allowEmpty = options.allowEmpty || false;
    const i18n = window.f0ckI18n || {};

    titleEl.innerText = title;
    if (options.unsafeContent) {
      contentEl.innerHTML = promptHtml; // Trusted admin-only content — skip sanitizer
    } else {
      contentEl.innerHTML = Sanitizer.clean(promptHtml);
    }

    reasonEl.value = '';
    errorEl.style.display = 'none';
    modal.style.display = 'flex';

    // Apply single-line mode: style the textarea to look and act like a text input
    if (singleLine) {
      reasonEl.rows = 1;
      reasonEl.style.resize = 'none';
      reasonEl.style.overflow = 'hidden';
      reasonEl.style.height = 'auto';
    } else {
      reasonEl.rows = 3;
      reasonEl.style.resize = '';
      reasonEl.style.overflow = '';
      reasonEl.style.height = '';
    }

    if (hideReason) {
      reasonEl.style.display = 'none';
    } else {
      reasonEl.style.display = 'block';
      reasonEl.placeholder = options.placeholder ||
        (allowEmpty ? (i18n.reason_optional || 'Reason (optional)') : (i18n.reason_required_label || 'Reason (required)'));
      reasonEl.focus();
    }

    confirmBtn.innerText = options.confirmText || (hideReason ? (i18n.confirm_yes || 'Yes') : (i18n.confirm_btn || 'Confirm'));
    cancelBtn.innerText = options.cancelText || (hideReason ? (i18n.confirm_no || 'No') : (i18n.cancel_btn || 'Cancel'));

    const close = () => {
      modal.style.display = 'none';
      cleanup();
    };

    const onConfirm = async () => {
      const reason = reasonEl.value.trim();
      if (!hideReason && !allowEmpty && !reason) {
        errorEl.innerText = (window.f0ckI18n && window.f0ckI18n.reason_required) || 'Reason is required.';
        errorEl.style.display = 'block';
        return;
      }
      errorEl.style.display = 'none';
      confirmBtn.disabled = true;
      confirmBtn.innerText = (window.f0ckI18n && window.f0ckI18n.processing) || 'Processing...';

      try {
        await callback(hideReason ? null : reason);
        close();
      } catch (e) {
        errorEl.innerText = e.message || 'Error occurred';
        errorEl.style.display = 'block';
        confirmBtn.disabled = false;
        confirmBtn.innerText = options.confirmText || (hideReason ? (i18n.confirm_yes || 'Yes') : (i18n.confirm_btn || 'Confirm'));
      }
    };

    // Block Enter from inserting newlines in single-line mode; instead submit
    const enterHandler = singleLine ? (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    } : null;
    if (enterHandler) reasonEl.addEventListener('keydown', enterHandler);

    const cleanup = () => {
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      if (enterHandler) reasonEl.removeEventListener('keydown', enterHandler);
      confirmBtn.disabled = false;
    };

    confirmBtn.onclick = onConfirm;
    cancelBtn.onclick = close;

    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
  }
}
window.ModAction = ModAction;

// Hover Video Preview
document.addEventListener('DOMContentLoaded', () => {
    window.updateVisitIndicators();
    window.initLazyLoading();
    const itemMatch = window.location.pathname.match(/^\/(\d+)\/?$/);
    if (itemMatch) window.trackVisit(itemMatch[1]);

    let hoverTimeout;
    let activeThumb = null;
    let activeVideo = null; // Store active video separately to clear immediately

    const clearPreview = () => {
        if (hoverTimeout) clearTimeout(hoverTimeout);
        if (activeVideo) {
            activeVideo.pause();
            activeVideo.removeAttribute('src'); 
            activeVideo.load();                
            activeVideo.remove();
            activeVideo = null;
        }
        if (activeThumb) {
            activeThumb.classList.remove('previewing');
            activeThumb.classList.remove('touch-active');
            activeThumb = null;
        }
    };
    window.clearHoverPreview = clearPreview;

    // Use mouseover/mouseout bubbling on document for dynamic elements
    const startPreview = (thumb, delay = 150) => {
         // Clear any existing preview
         clearPreview();
         
         // If this thumbnail is currently set to be blurred and is not revealed yet, do not preview it!
         const mode = thumb.getAttribute('data-mode');
         const blurNsfw = localStorage.getItem('blurNsfw') === 'true';
         const blurNsfl = localStorage.getItem('blurNsfl') === 'true';
         const blurSfw = localStorage.getItem('blurSfw') === 'true';
         const blurUntagged = localStorage.getItem('blurUntagged') === 'true';
         
         let shouldBlurThis = false;
         if (mode === 'nsfw') shouldBlurThis = blurNsfw;
         else if (mode === 'nsfl') shouldBlurThis = blurNsfl;
         else if (mode === 'sfw') shouldBlurThis = blurSfw;
         else if (mode === 'null' || !mode) shouldBlurThis = blurUntagged;
         
         if (shouldBlurThis && !thumb.classList.contains('revealed')) {
             return;
         }
         
         activeThumb = thumb;
         activeThumb.classList.add('touch-active'); // Visual feedback (box-shadow)

         const file = thumb.dataset.file;
         const mime = thumb.dataset.mime;
         
         // Only preview videos/gifs
         if (!file || !mime || (!mime.startsWith('video/') && mime !== 'image/gif') || mime === 'video/youtube') return;

         // Helper to actually start video
         const run = () => {
            if (!document.body.contains(thumb)) return; // Thumb removed
            if (thumb !== activeThumb) return; // Switched away

            activeThumb.classList.add('previewing');

            const video = document.createElement('video');
            video.src = `/b/${file}`;
            video.muted = true;
            video.loop = true;
            video.className = 'preview-video';
            video.playsInline = true;
            video.preload = 'auto';
            
            video.oncanplay = () => {
                video.play().catch(err => { /* Autoplay blocked */ });
                video.classList.add('playing');
            };

            thumb.appendChild(video);
            activeVideo = video;
         };

         if (delay === 0) {
             run();
         } else {
             hoverTimeout = setTimeout(run, delay);
         }
    };
    window.startHoverPreview = startPreview;

    document.addEventListener('mouseover', (e) => {
        const thumb = e.target.closest('.thumb');
        
        // If we are hovering a thumb, and it's NOT the active one
        if (thumb && thumb !== activeThumb) {
             startPreview(thumb, 150);
        }
    });

    document.addEventListener('mouseout', (e) => {
        const thumb = e.target.closest('.thumb');
        if (thumb) {
            if (e.relatedTarget && thumb.contains(e.relatedTarget)) return;
            clearPreview();
        }
    });

    // Touch handling to support "tap to activate" behavior
    // 1. First tap: Activate (visuals + preview) AND prevent navigation
    // 2. Second tap (on active): Navigate
    
    let touchBlockClick = false;
    
    document.addEventListener('touchstart', (e) => {
        const thumb = e.target.closest('.thumb');
        
        if (thumb) {
             // Only apply logic for items we want to preview
             // If it's a non-previewable item (e.g. just image), do we still want "tap to hover"?
             // User asked for "video/webm type" and "box shadow"
             // Box shadow applies to all .thumb via CSS
             
             if (thumb !== activeThumb) {
                 // First tap on this item: Activate
                 touchBlockClick = true;
                 startPreview(thumb, 0); // Instant start
             } else {
                 // Already active: Allow normal click propagation (navigation)
                 touchBlockClick = false;
             }
        } else {
             // Tapped background or something else -> Clear preview
             clearPreview();
        }
    }, { passive: true });

    // Capture phase click listener to stop navigation if we just activated
    document.addEventListener('click', (e) => {
        if (touchBlockClick) {
            const thumb = e.target.closest('.thumb');
            if (thumb && thumb === activeThumb) {
                e.preventDefault();
                e.stopImmediatePropagation();
                touchBlockClick = false; // Reset for next interaction
            }
        }
    }, true);

    // Global Timeago — uses Intl.RelativeTimeFormat for native, correctly-localized output
    const timeAgo = (date) => {
        const i18n = window.f0ckI18n || {};
        const lang = i18n.lang || navigator.language || 'en';
        const seconds = Math.floor((new Date() - new Date(date)) / 1000);

        if (seconds < 5) return i18n.timeago_just_now || 'just now';

        const intervals = [
            { unit: 'year',   seconds: 31536000 },
            { unit: 'month',  seconds: 2592000  },
            { unit: 'week',   seconds: 604800   },
            { unit: 'day',    seconds: 86400    },
            { unit: 'hour',   seconds: 3600     },
            { unit: 'minute', seconds: 60       },
            { unit: 'second', seconds: 1        }
        ];

        for (const interval of intervals) {
            const count = Math.floor(seconds / interval.seconds);
            if (count >= 1) {
                try {
                    // Force fallback for custom/unrecognized locales like 'zange'
                    if (lang === 'zange') throw new Error('Force fallback');
                    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
                    return rtf.format(-count, interval.unit);
                } catch (e) {
                    // Intl not available — fall back to i18n strings
                    const key = count === 1 ? `timeago_${interval.unit}` : `timeago_${interval.unit}s`;
                    const tpl = i18n[key] || `{n} ${interval.unit}${count !== 1 ? 's' : ''}`;
                    const timeStr = tpl.replace('{n}', count).replace('{s}', count !== 1 ? 's' : '');
                    const agoTpl = i18n.timeago_ago || '{t} ago';
                    return agoTpl.replace('{t}', timeStr);
                }
            }
        }
        return i18n.timeago_just_now || 'just now';
    };

    // Expose globally so comments.js, user_comments.js, messages.js etc. can use the same i18n-aware implementation
    window.f0ckTimeAgo = timeAgo;

    const updateGlobalTimestamps = () => {
        document.querySelectorAll('.timeago').forEach(el => {
            // Check tooltip attr first (item pages), fall back to data-ts (sidebar, no tooltip)
            const dateStr = el.getAttribute('tooltip') || el.getAttribute('data-ts');
            if (dateStr) {
                const newTime = timeAgo(dateStr);
                if (el.textContent !== newTime) {
                    el.textContent = newTime;
                }
            }
        });
    };
    // Expose globally so AJAX content hooks can re-stamp immediately after injection
    window.updateGlobalTimestamps = updateGlobalTimestamps;

    // Start global timer
    // Global Flash Message Helper
    window.showFlash = (message, type = 'success') => {
        const container = document.getElementById('flash-container');
        if (!container) return;

        const flash = document.createElement('div');
        flash.className = `flash-message flash-${type}`;
        flash.textContent = message;
        
        // Add close behavior on click
        flash.onclick = () => flash.remove();

        container.appendChild(flash);

        // Auto-remove after 8 seconds
        setTimeout(() => {
            if (flash.parentElement) {
                flash.style.opacity = '0';
                flash.style.transform = 'translateY(-20px)';
                setTimeout(() => flash.remove(), 300);
            }
        }, 8000);
    };

    // Selection-edit popover: shows an editable bubble near anchorEl pre-filled with selectedText.
    // onConfirm(trimmedValue) is called when the user submits.
    window._showSelTagPopover = (selectedText, anchorEl, onConfirm) => {
        // Remove any existing popover
        document.querySelector('.sel-tag-popover')?.remove();

        const pop = document.createElement('div');
        pop.className = 'sel-tag-popover';
        pop.innerHTML = `<input type="text" autocomplete="off" spellcheck="false"><button class="sel-tag-popover-confirm">${(window.f0ckI18n && window.f0ckI18n.add_tag) || 'Add tag'}</button>`;
        document.body.appendChild(pop);

        const input = pop.querySelector('input');
        const btn   = pop.querySelector('.sel-tag-popover-confirm');

        input.value = selectedText;

        // Position below anchor using fixed viewport coords
        const rect = anchorEl.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < 60) {
            // Not enough room below — show above
            pop.style.bottom = `${window.innerHeight - rect.top + 6}px`;
            pop.style.top = 'auto';
        } else {
            pop.style.top = `${rect.bottom + 6}px`;
        }
        pop.style.left = `${Math.min(rect.left, window.innerWidth - 280)}px`;

        // Auto-size input to its content
        const sizer = document.createElement('span');
        sizer.style.cssText = 'visibility:hidden;position:absolute;white-space:pre;font-size:0.85em;font-family:monospace;';
        document.body.appendChild(sizer);
        const resize = () => {
            sizer.textContent = input.value || ' ';
            input.style.width = `${Math.min(220, Math.max(60, sizer.offsetWidth + 10))}px`;
        };
        input.addEventListener('input', resize);
        resize();

        input.focus();
        input.select();

        const close = () => {
            pop.remove();
            sizer.remove();
            document.removeEventListener('mousedown', onOutside);
        };

        const submit = () => {
            const val = input.value.trim();
            if (val) onConfirm(val);
            close();
        };

        btn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { close(); }
        });

        const onOutside = (e) => {
            if (!pop.contains(e.target)) close();
        };
        setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
    };

    // Auto-open registration modal or show flash based on hash
    const handleHash = () => {
        const hash = window.location.hash;
        if (hash.startsWith('#register')) {
            const parts = hash.split(':');
            if (parts.length > 1) {
                if (parts[1] === 'error' && parts[2]) {
                    showFlash(decodeURIComponent(parts[2]), 'error');
                } else if (parts[1] === 'success' && parts[2]) {
                    showFlash(decodeURIComponent(parts[2]), 'success');
                } else if (parts[1] !== 'error' && parts[1] !== 'success') {
                    // Handle #register:TOKEN - Open modal
                    const modal = document.getElementById('register-modal');
                    if (modal) {
                        modal.style.display = 'flex';
                        const tokenInput = modal.querySelector('input[name="token"]');
                        if (tokenInput) tokenInput.value = parts[1];
                    }
                }
            } else {
                // Handle #register - Open modal
                const modal = document.getElementById('register-modal');
                if (modal) modal.style.display = 'flex';
            }
            // Clean up the URL hash so it doesn't look ugly
            history.replaceState(null, null, window.location.pathname + window.location.search);
        }

        // Sync sidebar and comments-list layout on initial page load (Legacy View Only)
        if (document.body.classList.contains('legacy-view')) {
        }
    };

    // Breakout Tooltips (prevents clipping globally)
    let breakoutTooltip = null;
    let currentTooltipTarget = null;

    const updateBreakoutPos = () => {
        if (!breakoutTooltip || !currentTooltipTarget) return;
        const rect = currentTooltipTarget.getBoundingClientRect();
        const flow = currentTooltipTarget.getAttribute('flow') || 'up';
        
        breakoutTooltip.setAttribute('data-flow', flow);

        const bRect = breakoutTooltip.getBoundingClientRect();
        let top = 0;
        let left = 0;

        if (flow === 'up' || flow === 'up-left') {
            top = rect.top - bRect.height - 4;
            if (flow === 'up-left') {
                left = rect.left + (rect.width / 2) - 15;
            } else {
                left = rect.left + (rect.width / 2) - (bRect.width / 2);
            }
        } else if (flow === 'down') {
            top = rect.bottom + 4;
            left = rect.left + (rect.width / 2) - (bRect.width / 2);
        } else if (flow === 'left') {
            top = rect.top + (rect.height / 2) - (bRect.height / 2);
            left = rect.left - bRect.width - 2;
        } else if (flow === 'right') {
            top = rect.top + (rect.height / 2) - (bRect.height / 2);
            left = rect.right + 4;
        }

        // Final clamp to screen
        const clampedTop  = Math.max(5, Math.min(top,  window.innerHeight - bRect.height - 5));
        const clampedLeft = Math.max(5, Math.min(left, window.innerWidth  - bRect.width  - 5));
        breakoutTooltip.style.top  = clampedTop  + 'px';
        breakoutTooltip.style.left = clampedLeft + 'px';

        // Point the arrow at the actual target center regardless of clamping
        if (flow === 'up' || flow === 'up-left' || flow === 'down') {
            const targetCenterX = rect.left + rect.width / 2;
            const arrowLeft = Math.round(targetCenterX - clampedLeft);
            // Keep the arrow within the tooltip bounds (with a small margin)
            const arrowClamped = Math.max(8, Math.min(arrowLeft, bRect.width - 8));
            breakoutTooltip.style.setProperty('--arrow-left', arrowClamped + 'px');
        }
    };

    const showTooltipFor = (target) => {
        const text = target.getAttribute('tooltip');
        if (!text) return;

        if (!breakoutTooltip) {
            breakoutTooltip = document.createElement('div');
            breakoutTooltip.id = 'f0ck-breakout-tooltip';
            document.body.appendChild(breakoutTooltip);
        }

        breakoutTooltip.textContent = text;
        currentTooltipTarget = target;
        // Position first (while invisible), then fade in on next frame
        breakoutTooltip.classList.remove('is-visible');
        updateBreakoutPos();
        requestAnimationFrame(() => {
            if (currentTooltipTarget === target) {
                breakoutTooltip.classList.add('is-visible');
            }
        });
        
        // Handle any scrolling parents
        let parent = target.parentElement;
        while (parent && parent !== document.body) {
            const style = window.getComputedStyle(parent);
            if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                parent.addEventListener('scroll', updateBreakoutPos, { passive: true });
                target._scrollParent = parent;
                break;
            }
            parent = parent.parentElement;
        }
    };

    const hideTooltip = () => {
        if (breakoutTooltip) {
            breakoutTooltip.classList.remove('is-visible');
        }
        if (currentTooltipTarget && currentTooltipTarget._scrollParent) {
            currentTooltipTarget._scrollParent.removeEventListener('scroll', updateBreakoutPos);
            currentTooltipTarget._scrollParent = null;
        }
        currentTooltipTarget = null;
    };

    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[tooltip]');
        if (target) {
            showTooltipFor(target);
        } else if (currentTooltipTarget) {
            hideTooltip();
        }
    });

    // Touch handling for mobile tooltips
    let tooltipTouchBlock = false;
    document.addEventListener('touchstart', (e) => {
        const target = e.target.closest('[tooltip]');
        if (target) {
            if (target !== currentTooltipTarget) {
                // First tap: Show tooltip and block navigation
                showTooltipFor(target);
                tooltipTouchBlock = true;
            } else {
                // Second tap: Allow navigation
                tooltipTouchBlock = false;
            }
        } else {
            // Tapped away: Hide
            hideTooltip();
        }
    }, { passive: true });

    // Capture phase listener to stop the very first tap from navigating
    document.addEventListener('click', (e) => {
        if (tooltipTouchBlock) {
            const target = e.target.closest('[tooltip]');
            if (target && target === currentTooltipTarget) {
                e.preventDefault();
                e.stopImmediatePropagation();
                tooltipTouchBlock = false; // Reset for next tap
            }
        }
    }, true);

    // Dismiss tooltips on scroll — use capture phase so it fires for ANY
    // scrollable container (e.g. comments list), not just the window.
    document.addEventListener('scroll', () => {
        if (currentTooltipTarget) {
            hideTooltip();
            tooltipTouchBlock = false;
        }
    }, { passive: true, capture: true });

    window.addEventListener('resize', hideTooltip);
    window.addEventListener('blur', hideTooltip);
    document.addEventListener('mouseleave', hideTooltip);


    handleHash();
    window.addEventListener('hashchange', handleHash);

    // Safety fallback: Hide tooltips on any subsequent navigation
    window.addEventListener('pjax:start', () => {
        hideTooltip();
    });

    // Start global timer
    setInterval(updateGlobalTimestamps, 30000);
    // Re-run immediately after any AJAX content injection (loadItemAjax / loadPageAjax)
    document.addEventListener('f0ck:contentLoaded', updateGlobalTimestamps);
    // Initial run
    updateGlobalTimestamps();
});

// Report System Logic
document.addEventListener('DOMContentLoaded', () => {
    const reportModal = document.getElementById('report-modal');
    if (!reportModal) return;
    
    const reportItemInput = document.getElementById('report-item-id');
    const reportCommentInput = document.getElementById('report-comment-id');
    const reportUserInput = document.getElementById('report-user-id');
    const reportReason = document.getElementById('report-reason');
    const reportError = document.getElementById('report-error');

    // Open item report
    document.addEventListener('click', (e) => {
        const itemBtn = e.target.closest('.report-item-btn');
        if (itemBtn) {
            e.preventDefault();
            reportItemInput.value = itemBtn.dataset.itemId;
            reportCommentInput.value = '';
            reportUserInput.value = '';
            reportReason.value = '';
            reportError.textContent = '';
            reportModal.style.display = 'flex';
            document.body.classList.add('modal-open');
        }

        const commentBtn = e.target.closest('.report-comment-btn');
        if (commentBtn) {
            e.preventDefault();
            reportItemInput.value = '';
            reportCommentInput.value = commentBtn.dataset.id;
            reportUserInput.value = '';
            reportReason.value = '';
            reportError.textContent = '';
            reportModal.style.display = 'flex';
            document.body.classList.add('modal-open');
        }

        const userBtn = e.target.closest('.report-user-btn'); // for future
        if (userBtn) {
            e.preventDefault();
            reportItemInput.value = '';
            reportCommentInput.value = '';
            reportUserInput.value = userBtn.dataset.userId;
            reportReason.value = '';
            reportError.textContent = '';
            reportModal.style.display = 'flex';
            document.body.classList.add('modal-open');
        }

        // Close logic
        if (e.target.matches('#report-cancel')) {
            reportModal.style.display = 'none';
            document.body.classList.remove('modal-open');
        }

        // Submit logic
        if (e.target.matches('#report-submit')) {
            const reason = reportReason.value.trim();
            if (!reason) {
                reportError.textContent = (window.f0ckI18n && window.f0ckI18n.reason_required) || 'Please provide a reason.';
                return;
            }

            const payload = new URLSearchParams();
            if (reportItemInput.value) payload.append('item_id', reportItemInput.value);
            if (reportCommentInput.value) payload.append('comment_id', reportCommentInput.value);
            if (reportUserInput.value) payload.append('reported_user_id', reportUserInput.value);
            payload.append('reason', reason);

            e.target.disabled = true;
            fetch('/api/v2/report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: payload
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    reportModal.style.display = 'none';
                    if (window.showFlash) window.showFlash((window.f0ckI18n && window.f0ckI18n.report_success) || 'Report submitted successfully.', 'success');
                    // Reset fields for future reports
                    reportReason.value = '';
                } else {
                    reportError.textContent = data.msg || (window.f0ckI18n && window.f0ckI18n.report_error) || 'An error occurred.';
                    if (window.showFlash) window.showFlash(data.msg || (window.f0ckI18n && window.f0ckI18n.report_error) || 'An error occurred.', 'error');
                }
            })
            .catch(err => {
                reportError.textContent = (window.f0ckI18n && window.f0ckI18n.network_error) || 'Network error.';
                if (window.showFlash) window.showFlash((window.f0ckI18n && window.f0ckI18n.network_error) || 'Network error.', 'error');
            })
            .finally(() => {
                e.target.disabled = false;
            });
        }
    });

    // Initial check for warnings
    if (window.f0ckSession && window.f0ckSession.logged_in) {
        const checkWarnings = async () => {
            try {
                const res = await fetch('/api/v2/user/warnings');
                const data = await res.json();
                if (data.success && data.warnings.length > 0) {
                    // Show the first warning
                    const warning = data.warnings[0];
                    const warningModal = document.getElementById('warning-modal');
                    if (warningModal) {
                        document.getElementById('warning-reason').textContent = warning.reason;
                        document.getElementById('warning-id').value = warning.id;
                        warningModal.style.display = 'flex';
                        document.body.classList.add('modal-open');
                    }
                }
            } catch (e) { console.error('Error fetching warnings', e); }
        };
        // Small delay to ensure session is fully initialized if needed
        // checkWarnings is now delivered via SSE on connection to avoid redundant polling.
        // setTimeout(checkWarnings, 1000);
        
        // Acknowledge warning
        const ackBtn = document.getElementById('warning-acknowledge');
        if (ackBtn) {
            ackBtn.addEventListener('click', async () => {
                const id = document.getElementById('warning-id').value;
                ackBtn.disabled = true;
                try {
                    const res = await fetch(`/api/v2/user/warnings/${id}/acknowledge`, { 
                        method: 'POST',
                        headers: { 'X-CSRF-Token': window.f0ckSession?.csrf_token }
                    });
                    const data = await res.json();
                    if (data.success) {
                        document.getElementById('warning-modal').style.display = 'none';
                        document.body.classList.remove('modal-open');
                        // Check for more warnings
                        checkWarnings();
                    } else {
                        window.flashMessage(data.msg || 'Error acknowledging warning', 3000, 'error');
                    }
                } catch (e) {
                    console.error('Network Error', e);
                } finally {
                    ackBtn.disabled = false;
                }
            });
        }
    }
});

  // <image-modal>
  const initImageModal = () => {
    const modal = document.getElementById('image-modal');
    const modalImg = document.getElementById('image-modal-img');
    const closeBtn = modal ? modal.querySelector('.image-modal-close') : null;

    if (!modal || !modalImg) return;

    let scale = 1;
    let posX = 0;
    let posY = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const applyTransform = () => {
      modalImg.style.transform = `translate(${posX}px, ${posY}px) scale(${scale})`;
    };

    const resetTransform = () => {
      scale = 1;
      posX = 0;
      posY = 0;
      applyTransform();
    };

    const openImageModal = (src) => {
      // Calculate scrollbar width to prevent layout shift
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
      
      modalImg.src = src;
      resetTransform();
      modal.classList.add('visible');
      document.body.classList.add('modal-open');
    };

    const closeImageModal = () => {
      if (modal) modal.classList.remove('visible');
      document.body.classList.remove('modal-open');
      if (modalImg) modalImg.src = '';
      resetTransform();
    };

    // Expose globally for guaranteed navigation cleanup
    window.closeImageModal = closeImageModal;

    // Zoom Logic
    const handleWheel = (e) => {
      if (!modal.classList.contains('visible')) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const newScale = Math.min(Math.max(0.1, scale + delta), 10);
      scale = newScale;
      applyTransform();
    };

    modal.addEventListener('wheel', handleWheel, { passive: false });

    // Pan Logic
    modalImg.draggable = false; // Disable native browser drag
    modalImg.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Left click only
      e.preventDefault(); // Prevent native drag ghosting (Note: this stops CSS :active)
      isDragging = true;
      startX = e.clientX - posX;
      startY = e.clientY - posY;
      modalImg.style.transition = 'none'; // Disable transition during drag for snappiness
      
      // Let hardened CSS handle multiple cursor fallbacks via class:
      document.body.classList.add('modal-is-grabbing');
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      posX = e.clientX - startX;
      posY = e.clientY - startY;
      applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      modalImg.style.transition = 'transform 0.05s ease-out';
      
      // Reset cursor class
      document.body.classList.remove('modal-is-grabbing');
    });

    // Double-click the image to close the modal
    modalImg.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      closeImageModal();
    });

    // Mobile Touch Logic (Pan & Pinch-to-Zoom)
    let initialTouchDist = null;
    let initialTouchScale = 1;

    modalImg.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        isDragging = true;
        startX = e.touches[0].clientX - posX;
        startY = e.touches[0].clientY - posY;
        modalImg.style.transition = 'none';
      } else if (e.touches.length === 2) {
        isDragging = false; // Disable pan while zooming
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialTouchDist = Math.sqrt(dx * dx + dy * dy);
        initialTouchScale = scale;
        modalImg.style.transition = 'none';
      }
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (!modal.classList.contains('visible')) return;
      e.preventDefault(); // Stop native elastic scrolling while open

      const isMobile = window.innerWidth <= 768;

      if (e.touches.length === 1 && isDragging) {
        // Prevent swiping/panning on mobile unless we're actually zoomed in
        if (!isMobile || scale > 1) {
          posX = e.touches[0].clientX - startX;
          posY = e.touches[0].clientY - startY;
          applyTransform();
        }
      } else if (e.touches.length === 2 && initialTouchDist) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const newScale = Math.min(Math.max(0.1, initialTouchScale * (dist / initialTouchDist)), 10);
        scale = newScale;
        
        // Re-center automatically if zooming out to 1x or less on mobile
        if (isMobile && scale <= 1) {
          posX = 0;
          posY = 0;
        }
        applyTransform();
      }
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) {
        initialTouchDist = null;
      }
      if (e.touches.length === 0) {
        isDragging = false;
        if (modalImg) modalImg.style.transition = 'transform 0.05s ease-out';
      }
    });

    // Close instantly on ESC or navigation hotkeys BEFORE PJAX fires
    document.addEventListener('keydown', (e) => {
      if (modal.classList.contains('visible')) {
        const key = e.key.toLowerCase();
        if (key === 'escape' || e.key.startsWith('Arrow') || ['a', 'd', 'r'].includes(key)) {
          closeImageModal();
        }
      }
    });

    // Safety fallback: Close on any subsequent navigation
    window.addEventListener('pjax:start', () => {
      if (modal.classList.contains('visible')) {
        closeImageModal();
      }
    });


    // Close on background click (anything NOT the image)
    modal.addEventListener('click', (e) => {
      if (e.target !== modalImg) {
        closeImageModal();
      }
    });

    // Global intercept for image item clicks
    document.addEventListener('click', (e) => {
      const elfe = e.target.closest('#elfe');
      if (elfe) {
        e.preventDefault();
        const expandOnClick = localStorage.getItem('imageExpandOnClick') !== 'false';
        if (expandOnClick) {
            const wrapper = elfe.closest('.embed-responsive');
            if (wrapper) {
                // If already expanded, always allow collapsing
                if (wrapper.classList.contains('is-expanded')) {
                    wrapper.classList.remove('is-expanded');
                    return;
                }
                // Only expand if the image is actually being clipped (not fully visible).
                // Compare the image's rendered height to its natural height —
                // if rendered >= natural, the image already fits fully in the box.
                const img = wrapper.querySelector('img#f0ck-image');
                if (img && img.complete && img.naturalHeight > 0) {
                    const rendered = img.getBoundingClientRect();
                    // Allow a 2px tolerance for subpixel rounding
                    if (rendered.height + 2 >= img.naturalHeight) {
                        // Fully visible — do nothing (no expand needed, no modal)
                        return;
                    }
                }
                wrapper.classList.add('is-expanded');
            }
        } else {
            openImageModal(elfe.href);
        }
        return;
      }

      // Comment embedded images → open in image modal (skip emoji images)
      const commentImg = e.target.closest('.comment-content img, .comment-attachments img');
      if (commentImg && !commentImg.classList.contains('emoji')) {
        e.preventDefault();
        e.stopPropagation();
        openImageModal(commentImg.src);
      }
    });
  };

  initImageModal();
  // </image-modal>

  // Halls Management (Admin Only / My Halls for all logged-in users)
  document.addEventListener('click', async (e) => {
    // Add to Hall
    const hallBtn = e.target.closest('#a_hall');
    if (hallBtn) {
        e.preventDefault();
        const itemid = hallBtn.dataset.itemId;
        const modal = document.getElementById('halls-modal');
        const select = document.getElementById('hall-select');
        const error = document.getElementById('halls-modal-error');
        const confirmBtn = document.getElementById('halls-modal-confirm');
        const siteHallRemoveBtn = document.getElementById('halls-modal-remove');
        const cancelBtn = document.getElementById('halls-modal-cancel');

        if (!modal) return window.flashMessage('Error: Halls modal not found', 3000, 'error');

        // Reset — admin-only elements need null guards for regular users
        if (select) select.innerHTML = '<option value="">-- Choose a Hall --</option>';
        if (error) error.style.display = 'none';
        if (confirmBtn) confirmBtn.style.display = 'block';
        if (siteHallRemoveBtn) siteHallRemoveBtn.style.display = 'none';
        modal.style.display = 'flex';

        // --- My Halls section ---
        const myHallsSection = document.getElementById('my-halls-section');
        const myHallsSelect = document.getElementById('my-hall-select');
        const myHallsConfirmBtn = document.getElementById('my-halls-modal-confirm');
        const myHallsCreate = document.getElementById('my-hall-create-wrap');
        const myHallsNewName = document.getElementById('my-hall-new-name');
        const myHallsError = document.getElementById('my-halls-modal-error');

        const isLoggedIn = window.f0ckSession && window.f0ckSession.logged_in;
        const csrf = window.f0ckSession?.csrf_token || '';

        if (myHallsSection) {
            myHallsSection.style.display = isLoggedIn ? '' : 'none';
        }
        if (myHallsError) myHallsError.style.display = 'none';

        // Load mod/admin site halls (only if the select element exists)
        if (select) {
          try {
              const resp = await fetch('/ajax/halls');
              const allHalls = await resp.json();
              allHalls.forEach(h => {
                  const opt = document.createElement('option');
                  opt.value = h.slug;
                  opt.textContent = h.name;
                  select.appendChild(opt);
              });
              // Pre-select current hall
              const _currentHallSlug = hallBtn.dataset.currentHall
                  || (window.location.pathname.match(/^\/h\/([^\/]+)/) ? decodeURIComponent(window.location.pathname.match(/^\/h\/([^\/]+)/)[1]) : null)
                  || (hallBtn.dataset.halls ? hallBtn.dataset.halls.split(",").filter(Boolean)[0] : null);
              if (_currentHallSlug) select.value = _currentHallSlug;

              // Show Remove button if the selected hall is one the item already belongs to
              const siteHallsOnItem = (hallBtn.dataset.halls || '').split(',').filter(Boolean);
              const syncSiteRemoveBtn = () => {
                  if (!siteHallRemoveBtn) return;
                  const slug = select.value;
                  siteHallRemoveBtn.style.display = (slug && siteHallsOnItem.includes(slug)) ? '' : 'none';
              };
              syncSiteRemoveBtn();
              select.addEventListener('change', syncSiteRemoveBtn);
          } catch (err) {
              console.error('Failed to fetch halls:', err);
          }
        }

        // Load user's own halls
        const myHallsRemoveBtn = document.getElementById('my-halls-modal-remove');


        // Determine current user hall context via multiple sources:
        // 1. data-current-user-hall attribute (set by server when item loaded in hall context, or patched after add)
        // 2. URL parsing (/user/:owner/hall/:slug/...)
        // 3. data-user-halls fallback (item already in halls — pick first)
        let currentUserHall = hallBtn.dataset.currentUserHall || null;
        let currentUserHallOwner = hallBtn.dataset.currentUserHallOwner || null;
        if (!currentUserHall) {
            const urlHallMatch = window.location.pathname.match(/\/user\/([^/]+)\/hall\/([^/]+)/);
            if (urlHallMatch) {
                currentUserHallOwner = decodeURIComponent(urlHallMatch[1]);
                currentUserHall = decodeURIComponent(urlHallMatch[2]);
            }
        }
        const userHallsOnItem = (hallBtn.dataset.userHalls || '').split(',').filter(Boolean);
        // Fallback: if item is already in user halls but we have no context, pre-select the first one
        if (!currentUserHall && userHallsOnItem.length > 0) {
            currentUserHall = userHallsOnItem[0];
        }

        if (isLoggedIn && myHallsSelect) {
            myHallsSelect.innerHTML = `<option value="">${window.f0ckI18n?.hall_my_placeholder || '-- My Hall --'}</option>`;
            try {
                const resp = await fetch('/api/v2/me/halls');
                const data = await resp.json();
                if (data.success && data.halls.length) {
                    data.halls.forEach(h => {
                        const opt = document.createElement('option');
                        opt.value = h.slug;
                        opt.textContent = h.name + (h.is_private ? ' 🔒' : '');
                        myHallsSelect.appendChild(opt);
                    });
                    // Pre-select
                    if (currentUserHall) {
                        myHallsSelect.value = currentUserHall;
                    }
                } else if (data.success) {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = window.f0ckI18n?.hall_no_halls || 'No halls yet — create one!';
                    opt.disabled = true;
                    myHallsSelect.appendChild(opt);
                }
            } catch (err) {
                console.error('Failed to fetch user halls:', err);
            }

            // Show Remove when the selected hall is one the item is already in
            function syncRemoveBtn() {
                if (!myHallsRemoveBtn) return;
                const slug = myHallsSelect.value;
                myHallsRemoveBtn.style.display = (slug && userHallsOnItem.includes(slug)) ? '' : 'none';
            }
            syncRemoveBtn();
            myHallsSelect.addEventListener('change', syncRemoveBtn);
        }

        const close = () => {
            modal.style.display = 'none';
            if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = window.f0ckI18n?.hall_add_btn || 'Add to Hall'; confirmBtn.onclick = null; }
            if (siteHallRemoveBtn) { siteHallRemoveBtn.disabled = false; siteHallRemoveBtn.textContent = window.f0ckI18n?.hall_remove_btn || 'Remove from Hall'; siteHallRemoveBtn.style.display = 'none'; siteHallRemoveBtn.onclick = null; }
            if (cancelBtn) cancelBtn.onclick = null;
            if (select) select.onchange = null;
            if (myHallsConfirmBtn) { myHallsConfirmBtn.disabled = false; myHallsConfirmBtn.textContent = window.f0ckI18n?.hall_add_btn || 'Add'; myHallsConfirmBtn.onclick = null; }
            modal.onclick = null;
            if (myHallsRemoveBtn) myHallsRemoveBtn.onclick = null;
        };

        // Site hall confirm (mod/admin)
        const onConfirm = async () => {
            const hallSlug = select.value;
            if (!hallSlug) {
                error.textContent = window.f0ckI18n?.hall_select_a_hall || 'Please select a hall.';
                error.style.display = 'block';
                return;
            }

            confirmBtn.disabled = true;
            confirmBtn.textContent = window.f0ckI18n?.hall_adding || 'Adding...';

            try {
                const resp = await fetch('/mod/halls/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `id=${itemid}&hall=${encodeURIComponent(hallSlug)}`
                });
                const data = await resp.json();
                if (data.success) {
                    if (window.flashMessage) window.flashMessage((window.f0ckI18n && window.f0ckI18n.hall_added) || 'Added to hall!');
                    if (window.loadItemAjax) window.loadItemAjax(window.location.href, true, { keepMedia: true });
                    close();
                } else {
                    throw new Error(data.msg || 'Failed to add to hall');
                }
            } catch (err) {
                error.textContent = err.message;
                error.style.display = 'block';
                confirmBtn.disabled = false;
                confirmBtn.textContent = window.f0ckI18n?.hall_add_btn || 'Add to Hall';
            }
        };

        // My Hall confirm
        const onMyHallConfirm = async () => {
            if (!myHallsSelect || !myHallsConfirmBtn || !myHallsError) return;
            let hallSlug = myHallsSelect.value;

            // Create new hall inline if requested
            if (!hallSlug && myHallsNewName && myHallsNewName.value.trim()) {
                const newName = myHallsNewName.value.trim();
                const newSlug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                try {
                    myHallsConfirmBtn.disabled = true;
                    myHallsConfirmBtn.textContent = window.f0ckI18n?.hall_creating || 'Creating…';
                    const r = await fetch('/api/v2/me/halls', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
                        body: JSON.stringify({ name: newName, slug: newSlug })
                    });
                    const d = await r.json();
                    if (!d.success) throw new Error(d.message || d.msg || 'Failed to create');
                    hallSlug = newSlug;
                } catch (err) {
                    myHallsError.textContent = err.message;
                    myHallsError.style.display = 'block';
                    myHallsConfirmBtn.disabled = false;
                    myHallsConfirmBtn.textContent = window.f0ckI18n?.hall_add_btn || 'Add';
                    return;
                }
            }

            if (!hallSlug) {
                myHallsError.textContent = window.f0ckI18n?.hall_choose_or_create || 'Choose a hall or enter a new name.';
                myHallsError.style.display = 'block';
                return;
            }

            myHallsConfirmBtn.disabled = true;
            myHallsConfirmBtn.textContent = window.f0ckI18n?.hall_adding || 'Adding…';
            try {
                const resp = await fetch(`/api/v2/me/halls/${encodeURIComponent(hallSlug)}/items`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
                    body: JSON.stringify({ item_id: itemid })
                });
                const data = await resp.json();
                if (data.success) {
                    myHallsConfirmBtn.disabled = false;
                    myHallsConfirmBtn.textContent = window.f0ckI18n?.hall_add_btn || 'Add';
                    // Patch the live #a_hall button NOW so next modal open pre-selects correctly
                    // (before loadItemAjax finishes re-rendering the DOM)
                    const liveHallBtn = document.getElementById('a_hall');
                    if (liveHallBtn) {
                        liveHallBtn.dataset.currentUserHall = hallSlug;
                        const existing = (liveHallBtn.dataset.userHalls || '').split(',').filter(Boolean);
                        if (!existing.includes(hallSlug)) existing.push(hallSlug);
                        liveHallBtn.dataset.userHalls = existing.join(',');
                    }
                    if (window.flashMessage) window.flashMessage((window.f0ckI18n && window.f0ckI18n.hall_added) || 'Added to hall!');
                    if (window.loadItemAjax) window.loadItemAjax(window.location.href, true, { keepMedia: true });
                    close();
                } else {
                    throw new Error(data.message || data.msg || 'Failed to add');
                }
            } catch (err) {
                myHallsError.textContent = err.message;
                myHallsError.style.display = 'block';
                myHallsConfirmBtn.disabled = false;
                myHallsConfirmBtn.textContent = window.f0ckI18n?.hall_add_btn || 'Add';
            }
        };

        if (confirmBtn) confirmBtn.onclick = onConfirm;
        if (siteHallRemoveBtn) {
            siteHallRemoveBtn.onclick = async () => {
                const hallSlug = select ? select.value : '';
                if (!hallSlug) return;
                if (!confirm(`Remove from hall "${hallSlug}"?`)) return;
                siteHallRemoveBtn.disabled = true;
                siteHallRemoveBtn.textContent = window.f0ckI18n?.hall_removing || 'Removing…';
                try {
                    const resp = await fetch('/mod/halls/remove', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: `id=${itemid}&hall=${encodeURIComponent(hallSlug)}`
                    });
                    const data = await resp.json();
                    if (data.success) {
                        if (window.flashMessage) window.flashMessage((window.f0ckI18n && window.f0ckI18n.hall_removed) || 'Removed from hall!');
                        if (window.loadItemAjax) window.loadItemAjax(window.location.href, true, { keepMedia: true });
                        close();
                    } else {
                        throw new Error(data.msg || 'Failed to remove from hall');
                    }
                } catch (err) {
                    if (error) { error.textContent = err.message; error.style.display = 'block'; }
                    siteHallRemoveBtn.disabled = false;
                    siteHallRemoveBtn.textContent = 'Remove from Hall';
                }
            };
        }
        if (cancelBtn) cancelBtn.onclick = close;
        if (myHallsConfirmBtn) myHallsConfirmBtn.onclick = onMyHallConfirm;
        if (myHallsRemoveBtn) {
            myHallsRemoveBtn.onclick = async () => {
                const slug = myHallsSelect ? myHallsSelect.value : '';
                if (!slug) return;
                myHallsRemoveBtn.disabled = true;
                myHallsRemoveBtn.textContent = 'Removing…';
                try {
                    const resp = await fetch(`/api/v2/me/halls/${encodeURIComponent(slug)}/items/${itemid}`, {
                        method: 'DELETE',
                        headers: { 'x-csrf-token': csrf }
                    });
                    const data = await resp.json();
                    if (data.success) {
                        myHallsRemoveBtn.disabled = false;
                        myHallsRemoveBtn.textContent = 'Remove';
                        window.flashMessage((window.f0ckI18n && window.f0ckI18n.hall_removed) || 'Removed from hall!');
                        if (window.loadItemAjax) window.loadItemAjax(window.location.href, true, { keepMedia: true });
                        close();
                    } else {
                        throw new Error(data.message || data.msg || 'Failed to remove');
                    }
                } catch (err) {
                    if (myHallsError) { myHallsError.textContent = err.message; myHallsError.style.display = 'block'; }
                    myHallsRemoveBtn.disabled = false;
                    myHallsRemoveBtn.textContent = 'Remove';
                }
            };
        }
        modal.onclick = (ev) => { if (ev.target === modal) close(); };
    }


    // Remove from Hall
    const removeBtn = e.target.closest('.remove-from-hall');
    if (removeBtn) {
        e.preventDefault();
        if (!confirm('Remove from this hall?')) return;

        const container = document.getElementById('comments-container');
        const itemid = container ? container.dataset.itemId : null;
        const hallSlug = removeBtn.dataset.hall;

        if (!itemid || !hallSlug) return window.flashMessage('Error: Missing itemid or hallSlug', 3000, 'error');

        const resp = await fetch('/mod/halls/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `id=${itemid}&hall=${encodeURIComponent(hallSlug)}`
        });
        const data = await resp.json();
        if (data.success) {
            // Refresh item view to remove hall badge
            if (window.loadItemAjax) window.loadItemAjax(window.location.href, true, { keepMedia: true });
        } else {
            window.flashMessage(data.msg || 'Failed to remove from hall', 3000, 'error');
        }
    }
  });

  // Forced Password Change Logic
  const forcePasswordForm = document.getElementById('force-password-form');
  if (forcePasswordForm) {
      forcePasswordForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const new_password = document.getElementById('force_new_password').value;
          const new_password_confirm = document.getElementById('force_new_password_confirm').value;
          const status = document.getElementById('force-password-status');
          const btn = forcePasswordForm.querySelector('button');

          if (new_password !== new_password_confirm) {
              status.textContent = 'Passwords do not match.';
              status.style.display = 'block';
              status.style.background = 'rgba(217, 83, 79, 0.2)';
              status.style.color = '#d9534f';
              return;
          }

          if (new_password.length < 20) {
              status.textContent = 'Password must be at least 20 characters long.';
              status.style.display = 'block';
              status.style.background = 'rgba(217, 83, 79, 0.2)';
              status.style.color = '#d9534f';
              return;
          }

          btn.disabled = true;
          btn.textContent = 'Updating...';
          status.style.display = 'none';

          try {
              const res = await fetch('/api/v2/settings/password', {
                  method: 'PUT',
                  headers: { 
                      'Content-Type': 'application/json',
                      'X-CSRF-Token': window.f0ckSession?.csrf_token
                  },
                  body: JSON.stringify({ new_password, new_password_confirm })
              });

              const json = await res.json();
              if (json.success) {
                  status.textContent = 'Password updated! Redirecting...';
                  status.style.display = 'block';
                  status.style.background = 'rgba(92, 184, 92, 0.2)';
                  status.style.color = '#5cb85c';
                  setTimeout(() => {
                      window.location.reload();
                  }, 1500);
              } else {
                  status.textContent = json.msg || 'Error updating password.';
                  status.style.display = 'block';
                  status.style.background = 'rgba(217, 83, 79, 0.2)';
                  status.style.color = '#d9534f';
                  btn.disabled = false;
                  btn.textContent = 'Update Password';
              }
          } catch (err) {
              status.textContent = 'Network error.';
              status.style.display = 'block';
              status.style.background = 'rgba(217, 83, 79, 0.2)';
              status.style.color = '#d9534f';
              btn.disabled = false;
              btn.textContent = 'Update Password';
          }
      });
  }

})();

// ── Steuerung haptic feedback ─────────────────────────────────────────────────
// Short vibration when tapping .steuerung nav links on mobile.
if (navigator.vibrate) {
  document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.steuerung a')) {
      navigator.vibrate(30);
    }
  }, { passive: true });
}

// ── Spoiler Tags Event Delegation ─────────────────────────────────────────────
(function() {
    const isHidden = (el) => el && el.classList && (el.classList.contains('spoiler') || el.classList.contains('blur-text'));

    const reveal = (target) => {
        const path = target.composedPath ? target.composedPath() : [];
        const hiddenEl = path.find(isHidden) || target.closest('.spoiler, .blur-text');
        if (hiddenEl && !hiddenEl.classList.contains('revealed')) {
            hiddenEl.classList.add('revealed');
            hiddenEl.querySelectorAll('video, audio, img, iframe').forEach(m => m.classList.add('revealed'));
            return true;
        }
        return false;
    };

    // Capture clicks and pointer events (pointerdown is faster and catches native controls better)
    document.addEventListener('pointerdown', (e) => {
        const path = e.composedPath();
        const hiddenEl = path.find(isHidden);
        if (!hiddenEl) return;

        if (!hiddenEl.classList.contains('revealed')) {
            hiddenEl.classList.add('revealed');
            hiddenEl.querySelectorAll('video, audio, img, iframe, .video-embed-wrap, .yt-embed-wrap, .audio-embed-wrap').forEach(m => m.classList.add('revealed'));
            return;
        }

        // Only handle re-hiding on the container itself or non-interactive parts
        const interactive = path.find(el => 
            el.tagName === 'A' || el.tagName === 'VIDEO' || el.tagName === 'AUDIO' || 
            el.tagName === 'IFRAME' || el.tagName === 'BUTTON' || el.tagName === 'INPUT' ||
            (el.classList && (el.classList.contains('video-embed-wrap') || el.classList.contains('yt-embed-wrap') || el.classList.contains('audio-embed-wrap') || el.classList.contains('sidebar-video-link')))
        );

        if (interactive) {
            // Ensure clicked/interactive media also gets revealed class
            hiddenEl.querySelectorAll('video, audio, img, iframe, .video-embed-wrap, .yt-embed-wrap, .audio-embed-wrap').forEach(m => {
                if (m === interactive || m.contains(e.target) || interactive.contains(m)) {
                    m.classList.add('revealed');
                }
            });
            return;
        }

        hiddenEl.classList.remove('revealed');
        hiddenEl.querySelectorAll('video, audio, img, iframe, .video-embed-wrap, .yt-embed-wrap, .audio-embed-wrap').forEach(m => m.classList.remove('revealed'));
    }, { capture: true, passive: true });

    // Catch focus shifts to iframes (YouTube) which don't bubble click events
    window.addEventListener('blur', () => {
        // Use a short delay to ensure document.activeElement has updated
        setTimeout(() => {
            const active = document.activeElement;
            if (active && active.tagName === 'IFRAME') {
                const hiddenEl = active.closest('.spoiler, .blur-text');
                if (hiddenEl && !hiddenEl.classList.contains('revealed')) {
                    hiddenEl.classList.add('revealed');
                    active.classList.add('revealed');
                    const wrap = active.closest('.yt-embed-wrap, .video-embed-wrap, .audio-embed-wrap');
                    if (wrap) wrap.classList.add('revealed');
                }
            }
        }, 100);
    });

    // Catch the 'play' event which fires when the video starts, even if UI swallows the click
    document.addEventListener('play', (e) => {
        const hiddenEl = e.target.closest('.spoiler, .blur-text');
        if (hiddenEl) {
            hiddenEl.classList.add('revealed');
            e.target.classList.add('revealed');
            const wrap = e.target.closest('.video-embed-wrap, .yt-embed-wrap, .audio-embed-wrap');
            if (wrap) wrap.classList.add('revealed');
        }
    }, true);
  
    // Retroactive Metadata Extraction Logic
    document.addEventListener('click', async (e) => {
        const metaBtn = e.target.closest('#a_metadata');
        if (metaBtn) {
            e.preventDefault();
            const itemid = metaBtn.dataset.itemId;
            const modal = document.getElementById('metadata-modal');
            if (!modal) return;

            const list = document.getElementById('metadata-suggestion-list');
            const loading = document.getElementById('metadata-loading');
            const resultsCont = document.getElementById('metadata-results');
            const error = document.getElementById('metadata-error');
            const noResults = document.getElementById('metadata-no-results');

            modal.style.display = 'flex';
            document.body.classList.add('modal-open');
            loading.style.display = 'block';
            resultsCont.style.display = 'none';
            error.style.display = 'none';
            noResults.style.display = 'none';
            list.innerHTML = '';

            const close = () => { 
                modal.style.display = 'none';
                document.body.classList.remove('modal-open');
                document.removeEventListener('keydown', onEsc);
                window.removeEventListener('pjax:start', onNav);
                document.removeEventListener('f0ck:contentLoaded', onContentLoaded);
            };
            const onEsc = (ev) => { if (ev.key === 'Escape') close(); };

            // When navigation starts while modal is open: show loading spinner and wait for new content
            const onNav = () => {
                // Reset modal to loading state for the incoming item
                loading.style.display = 'block';
                resultsCont.style.display = 'none';
                error.style.display = 'none';
                noResults.style.display = 'none';
                list.innerHTML = '';
                // Listen for content to finish loading, then reload with new item's metadata
                document.addEventListener('f0ck:contentLoaded', onContentLoaded, { once: true });
                window.removeEventListener('pjax:start', onNav);
            };

            const onContentLoaded = async () => {
                // Find the new item's metadata button
                const newMetaBtn = document.getElementById('a_metadata');
                if (!newMetaBtn) {
                    // New item doesn't support metadata extraction (YouTube, Flash, etc.)
                    // Keep modal open but show a friendly message instead of closing
                    loading.style.display = 'none';
                    resultsCont.style.display = 'none';
                    error.textContent = 'Cannot extract metadata for this type of content.';
                    error.style.display = 'block';
                    // Re-attach nav listener so user can still navigate away
                    window.addEventListener('pjax:start', onNav);
                    return;
                }
                const newItemId = newMetaBtn.dataset.itemId;
                // Re-attach nav listener for subsequent navigations
                window.addEventListener('pjax:start', onNav);
                // Fetch metadata for the new item
                try {
                    const resp = await fetch(`/api/v2/meta/extract/item/${newItemId}`);
                    const data = await resp.json();
                    loading.style.display = 'none';
                    if (data.success && data.fields && data.fields.length > 0) {
                        resultsCont.style.display = 'block';
                        const tagsDiv = document.querySelector('#tags');
                        const currentTags = tagsDiv ? Array.from(tagsDiv.querySelectorAll('.badge a')).map(a => a.textContent.trim().toLowerCase()) : [];
                        list.innerHTML = '';
                        data.fields.forEach(field => {
                            const pill = document.createElement('div');
                            pill.className = 'meta-suggestion';
                            const isSelected = currentTags.includes(field.toLowerCase());
                            if (isSelected) pill.classList.add('selected');
                            pill.innerHTML = `<i class="fa-solid ${isSelected ? 'fa-check-circle' : 'fa-plus-circle'}" style="user-select:none"></i> <span></span>`;
                            pill.querySelector('span').textContent = field;

                            pill.addEventListener('mouseup', (ev) => {
                                const sel = window.getSelection?.()?.toString().trim();
                                if (!sel) return;
                                pill.addEventListener('click', (e) => e.stopImmediatePropagation(), { once: true, capture: true });
                                ev.stopPropagation();
                                window._showSelTagPopover?.(sel, pill, async (confirmed) => {
                                    window.getSelection?.()?.removeAllRanges();
                                    try {
                                        const addResp = await fetch(`/api/v2/tags/${newItemId}`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.f0ckSession?.csrf_token },
                                            body: JSON.stringify({ tagname: confirmed })
                                        });
                                        const addData = await addResp.json();
                                        if (addData.success) {
                                            if (window.renderTags) window.renderTags(addData.tags, confirmed);
                                            if (window.showFlash) window.showFlash(`Tag "${confirmed}" added!`);
                                        } else {
                                            if (window.showFlash) window.showFlash(addData.msg || 'Error adding tag', 'error');
                                        }
                                    } catch (_) {
                                        if (window.showFlash) window.showFlash('Network error', 'error');
                                    }
                                });
                            });

                            pill.onclick = async (ev) => {
                                ev.stopPropagation();
                                if (pill.classList.contains('selected')) return;
                                pill.style.opacity = '0.5';
                                pill.style.pointerEvents = 'none';
                                try {
                                    const addResp = await fetch(`/api/v2/tags/${newItemId}`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.f0ckSession?.csrf_token },
                                        body: JSON.stringify({ tagname: field })
                                    });
                                    const addData = await addResp.json();
                                    if (addData.success) {
                                        pill.classList.add('selected');
                                        pill.querySelector('i').className = 'fa-solid fa-check-circle';
                                        if (window.renderTags) window.renderTags(addData.tags, field);
                                        if (window.showFlash) window.showFlash(`Tag "${field}" added!`);
                                    } else {
                                        if (window.showFlash) window.showFlash(addData.msg || 'Error adding tag', 'error');
                                    }
                                } catch (_) {
                                    if (window.showFlash) window.showFlash('Network error', 'error');
                                } finally {
                                    pill.style.opacity = '';
                                    pill.style.pointerEvents = '';
                                }
                            };
                            list.appendChild(pill);
                        });
                    } else if (data.success) {
                        resultsCont.style.display = 'block';
                        noResults.style.display = 'block';
                    } else {
                        error.textContent = data.msg || 'Extraction failed';
                        error.style.display = 'block';
                    }
                } catch (err) {
                    loading.style.display = 'none';
                    error.textContent = 'Network error';
                    error.style.display = 'block';
                }
            };

            document.addEventListener('keydown', onEsc);
            window.addEventListener('pjax:start', onNav);

            document.getElementById('metadata-modal-close')?.addEventListener('click', close);
            document.getElementById('metadata-modal-cancel')?.addEventListener('click', close);
            modal.onclick = (ev) => { if (ev.target === modal) close(); };
            document.addEventListener('metadata-modal-close', close, { once: true });

            try {
                const resp = await fetch(`/api/v2/meta/extract/item/${itemid}`);
                const data = await resp.json();
                loading.style.display = 'none';

                if (data.success && data.fields && data.fields.length > 0) {
                    resultsCont.style.display = 'block';
                    
                    // Get current tags to determine selected state
                    const tagsDiv = document.querySelector('#tags');
                    const currentTags = Array.from(tagsDiv.querySelectorAll('.badge a')).map(a => a.textContent.trim().toLowerCase());

                    data.fields.forEach(field => {
                        const pill = document.createElement('div');
                        pill.className = 'meta-suggestion';
                        const isSelected = currentTags.includes(field.toLowerCase());
                        if (isSelected) pill.classList.add('selected');
                        
                        pill.innerHTML = `<i class="fa-solid ${isSelected ? 'fa-check-circle' : 'fa-plus-circle'}" style="user-select:none"></i> <span></span>`;
                        pill.querySelector('span').textContent = field;
                        
                        // mouseup fires after a drag-select; click only fires for plain clicks
                        pill.addEventListener('mouseup', (ev) => {
                            const sel = window.getSelection?.()?.toString().trim();
                            if (!sel) return;
                            // Block the click that would follow this mouseup
                            pill.addEventListener('click', (e) => e.stopImmediatePropagation(), { once: true, capture: true });
                            ev.stopPropagation();
                            window._showSelTagPopover?.(sel, pill, async (confirmed) => {
                                window.getSelection?.()?.removeAllRanges();
                                try {
                                    const addResp = await fetch(`/api/v2/tags/${itemid}`, {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'X-CSRF-Token': window.f0ckSession?.csrf_token
                                        },
                                        body: JSON.stringify({ tagname: confirmed })
                                    });
                                    const addData = await addResp.json();
                                    if (addData.success) {
                                        if (window.renderTags) window.renderTags(addData.tags, confirmed);
                                        if (window.showFlash) window.showFlash(`Tag "${confirmed}" added!`);
                                    } else {
                                        if (window.showFlash) window.showFlash(addData.msg || 'Error adding tag', 'error');
                                    }
                                } catch (_) {
                                    if (window.showFlash) window.showFlash('Network error', 'error');
                                }
                            });
                        });

                        pill.onclick = async (ev) => {
                            ev.stopPropagation();
                            if (pill.classList.contains('selected')) return;
                            pill.style.opacity = '0.5';
                            pill.style.pointerEvents = 'none';
                            try {
                                const addResp = await fetch(`/api/v2/tags/${itemid}`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'X-CSRF-Token': window.f0ckSession?.csrf_token
                                    },
                                    body: JSON.stringify({ tagname: field })
                                });
                                const addData = await addResp.json();
                                if (addData.success) {
                                    pill.classList.add('selected');
                                    pill.querySelector('i').className = 'fa-solid fa-check-circle';
                                    if (window.renderTags) window.renderTags(addData.tags, field);
                                    if (window.showFlash) window.showFlash(`Tag "${field}" added!`);
                                } else {
                                    if (window.showFlash) window.showFlash(addData.msg || 'Error adding tag', 'error');
                                }
                            } catch (_) {
                                if (window.showFlash) window.showFlash('Network error', 'error');
                            } finally {
                                pill.style.opacity = '';
                                pill.style.pointerEvents = '';
                            }
                        };
                        list.appendChild(pill);
                    });
                } else if (data.success) {
                    resultsCont.style.display = 'block';
                    noResults.style.display = 'block';
                } else {
                    error.textContent = data.msg || 'Extraction failed';
                    error.style.display = 'block';
                }
            } catch (err) {
                loading.style.display = 'none';
                error.textContent = 'Network error';
                error.style.display = 'block';
            }
        }
    });

  // Post & File Info Modal Logic
  document.addEventListener('click', (e) => {
    const infoBtn = e.target.closest('#a_info');
    if (infoBtn) {
      e.preventDefault();
      const modal = document.getElementById('info-modal');
      if (modal) {
        modal.style.display = 'flex';
        document.body.classList.add('modal-open');
      }
      return;
    }

    const closeBtn = e.target.closest('#info-modal-close');
    if (closeBtn) {
      e.preventDefault();
      const modal = document.getElementById('info-modal');
      if (modal) {
        modal.style.display = 'none';
        document.body.classList.remove('modal-open');
      }
      return;
    }

    // Title save button
    const saveBtn = e.target.closest('#info-title-save');
    if (saveBtn) {
      e.preventDefault();
      const input = document.getElementById('info-title-input');
      const status = document.getElementById('info-title-status');
      if (!input) return;

      const itemId = input.dataset.itemId;
      const newTitle = input.value.trim();
      const csrf = window.f0ckSession?.csrf_token;

      saveBtn.disabled = true;
      const origIcon = saveBtn.innerHTML;
      saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

      fetch(`/api/v2/items/${itemId}/title`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({ title: newTitle })
      })
        .then(r => r.json())
        .then(data => {
          saveBtn.disabled = false;
          saveBtn.innerHTML = origIcon;
          if (data.success) {
            // Update the live .item_title bar below the ID bar
            let titleBar = document.querySelector('.item_title');
            if (data.title) {
              if (titleBar) {
                titleBar.textContent = data.title;
                titleBar.style.display = '';
              } else {
                // Create it if it doesn't exist yet
                const idBar = document.querySelector('.item-main-content > ._204863');
                if (idBar) {
                  titleBar = document.createElement('div');
                  titleBar.className = 'item_title';
                  titleBar.textContent = data.title;
                  idBar.insertAdjacentElement('afterend', titleBar);
                }
              }
            } else {
              // Title cleared
              if (titleBar) titleBar.remove();
            }
            if (status) {
              status.textContent = '✓ Saved';
              status.style.color = 'var(--accent, #5cb85c)';
              status.style.display = 'inline';
              setTimeout(() => { status.style.display = 'none'; }, 2000);
            }
          } else {
            if (status) {
              status.textContent = data.msg || 'Error saving title';
              status.style.color = '#e84040';
              status.style.display = 'inline';
            }
          }
        })
        .catch(() => {
          saveBtn.disabled = false;
          saveBtn.innerHTML = origIcon;
          if (status) {
            status.textContent = 'Network error';
            status.style.color = '#e84040';
            status.style.display = 'inline';
          }
        });
      return;
    }

    // Close when clicking outside modal content
    const infoModal = document.getElementById('info-modal');
    if (infoModal && e.target === infoModal) {
      infoModal.style.display = 'none';
      document.body.classList.remove('modal-open');
    }
  });

  // Ensure any navigation event restores the scroll state
  window.addEventListener('pjax:start', () => {
    if (window.resetGlobalScrollState) window.resetGlobalScrollState();
    if (window.hideAllModals) window.hideAllModals();
  });

  // Global click interceptor for dynamically blurred thumbnails (NSFW, NSFL, SFW, Untagged)
  document.addEventListener('click', (e) => {
    // If no blur options are active, skip entirely
    const blurNsfw = localStorage.getItem('blurNsfw') === 'true';
    const blurNsfl = localStorage.getItem('blurNsfl') === 'true';
    const blurSfw = localStorage.getItem('blurSfw') === 'true';
    const blurUntagged = localStorage.getItem('blurUntagged') === 'true';
    if (!blurNsfw && !blurNsfl && !blurSfw && !blurUntagged) return;
    
    // Check if they clicked a blurred media-object container on the detail page
    const mediaObj = e.target.closest('.media-object');
    if (mediaObj && localStorage.getItem('blurDetail') !== 'false') {
      const mode = mediaObj.getAttribute('data-mode');
      let shouldBlurThis = false;
      if (mode === 'nsfw') shouldBlurThis = blurNsfw;
      else if (mode === 'nsfl') shouldBlurThis = blurNsfl;
      else if (mode === 'sfw') shouldBlurThis = blurSfw;
      else if (mode === 'untagged') shouldBlurThis = blurUntagged;
      
      if (shouldBlurThis && !mediaObj.classList.contains('revealed')) {
        e.preventDefault();
        e.stopPropagation();
        mediaObj.classList.add('revealed');
        
        // Start audio/video playback cleanly on reveal
        const videoElem = mediaObj.querySelector('video') || mediaObj.querySelector('audio');
        if (videoElem) {
          videoElem.play().catch(() => {});
        }
        return;
      }
    }

    // Check if they clicked the elegant hide-again button in the corner
    const hideBtn = e.target.closest('.hide-thumb-btn');
    if (hideBtn) {
      e.preventDefault();
      e.stopPropagation();
      const thumb = hideBtn.closest('a.thumb');
      if (thumb) {
        // Stop any active hover video preview immediately
        if (typeof window.clearHoverPreview === 'function') {
          window.clearHoverPreview();
        }
        
        thumb.classList.remove('revealed');
        hideBtn.remove();
        
        // Put the pre-blurred background image back if applicable
        const baseBg = thumb.dataset.bg;
        const mode = thumb.getAttribute('data-mode');
        let shouldBlurThis = false;
        if (mode === 'nsfw') shouldBlurThis = blurNsfw;
        else if (mode === 'nsfl') shouldBlurThis = blurNsfl;
        else if (mode === 'sfw') shouldBlurThis = blurSfw;
        else if (mode === 'null' || !mode) shouldBlurThis = blurUntagged;
        
        if (baseBg && shouldBlurThis) {
          const finalBg = window.applyThumbCacheBust(baseBg.replace('.webp', '_blur.webp'));
          thumb.style.backgroundImage = `url('${finalBg}')`;
        }
      }
      return;
    }
    
    const thumb = e.target.closest('a.thumb');
    if (!thumb) return;
    
    // Determine if this thumbnail rating is set to be blurred
    const mode = thumb.getAttribute('data-mode'); // 'nsfw', 'nsfl', 'sfw', or 'null' (untagged)
    let shouldBlurThis = false;
    if (mode === 'nsfw') shouldBlurThis = blurNsfw;
    else if (mode === 'nsfl') shouldBlurThis = blurNsfl;
    else if (mode === 'sfw') shouldBlurThis = blurSfw;
    else if (mode === 'null' || !mode) shouldBlurThis = blurUntagged;
    
    if (shouldBlurThis) {
      if (!thumb.classList.contains('revealed')) {
        e.preventDefault();
        e.stopPropagation();
        thumb.classList.add('revealed');
        
        // Dynamically load the standard unblurred background image
        const baseBg = thumb.dataset.bg;
        if (baseBg && shouldBlurThis) {
          const finalBg = window.applyThumbCacheBust(baseBg);
          thumb.style.backgroundImage = `url('${finalBg}')`;
        }
        
        // Dynamically inject the hide-again eye-slash button inside <p>
        const p = thumb.querySelector('p');
        if (p && !p.querySelector('.hide-thumb-btn')) {
          const btn = document.createElement('button');
          btn.className = 'hide-thumb-btn';
          btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
          btn.title = 'Hide thumbnail again';
          p.appendChild(btn);
        }

        // Automatically start the hover video preview immediately on reveal since mouse is already over the item
        if (typeof window.startHoverPreview === 'function') {
          window.startHoverPreview(thumb, 0);
        }
      }
    }
  }, true);
})();
