/**
 * MentionAutocomplete — Real-time user mention suggestions for textareas
 * Detects "@" and fetches matching users from the backend API.
 */
window.MentionAutocomplete = (() => {
    let activeDropdown = null;
    let selectedIndex = -1;
    let suggestions = [];
    let currentInput = null;
    let mentionStart = -1;
    let query = '';

    const DEBOUNCE_MS = 200;
    let debounceTimer = null;

    function destroy() {
        if (activeDropdown) {
            activeDropdown.remove();
            activeDropdown = null;
        }
        selectedIndex = -1;
        suggestions = [];
        mentionStart = -1;
        query = '';
    }

    function positionDropdown(input) {
        if (!activeDropdown) return;
        const rect = input.getBoundingClientRect();
        activeDropdown.style.left = `${rect.left}px`;
        activeDropdown.style.width = `${rect.width}px`;
        // layout-modern: input is near the top of the sidebar → open downward
        if (document.body.classList.contains('layout-modern')) {
            activeDropdown.style.top = `${rect.bottom}px`;
            activeDropdown.style.bottom = 'auto';
        } else {
            activeDropdown.style.bottom = `${window.innerHeight - rect.top + 5}px`;
            activeDropdown.style.top = 'auto';
        }
    }

    async function fetchUsers(q) {
        try {
            const res = await fetch(`/api/v2/users/suggest?q=${encodeURIComponent(q)}`);
            const data = await res.json();
            return data.suggestions || [];
        } catch (e) {
            return [];
        }
    }

    function renderDropdown() {
        if (!activeDropdown) {
            activeDropdown = document.createElement('div');
            activeDropdown.className = 'mention-suggestions';
            document.body.appendChild(activeDropdown);
        }

        activeDropdown.innerHTML = '';
        if (suggestions.length === 0) {
            destroy();
            return;
        }

        suggestions.forEach((user, i) => {
            const item = document.createElement('div');
            item.className = 'mention-suggestion-item';
            if (i === selectedIndex) item.classList.add('active');

            const avatarSrc = user.avatar_file ? `/a/${user.avatar_file}` : (user.avatar ? `/t/${user.avatar}.webp` : '/a/default.png');
            
            const img = document.createElement('img');
            img.src = avatarSrc;
            img.onerror = () => { img.src = '/a/default.png'; };
            
            const nameSpan = document.createElement('span');
            nameSpan.className = 'mention-name';
            nameSpan.textContent = user.user;
            
            item.appendChild(img);
            item.appendChild(nameSpan);

            if (user.display_name) {
                const displaySpan = document.createElement('span');
                displaySpan.className = 'mention-display';
                displaySpan.textContent = user.display_name;
                item.appendChild(displaySpan);
            }

            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                insertMention(user.user);
            });

            activeDropdown.appendChild(item);
        });

        // Ensure the active item is visible in the scrollable container
        const activeItem = activeDropdown.querySelector('.mention-suggestion-item.active');
        if (activeItem) {
            activeItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }

        positionDropdown(currentInput);
    }

    let skipNextInput = false;

    function insertMention(username) {
        if (!currentInput) return;
        const text = currentInput.value;
        const before = text.substring(0, mentionStart);
        const after = text.substring(currentInput.selectionStart);
        const insert = username.includes(' ') ? `[@${username}]` : `@${username}`;
        currentInput.value = before + insert + after;
        const newPos = before.length + insert.length;
        currentInput.setSelectionRange(newPos, newPos);
        currentInput.focus();
        destroy();
        
        // Trigger generic input/change events for other modules (like auto-resize or emoji autocomplete)
        skipNextInput = true;
        currentInput.dispatchEvent(new Event('input', { bubbles: true }));
        currentInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function handleKeyDown(e) {
        if (!activeDropdown) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = (selectedIndex + 1) % suggestions.length;
            renderDropdown();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
            renderDropdown();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (selectedIndex >= 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                insertMention(suggestions[selectedIndex].user);
            } else {
                destroy();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            destroy();
        }
    }

    function handleInput(e) {
        if (skipNextInput) {
            skipNextInput = false;
            return;
        }
        const input = e.target;
        const pos = input.selectionStart;
        const text = input.value.substring(0, pos);
        
        // Detect @ followed by alphanum, _, -, . (standard username chars)
        const match = text.match(/@([a-zA-Z0-9_\-\.]{0,})$/);

        if (match) {
            currentInput = input;
            mentionStart = pos - match[0].length;
            query = match[1];

            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                suggestions = await fetchUsers(query);
                if (suggestions.length > 0) {
                    selectedIndex = 0;
                    renderDropdown();
                } else {
                    destroy();
                }
            }, DEBOUNCE_MS);
        } else {
            destroy();
        }
    }

    return {
        /**
         * Attach mention autocomplete to a textarea
         * @param {HTMLTextAreaElement} textarea 
         */
        attach(textarea) {
            if (!textarea || textarea._mentionsAttached) return;
            textarea._mentionsAttached = true;
            textarea.addEventListener('input', handleInput);
            textarea.addEventListener('keydown', handleKeyDown);
            textarea.addEventListener('blur', () => {
                setTimeout(destroy, 200);
            });
        }
    };
})();
