/**
 * TagAutocomplete — Custom mobile-friendly tag autocomplete dropdown
 * Replaces native <datalist> which is unreliable on mobile Chrome.
 *
 * Usage:
 *   TagAutocomplete.open({
 *     postid: Number,
 *     existingTags: String[],
 *     anchorEl: Element,        // the "add tag" link
 *     onSubmit: async (tag) => { ... return { success, tags } },
 *     renderTags: (tags) => void
 *   });
 */
window.TagAutocomplete = (() => {
  let activeInstance = null;

  const DEBOUNCE_MS = 300;
  const MIN_QUERY_LEN = 1;

  function destroy() {
    if (!activeInstance) return;
    const { wrapper } = activeInstance;
    if (wrapper && wrapper.parentElement) {
      wrapper.parentElement.removeChild(wrapper);
    }
    activeInstance = null;
  }

  function open(opts) {
    const { postid, existingTags, anchorEl, onSubmit, renderTags } = opts;

    // If already open, just focus the existing input
    if (activeInstance && activeInstance.wrapper.parentElement) {
      activeInstance.input.focus();
      return;
    }

    // -- Build DOM --
    const wrapper = document.createElement('span');
    wrapper.className = 'badge badge-light ml-2 tag-ac-wrapper';

    const form = document.createElement('form');
    form.style.display = 'inline';
    form.setAttribute('autocomplete', 'off');

    const input = document.createElement('input');
    input.type = 'text';
    input.size = '10';
    input.value = '';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.className = 'tag-ac-input';
    input.placeholder = '';

    const dropdown = document.createElement('div');
    dropdown.className = 'tag-suggestions';
    dropdown.style.display = 'none';

    form.appendChild(input);
    wrapper.appendChild(form);
    wrapper.appendChild(dropdown);
    
    // Insert after the anchor itself to put it right next to it.
    anchorEl.insertAdjacentElement('afterend', wrapper);

    input.focus();

    activeInstance = { wrapper, input, dropdown };

    // Flag to prevent focusout from destroying dropdown while touching it
    let dropdownTouching = false;
    dropdown.addEventListener('touchstart', () => { dropdownTouching = true; }, { passive: true });
    dropdown.addEventListener('touchend', () => {
      dropdownTouching = false;
      // Re-focus input so user can keep typing after scrolling
      input.focus();
    }, { passive: true });
    dropdown.addEventListener('touchcancel', () => { dropdownTouching = false; }, { passive: true });

    // -- Debounced suggest --
    let debounceTimer = null;
    let lastQuery = '';
    let highlightIndex = -1;

    const updateHighlight = (items, newIndex) => {
      // Remove old highlight
      if (highlightIndex >= 0 && highlightIndex < items.length) {
        items[highlightIndex].classList.remove('active');
      }
      highlightIndex = newIndex;
      // Apply new highlight
      if (highlightIndex >= 0 && highlightIndex < items.length) {
        items[highlightIndex].classList.add('active');
        items[highlightIndex].scrollIntoView({ block: 'nearest' });
        // Update input to show highlighted tag
        input.value = items[highlightIndex].querySelector('.tag-suggestion-name').textContent;
      }
    };

    const fetchSuggestions = async (q) => {
      try {
        const res = await fetch('/api/v2/tags/suggest?q=' + encodeURIComponent(q));
        const data = await res.json();
        return data.suggestions || [];
      } catch {
        return [];
      }
    };

    const renderDropdown = (suggestions) => {
      dropdown.innerHTML = '';
      highlightIndex = -1; // reset on new suggestions
      if (!suggestions.length) {
        dropdown.style.display = 'none';
        return;
      }
      suggestions.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'tag-suggestion-item';

        const name = document.createElement('span');
        name.className = 'tag-suggestion-name';
        name.textContent = entry.tag;

        const meta = document.createElement('span');
        meta.className = 'tag-suggestion-meta';
        const scoreStr = typeof entry.score === 'number' ? entry.score.toFixed(2) : '0.00';
        meta.textContent = `${entry.tagged || 0}× · ${scoreStr}`;

        row.appendChild(name);
        row.appendChild(meta);

        // Desktop: mousedown fires before focusout, preventing premature close
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          input.value = entry.tag;
          dropdown.style.display = 'none';
          form.requestSubmit();
        });

        // Mobile: distinguish tap from scroll using touch distance
        let touchStartY = 0;
        let touchStartX = 0;
        row.addEventListener('touchstart', (e) => {
          touchStartY = e.touches[0].clientY;
          touchStartX = e.touches[0].clientX;
        }, { passive: true });
        row.addEventListener('touchend', (e) => {
          const dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
          const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
          if (dx < 10 && dy < 10) {
            // Clean tap — select this suggestion
            e.preventDefault();
            e.stopPropagation();
            input.value = entry.tag;
            dropdown.style.display = 'none';
            form.requestSubmit();
          }
        });

        dropdown.appendChild(row);
      });
      dropdown.style.display = '';
    };

    // -- Events --
    const onInput = () => {
      const q = input.value.trim();
      if (q.length < MIN_QUERY_LEN) {
        dropdown.style.display = 'none';
        dropdown.innerHTML = '';
        lastQuery = '';
        return;
      }
      if (q === lastQuery) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        lastQuery = q;
        const suggestions = await fetchSuggestions(q);
        // Only render if input hasn't changed while we awaited
        if (input.value.trim() === q) {
          renderDropdown(suggestions);
        }
      }, DEBOUNCE_MS);
    };

    input.addEventListener('input', onInput);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        destroy();
        return;
      }

      const items = dropdown.querySelectorAll('.tag-suggestion-item');
      if (!items.length || dropdown.style.display === 'none') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = highlightIndex < items.length - 1 ? highlightIndex + 1 : 0;
        updateHighlight(items, next);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = highlightIndex > 0 ? highlightIndex - 1 : items.length - 1;
        updateHighlight(items, prev);
      } else if (e.key === 'Enter' && highlightIndex >= 0) {
        // Enter with a highlighted item — submit that tag
        e.preventDefault();
        dropdown.style.display = 'none';
        form.requestSubmit();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const tag = input.value.trim();
      if (!tag) return;

      if (/^https?:\/\//i.test(tag)) {
        window.flashMessage('Post that in the comments', 3000, 'error');
        input.value = '';
        return;
      }

      if (existingTags.includes(tag)) {
        window.flashMessage('Tag already exists', 3000, 'error');
        return;
      }

      const res = await onSubmit(tag);
      if (!res.success) {
        window.flashMessage(res.msg || 'Error adding tag', 3000, 'error');
        return;
      }
      renderTags(res.tags, tag);
      destroy();
      // Re-open for adding more tags
      open(opts);
    });

    // Close when clicking/tapping outside
    const onDocClick = (e) => {
      if (!wrapper.contains(e.target) && e.target !== anchorEl) {
        document.removeEventListener('mousedown', onDocClick);
        document.removeEventListener('touchstart', onDocClick);
        destroy();
      }
    };
    // Delay attaching to avoid capturing the opening click
    setTimeout(() => {
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('touchstart', onDocClick, { passive: true });
    }, 0);

    // Click on the wrapper area should refocus the input
    wrapper.addEventListener('mousedown', (e) => {
      if (e.target !== input) {
        e.preventDefault(); // prevent blur
        input.focus();
      }
    });

    input.addEventListener('focusout', () => {
      // Delay to allow suggestion tap/scroll to complete first
      setTimeout(() => {
        if (dropdownTouching) return; // user is interacting with dropdown
        // Don't close if focus is still within the wrapper
        if (activeInstance && wrapper.contains(document.activeElement)) return;
        if (activeInstance && input.value.length === 0 && document.activeElement !== input) {
          destroy();
        }
      }, 300);
    });
  }

  return { open, destroy };
})();
