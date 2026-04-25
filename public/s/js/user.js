(async () => {
  // Helper to get dynamic context from the DOM
  const getContext = () => {
    const idLink = document.querySelector("a.id-link");
    if (!idLink) return null;
    const tagsContainer = document.querySelector("#tags");
    const inner = tagsContainer.querySelector(".tags-inner") || tagsContainer;
    return {
      postid: +idLink.innerText,
      poster: document.querySelector("a#a_username")?.innerText,
      tags: [...inner.querySelectorAll(".badge")].map(t => t.innerText.slice(0, -2))
    };
  };

  const queryapi = async (url, data, method = 'GET') => {
    let req;
    if (method == 'POST') {
      req = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": window.f0ckSession?.csrf_token
        },
        body: JSON.stringify(data)
      });
    }
    else {
      let s = [];
      for (const [key, val] of Object.entries(data))
        s.push(encodeURIComponent(key) + "=" + encodeURIComponent(val));
      req = await fetch(url + '?' + s.join('&'));
    }
    return await req.json();
  };

  const get = async (url, data) => queryapi(url, data, 'GET');
  const post = async (url, data) => queryapi(url, data, 'POST');

  const renderTags = (_tags, highlightTag = null) => {
    const tagsContainer = document.querySelector("#tags");
    if (!tagsContainer) return;
    const inner = tagsContainer.querySelector(".tags-inner") || tagsContainer;

    // Only remove existing dynamically generated tags
    [...inner.querySelectorAll(".badge")].forEach(tag => {
      // Don't remove the one containing the add/toggle buttons, and don't remove the autocomplete input itself
      if (!tag.querySelector('#a_addtag') && !tag.querySelector('#a_toggle') && !tag.classList.contains('tag-ac-wrapper')) {
        tag.parentElement.removeChild(tag);
      }
    });

    _tags.reverse().forEach(tag => {
      const a = document.createElement("a");
      a.href = `/tag/${tag.normalized}`;
      a.style = "color: inherit !important";
      a.textContent = tag.tag;

      const span = document.createElement("span");
      span.classList.add("badge", "mr-2");
      if (highlightTag && (tag.tag === highlightTag || tag.normalized === highlightTag)) {
        span.classList.add('new-tag-glow');
      }
      span.setAttribute('tooltip', tag.display_name || tag.user);

      tag.badge.split(" ").forEach(b => span.classList.add(b));

      span.insertAdjacentElement("beforeend", a);

      if (window.f0ckSession && (window.f0ckSession.is_admin || window.f0ckSession.is_moderator)) {
        const space = document.createTextNode('\u00A0'); // &nbsp;
        span.appendChild(space);

        const del = document.createElement("a");
        del.className = "removetag admin-deltag";
        del.href = "javascript:void(0)";
        del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        span.insertAdjacentElement("beforeend", del);
      }

    inner.insertAdjacentElement("afterbegin", span);
    });

    // Handle show more/less toggle visibility and count
    const allBadges = [...inner.querySelectorAll(".badge")];
    const realTags = allBadges.filter(b => !b.querySelector('#a_addtag') && !b.querySelector('#a_toggle') && !b.classList.contains('tag-ac-wrapper'));
    
    let toggle = tagsContainer.querySelector(".show-tags-toggle");
    
    if (realTags.length > 10) {
      if (!toggle) {
        toggle = document.createElement("a");
        toggle.href = "#";
        toggle.className = "show-tags-toggle";
        tagsContainer.appendChild(toggle);
      }
      const hiddenCount = realTags.length - 10;
      toggle.dataset.count = hiddenCount;
      
      // Auto-expand when rendering new tags (e.g. after adding one) as requested
      tagsContainer.classList.add('tags-expanded');
      toggle.textContent = "show less";

    } else if (toggle) {
      toggle.remove();
      tagsContainer.classList.remove('tags-expanded');
    }
  };

  window.renderTags = renderTags;

  const addtagClick = (e) => {
    if (e) e.preventDefault();
    const ctx = getContext();
    if (!ctx) return;
    const { postid, tags } = ctx;
    const anchor = document.querySelector("a#a_addtag");
    if (!anchor) return;

    TagAutocomplete.open({
      postid,
      existingTags: tags,
      anchorEl: anchor,
      onSubmit: async (tag) => post("/api/v2/tags/" + postid, { tagname: tag }),
      renderTags
    });
  };

  const toggleEvent = async (e) => {
    if (e) e.preventDefault();
    const ctx = getContext();
    if (!ctx) return;
    const { postid } = ctx;

    const res = await (await fetch('/api/v2/tags/' + encodeURIComponent(postid) + '/toggle', {
      method: 'PUT',
      headers: { "X-CSRF-Token": window.f0ckSession?.csrf_token }
    })).json();

    renderTags(res.tags);
    const isNsfw = res.tags.some(t => t.id == 2);
    const isUntagged = res.tags.length === 0;
    const toggleBtn = document.querySelector('button#a_toggle');
    if (toggleBtn) {
      toggleBtn.classList.toggle('is-nsfw', isNsfw && !isUntagged);
      toggleBtn.classList.toggle('is-sfw', !isNsfw && !isUntagged);
      toggleBtn.classList.toggle('is-untagged', isUntagged);
      const labels = { true: 'NSFW', false: 'SFW' };
      toggleBtn.textContent = isUntagged ? '?' : (isNsfw ? 'NSFW' : 'SFW');
    }
  };

  const toggleFavEvent = async (e) => {
    // e is the click event or undefined
    const ctx = getContext();
    if (!ctx) return;
    const { postid } = ctx;

    // Read state BEFORE the API call so we know which direction to toggle
    const favoBtn = document.querySelector("#a_favo");
    const wasAlreadyFav = favoBtn && favoBtn.classList.contains('fa-solid');

    const res = await post('/api/v2/togglefav', {
      postid: postid
    });
    if (res.success) {
      // New state is the logical opposite of what it was before the API call
      const isNowFav = !wasAlreadyFav;

      if (favoBtn) {
        favoBtn.classList.toggle('fa-solid', isNowFav);
        favoBtn.classList.toggle('fa-regular', !isNowFav);
      }

      // span#favs
      const favcontainer = document.querySelector('#favs');
      favcontainer.innerHTML = "";
      if (res.favs.length > 0) {
        res.favs.forEach(f => {
          const a = document.createElement('a');
          a.href = `/user/${f.user}`;
          a.setAttribute('tooltip', f.display_name || f.user);
          a.setAttribute('flow', 'up');

          const img = document.createElement('img');
          img.src = f.avatar_file ? `/a/${f.avatar_file}` : (f.avatar ? `/t/${f.avatar}.webp` : '/a/default.png');
          img.style.height = "32px";
          img.style.width = "32px";
          if (f.username_color) img.style.borderColor = f.username_color;

          a.appendChild(img);
          favcontainer.appendChild(a);
          favcontainer.appendChild(document.createTextNode('\u00A0'));
        });
        favcontainer.hidden = false;
      } else {
        favcontainer.hidden = true;
      }

      window.flashMessage((window.f0ckI18n && (isNowFav ? window.f0ckI18n.fav_added : window.f0ckI18n.fav_removed)) || (isNowFav ? 'ADDED TO FAVORITES' : 'REMOVED FROM FAVORITES'));
      if (navigator.vibrate) navigator.vibrate(50);
    }
    else {
      // lul
    }
  };

  // Event Delegation
  document.addEventListener("click", e => {
    if (document.querySelector('script[src*="admin.js"]')) return;
    const target = e.target.nodeType === 3 ? e.target.parentElement : e.target;
    if (target.closest("a#a_addtag")) {
      addtagClick(e);
    } else if (target.closest("#a_favo")) {
      toggleFavEvent(e);
    }
  });


})();
