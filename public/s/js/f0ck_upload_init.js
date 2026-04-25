/**
 * Global Drag and Drop Initialization - ROBUST VERSION
 */
(() => {
    const dropOverlay = document.getElementById('drop-overlay');
    const dragModal = document.getElementById('upload-drag-modal');
    const dragModalClose = document.getElementById('drag-modal-close');
    const dragForm = dragModal ? dragModal.querySelector('.upload-form') : null;

    const showModal = () => {
        if (!dragModal) return;
        dragModal.classList.add('show');
        // Reset scroll position so it always starts at the top
        dragModal.scrollTop = 0;
        const modalContent = dragModal.querySelector('.modal-content');
        if (modalContent) modalContent.scrollTop = 0;
        const modalBody = dragModal.querySelector('.modal-body');
        if (modalBody) modalBody.scrollTop = 0;
    };

    // Navbar upload link — always attached so it works even if drag-drop can't init.
    // Opens the modal when available; falls back to /upload navigation otherwise.
    const navUploadLink = document.getElementById('nav-upload-link');
    if (navUploadLink) {
        navUploadLink.addEventListener('click', (e) => {
            if (!dragModal) return; // no modal → fall back to href navigation
            e.preventDefault();
            showModal();
        });
    }

    if (!dropOverlay || !dragModal || !dragForm) {
        console.warn('[f0ck] Quick Upload Modal or Form missing, global drag-drop disabled.');
        return;
    }

    let dragCounter = 0;
    let uploader = null;

    // Use the consolidated initUploadForm from upload.js
    if (window.initUploadForm) {
        uploader = window.initUploadForm(dragForm);
    } else {
        console.error('[f0ck] window.initUploadForm is missing! upload.js not loaded?');
        return;
    }

    // Global Drag Events
    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (window.location.pathname === '/upload') return;
        if (e.dataTransfer.types.includes('Files')) {
            dragCounter++;
            dropOverlay.classList.add('active');
        }
    });

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (window.location.pathname === '/upload') return;
    });

    window.addEventListener('dragleave', (e) => {
        if (window.location.pathname === '/upload') return;
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropOverlay.classList.remove('active');
        }
    });

    window.addEventListener('drop', (e) => {
        if (window.location.pathname === '/upload') return;
        e.preventDefault();
        dragCounter = 0;
        dropOverlay.classList.remove('active');

        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            if (uploader && uploader.handleFile) {
                const ok = uploader.handleFile(files[0]);
                if (ok !== false) {
                    showModal();
                }
            }
        }
    });

    // Modal Close
    dragModalClose.onclick = () => {
        dragModal.classList.remove('show');
        if (uploader && uploader.reset) {
            uploader.reset();
        }
    };

    // Close on ESC
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dragModal.classList.contains('show')) {
            dragModalClose.onclick();
        }
    });

    // Open on 'u' shortcut (not on /upload, not when typing)
    window.addEventListener('keydown', (e) => {
        if (e.key === 'u' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
            if (window.location.pathname === '/upload') return;
            if (dragModal.classList.contains('show')) return;
            
            e.preventDefault();
            showModal();
        }
    });

    // Global Paste Event for Clipboard Images/Videos/URLs
    window.addEventListener('paste', (e) => {
        const activeTag = document.activeElement?.tagName;
        const isTyping = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT' || document.activeElement?.isContentEditable;
        
        const isModalOpen = dragModal.classList.contains('show');
        const isUploadPage = window.location.pathname === '/upload';
        
        // Items loop for files
        const items = e.clipboardData?.items;
        let file = null;
        if (items) {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/'))) {
                    file = item.getAsFile();
                    break;
                }
            }
        }

        if (file) {
            // Find target uploader
            let targetUploader = null;
            if (isModalOpen) {
                targetUploader = uploader;
            } else if (isUploadPage) {
                const pageForm = document.querySelector('.pagewrapper .upload-form') || document.querySelector('#main .upload-form');
                targetUploader = (pageForm && pageForm._f0ckUploader) ? pageForm._f0ckUploader : uploader;
            } else {
                targetUploader = uploader;
            }

            if (targetUploader && targetUploader.handleFile) {
                if (isUploadPage || isModalOpen) {
                    targetUploader.handleFile(file);
                    e.preventDefault();
                } else if (!isTyping) {
                    e.preventDefault();
                    showModal();
                    targetUploader.handleFile(file);
                }
            }
            return;
        }

        // Handle URL paste (only if NOT typing)
        const text = e.clipboardData.getData('text')?.trim();
        if (text && (text.startsWith('http://') || text.startsWith('https://') || text.includes('youtube.com/') || text.includes('youtu.be/'))) {
            if (!isTyping) {
                e.preventDefault();

                // Context-aware target selection
                let targetContainer = dragModal;
                if (!isModalOpen && isUploadPage) {
                    targetContainer = document.querySelector('.pagewrapper .upload-form') || 
                                      document.querySelector('#main .upload-form') || 
                                      dragModal;
                }
                
                if (targetContainer === dragModal && !isModalOpen && !isUploadPage) {
                    showModal();
                }

                // Switch to URL tab
                const urlTab = targetContainer.querySelector('.upload-mode-tab[data-mode="url"]');
                if (urlTab) urlTab.click();

                // Fill input
                const urlInput = targetContainer.querySelector('#url-upload-input');
                if (urlInput) {
                    urlInput.value = text;
                    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }
    });
})();
