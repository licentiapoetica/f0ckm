const Cookie = {
  get: name => {
    const c = document.cookie.match(`(?:(?:^|.*; *)${name} *= *([^;]*).*$)|^.*$`)[1];
    if (c) return decodeURIComponent(c);
  },
  set: (name, value, opts = {}) => {
    if (opts.days) {
      opts['max-age'] = opts.days * 60 * 60 * 24;
      delete opts.days;
    }
    opts.SameSite = 'Strict';
    opts = Object.entries(opts).reduce((accumulatedStr, [k, v]) => `${accumulatedStr}; ${k}=${v}`, '');
    document.cookie = name + '=' + encodeURIComponent(value) + opts;
  }
};

(() => {
  const themes = window.f0ckThemes || ['amoled', 'atmos', 'f0ck', 'f0ck95d', 'iced', 'orange', 'p1nk', '4d'];
  const defaultTheme = window.f0ckDefaultTheme || (window.f0ckSession && window.f0ckSession.default_theme) || themes[0] || 'amoled';

  const setTheme = (theme) => {
    if (!themes.includes(theme)) theme = defaultTheme;
    document.documentElement.setAttribute('theme', theme);
    Cookie.set('theme', theme, { path: '/', days: 360 });
  };

  const cycleTheme = () => {
    const currentTheme = document.documentElement.getAttribute('theme') || Cookie.get('theme') || defaultTheme;
    let i = themes.indexOf(currentTheme);
    if (i === -1 || ++i >= themes.length) i = 0;
    setTheme(themes[i]);
  };

  // Initial load — sync cookie → document attribute
  const acttheme = Cookie.get('theme') || defaultTheme;
  if (!themes.includes(acttheme) || acttheme !== document.documentElement.getAttribute('theme')) {
    setTheme(acttheme);
  }

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === 't') {
      e.preventDefault();
      cycleTheme();
      const newTheme = document.documentElement.getAttribute('theme') || defaultTheme;
      // Use scroller toast if available, otherwise site-wide flashMessage
      if (typeof window._scrollerThemeToast === 'function') {
        window._scrollerThemeToast(newTheme);
      } else if (typeof window.flashMessage === 'function') {
        window.flashMessage(`Theme: ${newTheme}`, 2000);
      }
    }
  });

  document.addEventListener('click', e => {
    if (e.target.id === 'shortcut-theme' || e.target.closest('#shortcut-theme')) {
      cycleTheme();
    }
  });

  // Expose globally so other scripts (e.g. scroller.js) can call cycle/set
  window.f0ckCycleTheme = cycleTheme;
  window.f0ckSetTheme   = setTheme;
})();
