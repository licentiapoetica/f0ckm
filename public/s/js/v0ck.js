(function() {
const tpl_player = (svg, size) => `<div class="v0ck_player_controls">
  <div class="v0ck_progress">
    <div class="v0ck_progress_buffered"></div>
    <div class="v0ck_progress_filled"></div>
    <div class="v0ck_seek_marker"></div>
  </div>
  <button class="v0ck_player_button v0ck_tplay v0ck_toggle" title="Play">
    <svg style="width: 20px; height: 20px;">
      <use id="v0ck_svg_play" href="${svg}#play"></use>
      <use id="v0ck_svg_pause" class="v0ck_hidden" href="${svg}#pause"></use>
    </svg>
  </button>
  <div class="v0ck_volume_group">
  <button class="v0ck_player_button v0ck_volume">
    <svg style="width: 20px; height: 20px;">
      <use id="v0ck_svg_volume_full" href="${svg}#volume_full"></use>
      <use id="v0ck_svg_volume_mid" class="v0ck_hidden" href="${svg}#volume_mid"></use>
      <use id="v0ck_svg_volume_mute" class="v0ck_hidden" href="${svg}#volume_mute"></use>
    </svg>
  </button>
  <input type="range" name="volume" min="0" max="1" step="0.01" value="1" />
  </div>
  <button class="v0ck_player_button v0ck_playtime">00:00 / 00:00</button>
  <span style="flex: 30"></span>
  
  <div class="v0ck_settings_container">
      <button class="v0ck_player_button v0ck_settings_btn" title="Settings">
        <svg viewBox="0 0 24 24" style="width: 20px; height: 20px;">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.06,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>
        </svg>
      </button>
      <div class="v0ck_settings_menu v0ck_hidden">
          <button id="toggleswf" class="v0ck_menu_item" title="Flash Yank">SWF</button>
          <div class="v0ck_menu_item v0ck_bg_row">
              <span class="v0ck_switch_label">Background</span>
              <div id="togglebg" class="v0ck_cool_switch" title="Toggle Background"></div>
          </div>
          <div class="v0ck_menu_item v0ck_bg_row">
              <span class="v0ck_switch_label">Autonext</span>
              <div id="toggleautoplay" class="v0ck_cool_switch" title="Toggle Autonext"></div>
          </div>
          <div class="v0ck_menu_item v0ck_bg_row">
              <span class="v0ck_switch_label">Danmaku</span>
              <div id="toggledanmaku" class="v0ck_cool_switch" title="Toggle Danmaku comments"></div>
          </div>
          <button id="v0ck_download" class="v0ck_menu_item" title="Download File">Download${size ? ` (${size})` : ''}</button>
      </div>
  </div>

  <button class="v0ck_player_button v0ck_toggle v0ck_fs_btn" title="Full Screen">
    <svg style="width: 20px; height: 20px;"><use id="v0ck_svg_fullscreen" href="${svg}#fullscreen"></use></svg>
  </button>
</div>
<div class="v0ck_loader v0ck_hidden"><div></div></div>
<div class="v0ck_overlay">
  <svg style="width: 60px; height: 60px;">
    <use href="${svg}#play"></use>
  </svg>
</div>
<div class="v0ck_hud v0ck_hidden">
  <svg><use class="v0ck_hud_icon" href="${svg}#volume_full"></use></svg>
  <div class="v0ck_hud_bar_container">
    <div class="v0ck_hud_bar"></div>
  </div>
</div>`;

const isMobile = /Mobi/i.test(navigator.userAgent) || ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

let mouseX = -1, mouseY = -1;
const updateHoverStates = () => {
  // Block interaction if content warning is visible or on mobile
  const cwModal = document.getElementById('content-warning-modal');
  if ((cwModal && cwModal.style.display !== 'none') || isMobile) return;

  document.querySelectorAll('.v0ck').forEach(p => {
    const rect = p.getBoundingClientRect();
    const isOver = mouseX >= rect.left && mouseX <= rect.right &&
      mouseY >= rect.top && mouseY <= rect.bottom;
    p.classList.toggle("v0ck_hover", isOver);
  });
};

document.addEventListener('mousemove', e => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  updateHoverStates();
}, { passive: true });

window.addEventListener('scroll', updateHoverStates, { passive: true });
window.addEventListener('wheel', updateHoverStates, { passive: true });

class v0ck {
  constructor(elem) {
    const tagName = elem.tagName.toLowerCase();
    if (["video", "audio"].includes(tagName)) {
      const parent = elem.parentElement;
      if (parent.querySelector('.v0ck_player_controls')) {
        console.log("[v0ck] Player controls already exist, skipping injection and init");
        return elem; // Return the video element as the constructor result
      } else {
        parent.classList.add("v0ck", "paused");
        elem.classList.add("v0ck_video", "viewer");

        // Check if mouse is already inside the element synchronously to avoid transition flicker
        const rect = parent.getBoundingClientRect();
        if (mouseX >= rect.left && mouseX <= rect.right &&
          mouseY >= rect.top && mouseY <= rect.bottom) {
          parent.classList.add("v0ck_hover", "v0ck_no_transition");
          // Remove no-transition after a frame
          setTimeout(() => parent.classList.remove("v0ck_no_transition"), 50);
        }

        if (!isMobile) {
            parent.addEventListener('mouseenter', () => parent.classList.add("v0ck_hover"));
            parent.addEventListener('mouseleave', () => parent.classList.remove("v0ck_hover"));
        }

        if (!document.querySelector('link[href^="/s/css/v0ck.css"]')) {
          document.head.insertAdjacentHTML("beforeend", `<link rel="stylesheet" href="/s/css/v0ck.css">`); // inject css
        }

        // Use absolute path for reliable asset loading
        const size = elem.getAttribute('data-size');
        elem.insertAdjacentHTML("afterend", tpl_player(`/s/img/v0ck.svg`, size));
        console.log("[v0ck] Player initialized for", tagName);
      }

      if (tagName === "audio" && elem.hasAttribute('poster')) { // set cover
        const player = document.querySelector('.v0ck');
        player.style.backgroundImage = `url('${elem.getAttribute('poster')}')`;
      }
    }
    else
      return console.error("nope");
    return this.init(elem);
  }

  init(elem) {
    const player = document.querySelector('.v0ck');
    const video = elem;
    video.removeAttribute('controls');
    video.removeAttribute('autoplay');
    video.addEventListener('contextmenu', e => {
      if (isMobile) e.preventDefault(); // Block native download/options menu on mobile only
    });
    const progress = player.querySelector('.v0ck_progress');
    const progressBar = player.querySelector('.v0ck_progress_filled');
    const bufferBar = player.querySelector('.v0ck_progress_buffered');
    const seekMarker = player.querySelector('.v0ck_seek_marker');
    const loader = player.querySelector('.v0ck_loader');
    const toggle = player.querySelector('.v0ck_toggle');
    const skipButtons = player.querySelectorAll('.v0ck [data-skip]');
    const ranges = player.querySelectorAll('.v0ck input[type="range"]');
    const volumeSlider = player.querySelector('.v0ck input[type="range"][name="volume"]');
    const fullscreen = player.querySelector('.v0ck_fs_btn');
    const playtime = player.querySelector('.v0ck_playtime');
    const overlay = player.querySelector('.v0ck_overlay');
    const volumeButton = player.querySelector('.v0ck_volume');
    const volumeSymbols = volumeButton.querySelectorAll('.v0ck use');

    const defaultVolume = 0.5;
    let mousedown = false;
    let _volume;

    function handleVolumeButton(vol) {
      [...volumeSymbols].forEach(s => !s.classList.contains('v0ck_hidden') ? s.classList.add('v0ck_hidden') : null);
      switch (true) {
        case (vol === 0): [...volumeSymbols].filter(s => s.id === "v0ck_svg_volume_mute")[0].classList.toggle('v0ck_hidden'); break;
        case (vol <= 0.5 && vol > 0): [...volumeSymbols].filter(s => s.id === "v0ck_svg_volume_mid")[0].classList.toggle('v0ck_hidden'); break;
        case (vol > 0.5): [...volumeSymbols].filter(s => s.id === "v0ck_svg_volume_full")[0].classList.toggle('v0ck_hidden'); break;
      }
      localStorage.setItem("volume", vol);
    }
    function togglePlay() {
      return video[video.paused ? 'play' : 'pause']();
    }
    function updatePlayIcon() {
      toggle.classList.toggle('playing');
      player.classList.toggle('paused');
      toggle.setAttribute('title', toggle.classList.contains('playing') ? 'Pause' : 'Play');
      [...toggle.querySelectorAll('use')].forEach(icon => icon.classList.toggle('v0ck_hidden'));
    }
    function toggleMute(e) {
      if (video.volume === 0)
        video.volume = volumeSlider.value = _volume === 0 ? defaultVolume : _volume;
      else {
        _volume = video.volume;
        video.volume = volumeSlider.value = 0;
      }
      handleVolumeButton(video.volume);
    }
    function skip() {
      video.currentTime += +this.dataset.skip;
    }
    function handleRangeUpdate() {
      video[this.name] = this.value;
      _volume = video.volume;
      handleVolumeButton(video.volume);
    }
    function formatTime(seconds) {
      const minutes = (~~(seconds / 60)).toString().padStart(2, "0");
      seconds = (~~(seconds % 60)).toString().padStart(2, "0");
      return minutes + ":" + seconds;
    }
    function handleProgress() {
      const percent = (video.currentTime / video.duration) * 100;
      progressBar.style.flexBasis = percent + '%';
      playtime.innerText = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
      
      if (video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        const duration = video.duration;
        if (duration > 0) {
          bufferBar.style.width = (bufferedEnd / duration) * 100 + '%';
        }
      }
    }
    function scrub(e) {
      let x;
      if (e.type.startsWith('touch')) {
         const rect = progress.getBoundingClientRect();
         x = e.touches[0].clientX - rect.left;
         if (e.type === 'touchmove' && e.cancelable) e.preventDefault(); 
      } else {
         x = e.offsetX;
      }
      
      const width = progress.offsetWidth;
      // Clamp x between 0 and width
      x = Math.max(0, Math.min(x, width));

      const scrubTime = (x / width) * video.duration;
      if (!Number.isFinite(scrubTime)) return;

      video.currentTime = scrubTime;
      
      // Visual seek marker
      seekMarker.style.left = `${(x / width) * 100}%`;
      seekMarker.classList.remove('active');
      void seekMarker.offsetWidth; // trigger reflow
      seekMarker.classList.add('active');
    }
    function enterFullScreen() {
      if (document.fullscreenElement) return;
      const target = document.getElementById('main') || player;
      if (/(iPad|iPhone|iPod)/gi.test(navigator.platform))
        video.webkitEnterFullscreen();
      else
        target.requestFullscreen();
    }
    function toggleFullScreen(e) {
      if (document.fullscreenElement) // exit fullscreen
        document.exitFullscreen();
      else { // request fullscreen
        enterFullScreen();
      }
    }
    function toggleFullScreenClasses() {
      const fsElem = document.fullscreenElement;
      const isThisPlayerFS = fsElem && (fsElem === player || fsElem.contains(player));
      player.classList.toggle('v0ck_fullscreen', !!isThisPlayerFS);
    }

    player.addEventListener('click', e => {
      const path = e.path || (e.composedPath && e.composedPath());
      const isControls = !!path.filter(f => f.classList?.contains('v0ck_player_controls')).length;
      if (!isControls) {
        if (isMobile && !player.classList.contains('v0ck_hover')) {
          player.classList.add('v0ck_hover');
          return;
        }
        togglePlay(e);
      }
    });
    toggle.addEventListener('click', togglePlay);
    overlay.addEventListener('click', e => {
      e.stopPropagation();
      player.classList.add('v0ck_hover');
      togglePlay();
    });
    video.addEventListener('play', updatePlayIcon);
    
    // Robust initial overlay removal
    const removeInitial = () => player.classList.remove('v0ck_initial');
    video.addEventListener('play', removeInitial);
    video.addEventListener('playing', removeInitial);
    video.addEventListener('timeupdate', () => {
        if (video.currentTime > 0.1 && !video.paused && !video.ended) removeInitial();
    });

    video.addEventListener('pause', updatePlayIcon);
    video.addEventListener('timeupdate', handleProgress);
    video.addEventListener('progress', handleProgress);
    video.addEventListener('ended', () => {
        if (localStorage.getItem('autoplay') === 'true') {
            const nextBtn = document.getElementById('next');
            if (nextBtn && nextBtn.href && !nextBtn.href.endsWith('#')) {
                nextBtn.click();
            }
        }
    });

    // Loader events
    const showLoader = () => loader.classList.remove('v0ck_hidden');
    const hideLoader = () => loader.classList.add('v0ck_hidden');
    video.addEventListener('waiting', showLoader);
    video.addEventListener('stalled', showLoader);
    video.addEventListener('canplay', hideLoader);
    video.addEventListener('playing', hideLoader);
    video.addEventListener('seeked', hideLoader);
    video.addEventListener('loadeddata', hideLoader);
    volumeButton.addEventListener('click', e => {
      e.stopPropagation();
      toggleMute(e);
    });

    const hud = player.querySelector('.v0ck_hud');
    const hudBar = hud.querySelector('.v0ck_hud_bar');
    const hudIcon = hud.querySelector('.v0ck_hud_icon');
    let startX, startY, startVol, isRightSide, gestureType;
    let hudTimer;

    function showHUD(vol) {
      hud.classList.remove('v0ck_hidden');
      hudBar.style.width = `${vol * 100}%`;
      
      // Update HUD icon based on volume
      let icon = 'volume_full';
      if (vol === 0) icon = 'volume_mute';
      else if (vol <= 0.5) icon = 'volume_mid';
      hudIcon.setAttribute('href', `${hudIcon.getAttribute('href').split('#')[0]}#${icon}`);

      clearTimeout(hudTimer);
      hudTimer = setTimeout(() => hud.classList.add('v0ck_hidden'), 1000);
    }

    player.addEventListener('touchstart', e => {
      if (!isMobile) return;
      const touch = e.touches[0];
      const rect = player.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      isRightSide = x > rect.width / 2;
      gestureType = 'none';
      
      if (isRightSide) {
        startX = touch.clientX;
        startY = touch.clientY;
        startVol = video.volume;
      }
    }, { passive: true });

    player.addEventListener('touchmove', e => {
      if (!isMobile || !isRightSide || gestureType === 'other') return;
      
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);

      // Identify gesture type if not yet locked
      if (gestureType === 'none') {
        if (dy > dx && dy > 5) {
          gestureType = 'volume';
        } else if (dx > dy && dx > 5) {
          gestureType = 'other'; // Probably seeking or horizontal swipe
          return;
        } else {
          return; // Too small movement to decide
        }
      }

      if (gestureType === 'volume') {
        const deltaY = startY - touch.clientY; // swipe up is positive
        const sensitivity = 200; // pixels for 0 to 1 range (reverted to original)
        let newVol = startVol + (deltaY / sensitivity);
        newVol = Math.max(0, Math.min(1, newVol));
        
        video.volume = newVol; // Set directly for smoothness
        volumeSlider.value = newVol; // Update visual slider
        _volume = newVol;
        handleVolumeButton(newVol);
        showHUD(newVol);
        
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });
    skipButtons.forEach(button => button.addEventListener('click', skip));
    ranges.forEach(range => range.addEventListener('change', handleRangeUpdate));
    ranges.forEach(range => range.addEventListener('mousemove', handleRangeUpdate));
    progress.addEventListener('mousedown', scrub);
    progress.addEventListener('touchstart', scrub, { passive: false });
    progress.addEventListener('touchmove', scrub, { passive: false });
    fullscreen.addEventListener('click', toggleFullScreen);
    document.addEventListener('fullscreenchange', toggleFullScreenClasses);
    toggleFullScreenClasses(); // Check initial state (important for transitions)

    video.volume = _volume = volumeSlider.value = +(localStorage.getItem('volume') ?? defaultVolume);
    handleVolumeButton(video.volume);

    // Attempt autoplay and show overlay if blocked
    const shouldAutoplay = window.f0ckSession?.disable_autoplay !== true;
    if (shouldAutoplay) {
      const playPromise = togglePlay();
      if (playPromise !== undefined) {
        playPromise.catch(() => {
          player.classList.add('v0ck_initial');
        });
      } else if (video.paused) {
        player.classList.add('v0ck_initial');
      }
    } else {
      player.classList.add('v0ck_initial');
    }

    // Settings Menu Logic
    const settingsBtn = player.querySelector('.v0ck_settings_btn');
    const settingsMenu = player.querySelector('.v0ck_settings_menu');
    const toggleBgSwitch = player.querySelector('#togglebg');
    const downloadBtn = player.querySelector('#v0ck_download');

    if (downloadBtn) {
        downloadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const a = document.createElement('a');
            a.href = video.src;
            a.download = video.src.split('/').pop();
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        });
    }

    // Initialize switch state (defaults to ON if not explicitly 'false')
    if (toggleBgSwitch && localStorage.getItem('background') !== 'false') {
        toggleBgSwitch.classList.add('active');
    }
    
    const toggleAutoplaySwitch = player.querySelector('#toggleautoplay');
    if (toggleAutoplaySwitch && localStorage.getItem('autoplay') === 'true') {
        toggleAutoplaySwitch.classList.add('active');
        video.loop = false;
    }
    
    if(settingsBtn && settingsMenu) {
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsMenu.classList.toggle('v0ck_hidden');
            if (settingsMenu.classList.contains('v0ck_hidden')) {
                document.dispatchEvent(new CustomEvent('v0ck_settings_closed'));
            }
        });

        // Close menu/panel when clicking outside
        document.addEventListener('click', (e) => {
             const isFlashYankUI = e.target.closest('#flash-yank-ui');
             const isInsidePlayer = player.contains(e.target);
             
             if(!settingsMenu.contains(e.target) && !settingsBtn.contains(e.target) && !isFlashYankUI) {
                 if (!settingsMenu.classList.contains('v0ck_hidden')) {
                     settingsMenu.classList.add('v0ck_hidden');
                     document.dispatchEvent(new CustomEvent('v0ck_settings_closed'));
                 }
             }

             if (isMobile && !isInsidePlayer && !isFlashYankUI) {
                 player.classList.remove('v0ck_hover');
             }
        });
        
        // Prevent menu click from pausing video (only if clicked on non-button area)
        settingsMenu.addEventListener('click', (e) => {
            if (!e.target.closest('button') && !e.target.closest('.v0ck_bg_row')) {
                 e.stopPropagation();
            }
        });

        // Visual toggle for background switch
        if (toggleBgSwitch) {
            const bgRow = toggleBgSwitch.closest('.v0ck_bg_row');
            const handleBgToggle = (e) => {
                e.stopPropagation();
                if (window.toggleBackground) {
                    window.toggleBackground();
                } else {
                    toggleBgSwitch.classList.toggle('active');
                }
            };
            if (bgRow) bgRow.addEventListener('click', handleBgToggle);
            else toggleBgSwitch.addEventListener('click', handleBgToggle);
        }

        if (toggleAutoplaySwitch) {
            const autoplayRow = toggleAutoplaySwitch.closest('.v0ck_bg_row');
            const handleAutoplayToggle = (e) => {
                e.stopPropagation();
                if (window.toggleAutoplay) {
                    window.toggleAutoplay();
                } else {
                    toggleAutoplaySwitch.classList.toggle('active');
                }
                video.loop = !toggleAutoplaySwitch.classList.contains('active');
            };
            if (autoplayRow) autoplayRow.addEventListener('click', handleAutoplayToggle);
            else toggleAutoplaySwitch.addEventListener('click', handleAutoplayToggle);
        }

        // Danmaku toggle
        const toggleDanmakuSwitch = player.querySelector('#toggledanmaku');
        if (toggleDanmakuSwitch) {
            // Sync initial state from localStorage vs site-wide config default
            const configDefault = (window.f0ckSession && window.f0ckSession.enable_danmaku !== undefined)
                ? !!window.f0ckSession.enable_danmaku
                : true;

            const savedPref = localStorage.getItem('danmaku');
            const isEnabled = (savedPref !== null) ? (savedPref !== 'false') : configDefault;

            if (isEnabled) {
                toggleDanmakuSwitch.classList.add('active');
            }
            const danmakuRow = toggleDanmakuSwitch.closest('.v0ck_bg_row');
            const handleDanmakuToggle = (e) => {
                e.stopPropagation();
                if (window.danmakuInstance) {
                    window.danmakuInstance.toggle();
                    const on = window.danmakuInstance.isEnabled();
                    toggleDanmakuSwitch.classList.toggle('active', on);
                    if (window.flashMessage) window.flashMessage(on ? 'Danmaku ON' : 'Danmaku OFF', 1800);
                } else {
                    toggleDanmakuSwitch.classList.toggle('active');
                    const newVal = toggleDanmakuSwitch.classList.contains('active');
                    localStorage.setItem('danmaku', newVal ? 'true' : 'false');
                    if (window.flashMessage) window.flashMessage(newVal ? 'Danmaku ON' : 'Danmaku OFF', 1800);
                }
            };
            if (danmakuRow) danmakuRow.addEventListener('click', handleDanmakuToggle);
            else toggleDanmakuSwitch.addEventListener('click', handleDanmakuToggle);
        }
    }
    this.toggleFullScreen = toggleFullScreen;
    this.enterFullScreen = enterFullScreen;

    return video;
  }
}

window.v0ck = v0ck;
})();
