(async () => {
  // Helper to get dynamic context
  const getContext = () => {
    const idLink = document.querySelector("a.id-link");
    if (!idLink) return null;
    const tagsContainer = document.querySelector("#tags");
    const inner = tagsContainer.querySelector(".tags-inner") || tagsContainer;
    const usernameEl = document.querySelector("a#a_username");
    return {
      postid: +idLink.innerText,
      // data-username holds the raw DB username; data-author-id holds the user's numeric ID.
      // Never fall back to innerText — it may be a display name or the literal string 'unknown'.
      poster: (usernameEl?.dataset?.username || '').trim() || null,
      authorId: (usernameEl?.dataset?.authorId || '').trim() || null,
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

      const delbutton = document.createElement("a");
      delbutton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      delbutton.href = "javascript:void(0)";
      // Class for delegation
      delbutton.classList.add("admin-deltag", "removetag");

      span.appendChild(a);
      span.appendChild(document.createTextNode('\u00A0'));
      span.appendChild(delbutton);

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

  const deleteEvent = async e => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const ctx = getContext();
    if (!ctx) return;
    const { postid } = ctx;

    let target = e.target;
    if (target.nodeType === 3) target = target.parentElement;

    const badge = target.closest('.badge');
    if (!badge) return;
    const tagLink = badge.querySelector('a[href*="/tag/"], a:first-of-type');
    const tagname = tagLink ? tagLink.innerText.trim() : null;
    if (!tagname) return;

    if (typeof ModAction === 'undefined') return alert('Error: ModAction module not loaded');

    ModAction.confirm((window.f0ckI18n && window.f0ckI18n.tag_delete_title) || 'Delete Tag', `${(window.f0ckI18n && window.f0ckI18n.tag_delete_confirm) || 'Are you sure you want to delete the tag'} <strong style="color:#d9534f">${tagname}</strong>?`, async (reason) => {
      // Send reason via query param for DELETE request
      const res = await (await fetch("/api/v2/tags/" + postid + "/" + encodeURIComponent(tagname) + (reason ? "?reason=" + encodeURIComponent(reason) : ""), {
        method: 'DELETE',
        headers: { "X-CSRF-Token": window.f0ckSession?.csrf_token }
      })).json();

      if (!res.success) {
        throw new Error(res.msg || "Error deleting tag");
      }
      renderTags(res.tags);
      if (window.flashMessage) window.flashMessage((window.f0ckI18n?.tag_deleted_success) || 'Tag deleted', 2500, 'success');
    }, { allowEmpty: window.f0ckSession?.is_admin });
  };

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


  const toggleFavEvent = async (e) => {
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
  };

  const deleteButtonEvent = async e => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
    const ctx = getContext();
    if (!ctx) return;
    const { postid, poster, authorId } = ctx;

    if (typeof ModAction === 'undefined') return alert('Error: ModAction module not loaded');

    const i18n = window.f0ckI18n || {};
    const confirmTitle = i18n.item_delete_title || 'Delete Item';
    const posterStr = poster
      ? (authorId ? `${poster} (${authorId})` : poster)
      : 'unknown';
    const confirmMsg = (i18n.item_delete_confirm || 'Are you sure you want to delete item {id} by {user}?')
      .replace('{id}', postid)
      .replace('{user}', posterStr);

    ModAction.confirm(confirmTitle, confirmMsg, async (reason) => {
      // Flag immediately so the SSE delete_item handler skips navigation
      window._adminJustDeletedItem = postid;
      const res = await post("/api/v2/admin/deletepost", {
        postid: postid,
        reason: reason
      });
      if (!res.success) {
        window._adminJustDeletedItem = null;
        throw new Error(res.msg || "Error deleting item");
      }
      const mediaObj = document.querySelector('.media-object');
      if (mediaObj) {
        mediaObj.innerHTML = '<div style="padding: 100px; text-align: center; color: #d9534f;"><h1>Item Deleted</h1><p>The item has been successfully removed.</p></div>';
      }
      if (window.flashMessage) window.flashMessage((window.f0ckI18n?.item_deleted_success) || 'Item deleted', 2500, 'success');
      // Clear flag after a short delay (SSE has surely arrived by then)
      setTimeout(() => { window._adminJustDeletedItem = null; }, 3000);
    }, { allowEmpty: window.f0ckSession?.is_admin });
  };

  let tmptt = null;
  const editTagEvent = async e => {
    e.preventDefault();
    if (e.detail === 2) { // Double click
      clearTimeout(tmptt);
      const old = e.target;
      const parent = e.target.parentElement;
      const oldtag = e.target.innerText;

      const textfield = document.createElement('input');
      textfield.value = e.target.innerText;
      textfield.size = 10;

      parent.insertAdjacentElement('afterbegin', textfield);
      textfield.focus();
      parent.removeChild(e.target);
      // Hide delete button while editing
      const delBtn = parent.querySelector('a:last-child');
      if (delBtn) delBtn.style.display = 'none';

      textfield.addEventListener("keydown", async e => {
        if (e.key === 'Enter' || e.keyCode === 13) {
          parent.removeChild(textfield);
          let res = await fetch('/api/v2/tags/rename/' + encodeURIComponent(oldtag), {
            method: 'PUT',
            headers: { 
              "Content-Type": "application/json",
              "X-CSRF-Token": window.f0ckSession?.csrf_token
            },
            body: JSON.stringify({ newtag: textfield.value })
          });
          const status = res.status;
          res = await res.json();
          switch (status) {
            case 200:
            case 201:
              parent.insertAdjacentElement('afterbegin', old);
              if (delBtn) delBtn.style.display = '';
              old.href = `/tag/${res.tag}`;
              old.innerText = res.tag.trim();
              break;
            default:
              window.f0ckDebug(res);
              break;
          }
        }
        else if (e.key === 'Escape') {
          parent.removeChild(textfield);
          parent.insertAdjacentElement('afterbegin', old);
          if (delBtn) delBtn.style.display = '';
        }
      });
    }
    else
      tmptt = setTimeout(() => location.href = e.target.href, 250);
    return false;
  };

  // Event Delegation
  document.addEventListener("click", e => {
    const target = e.target.nodeType === 3 ? e.target.parentElement : e.target;

    if (target.closest("a#a_addtag")) {
      addtagClick(e);
    } else if (target.closest("#a_delete")) {
      deleteButtonEvent(e);
    } else if (target.matches('#tags .badge > a[href*="/tag/"]')) {
      editTagEvent(e);
    } else if (target.closest('.admin-deltag') || target.closest('.removetag')) {
      deleteEvent(e);
    } else if (target.closest("#a_pin")) {
      pinButtonEvent(e);
    } else if (target.closest("#a_favo")) {
      toggleFavEvent(e);
    }
  });

  const pinButtonEvent = async e => {
    if (e) e.preventDefault();
    const ctx = getContext();
    if (!ctx) return;
    const { postid } = ctx;

    const pinBtn = document.querySelector('#a_pin');
    if (!pinBtn) return;

    const isPinned = pinBtn.getAttribute('data-pinned') === 'true';
    const url = isPinned ? `/mod/unpin?id=${postid}` : `/mod/pin?id=${postid}`;

    try {
      const res = await (await fetch(url, {
        method: 'POST',
        headers: { "X-CSRF-Token": window.f0ckSession?.csrf_token }
      })).json();

      if (res.success) {
        const newState = res.pinned;
        const title = newState ? 'Unpin from main' : 'Pin to main';
        const currentBtn = document.querySelector('#a_pin');
        if (currentBtn) {
          currentBtn.setAttribute('data-pinned', newState);
          currentBtn.setAttribute('title', title);
          currentBtn.classList.toggle('active', newState);
        }
        window.flashMessage(newState ? (window.f0ckI18n?.item_pinned || 'ITEM PINNED') : (window.f0ckI18n?.item_unpinned || 'ITEM UNPINNED'));
      } else {
        alert('Error: ' + res.msg);
      }
    } catch (err) {
      console.error('Pin error:', err);
    }
  };

  document.addEventListener("keyup", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    const ctx = getContext();
    if (!ctx) return;

    // 'f' and 'i' handled by f0ckm.js keybindings via programmatic click
    if (e.key === "x") deleteButtonEvent();
    else if (e.key === "g") pinButtonEvent();
  });

  window.adminSetPassword = async (btn) => {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    const password = prompt(`Enter new password for ${name} (min 20 chars):`);
    if (!password) return;
    if (password.length < 20) return alert('Password must be at least 20 characters.');

    if (!confirm(`Are you sure you want to set a new password for ${name}? This will invalidate all their existing sessions and force them to change it on next login.`)) return;

    try {
      const data = await post('/api/v2/admin/users/set-password', { user_id: id, password });
      if (data.success) {
        alert(data.msg);
      } else {
        alert(data.msg || 'Failed to set password');
      }
    } catch (err) {
      alert('Network error');
    }
  };

  window.adminDeleteUser = async (btn) => {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    if (!confirm(`CRITICAL ACTION: Are you sure you want to PERMANENTLY DELETE user ${name}? All their uploads and comments will be reassigned to 'deleted_user'. This cannot be undone.`)) return;

    try {
      const data = await post('/api/v2/admin/users/delete', { user_id: id });
      if (data.success) {
        alert(data.msg);
        document.getElementById(`user-row-${id}`)?.remove();
      } else {
        alert(data.msg || 'Failed to delete user');
      }
    } catch (err) {
      alert('Network error');
    }
  };

  window.adminResetLoginAttempts = async (btn) => {
    const username = btn.dataset.username;
    if (!confirm(`Are you sure you want to reset login attempts for ${username}?`)) return;

    try {
      const data = await post('/api/v2/admin/users/reset-login-attempts', { username });
      if (data.success) {
        alert(data.msg);
        window.location.reload(); // Quickest way to refresh badges
      } else {
        alert(data.msg || 'Failed to reset attempts');
      }
    } catch (err) {
      alert('Network error');
    }
  };

  window.adminBulkDeleteHalls = async (btn) => {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    if (!confirm(`Are you sure you want to PERMANENTLY DELETE ALL HALLS for ${name}? This cannot be undone.`)) return;

    try {
      const data = await post('/api/v2/admin/users/bulk-delete-halls', { user_id: id });
      if (data.success) {
        alert(data.msg);
      } else {
        alert(data.msg || 'Failed to delete halls');
      }
    } catch (err) {
      alert('Network error');
    }
  };

  window.adminReassignUploads = async (btn) => {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    const username = btn.dataset.username;

    if (typeof ModAction === 'undefined') return alert('Error: ModAction module not loaded');

    ModAction.confirm(
      'Reassign Uploads',
      'Enter the <strong>target username</strong> to transfer all uploads from <strong style="color:var(--accent)">' + escHTML(name) + '</strong> to:',
      async (targetUsername) => {
        const payload = { target_username: targetUsername };
        if (id) {
          payload.source_user_id = id;
        } else {
          payload.source_username = username;
        }
        const res = await post('/api/v2/admin/users/reassign-uploads', payload);
        if (res.success) {
          showFlash(res.msg, 'success');
        } else {
          throw new Error(res.msg || 'Reassignment failed');
        }
      },
      { hideReason: false, confirmText: 'Reassign', placeholder: 'target username' }
    );
  };

})();

