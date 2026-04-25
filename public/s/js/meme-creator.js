/**
 * Meme Creator Logic
 * DYNAMIC MULTIPLE LAYERS
 */

(() => {
    const canvas = document.getElementById('memeCanvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        const layersContainer = document.getElementById('textLayersContainer');
        const addTextBtn = document.getElementById('addText');

        const uploadBtn = document.getElementById('uploadMeme');
        
        // Core state
        let textLayers = [];
        let dragOffset = { x: 0, y: 0 };
        let draggingLayer = null; 
        let hoveredLayer = null;
        let img = new Image();

        const memeFont = 'Impact, Charcoal, sans-serif';

        // Image Setup
        img.crossOrigin = "anonymous";
        img.onload = () => {
            canvas.width = img.width || 800;
            canvas.height = img.height || 600;
            
            const defaultSize = 40;
            
            // Initial layers
            textLayers = [
                { id: Date.now(), text: '', x: canvas.width / 2, y: 40, fontSize: defaultSize },
                { id: Date.now() + 1, text: '', x: canvas.width / 2, y: canvas.height - 100, fontSize: defaultSize }
            ];
            
            renderInputs();
            draw();
        };
        img.src = window.memeTemplate.url;

        // Ensure font is loaded before first draw
        if (document.fonts) {
            document.fonts.ready.then(() => {
                draw();
            });
        }

        function renderInputs() {
            layersContainer.innerHTML = '';
            textLayers.forEach((layer, index) => {
                const div = document.createElement('div');
                div.className = 'form-group layer-input-group';
                div.style.marginBottom = '20px';
                div.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <label style="margin-bottom: 0; font-weight: bold;">${(window.f0ckI18n?.meme?.text_layer) || 'Text Layer'} ${index + 1}</label>
                        <button class="remove-layer" data-id="${layer.id}" style="background: transparent; border: none; color: #ff4444; cursor: pointer; padding: 0 5px;">
                            <i class="fa fa-times"></i>
                        </button>
                    </div>
                    <textarea data-id="${layer.id}" placeholder="${(window.f0ckI18n?.meme?.enter_text) || 'Enter text...'}" rows="2" style="width: 100%; margin-bottom: 8px;">${layer.text}</textarea>
                    
                    <div class="layer-font-size-control" style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 0.8em; color: #888; white-space: nowrap;">${(window.f0ckI18n?.meme?.size_label) || 'Size'}: <span class="layer-fs-val">${layer.fontSize}</span>px</span>
                        <input type="range" class="layer-fs-input" min="10" max="200" value="${layer.fontSize}" style="flex: 1;">
                    </div>
                `;
                
                const textarea = div.querySelector('textarea');
                textarea.addEventListener('input', (e) => {
                    layer.text = e.target.value;
                    draw();
                });

                const fsInput = div.querySelector('.layer-fs-input');
                const fsVal = div.querySelector('.layer-fs-val');
                fsInput.addEventListener('input', (e) => {
                    layer.fontSize = parseInt(e.target.value);
                    fsVal.textContent = layer.fontSize;
                    draw();
                });

                const removeBtn = div.querySelector('.remove-layer');
                removeBtn.addEventListener('click', () => {
                    textLayers = textLayers.filter(l => l.id !== layer.id);
                    renderInputs();
                    draw();
                });

                layersContainer.appendChild(div);
            });
        }

        addTextBtn.addEventListener('click', () => {
            textLayers.push({
                id: Date.now(),
                text: 'NEW TEXT',
                x: canvas.width / 2,
                y: canvas.height / 2,
                fontSize: 40
            });
            renderInputs();
            draw();
        });

        function draw() {
            if (!img.complete) return;
            
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);

            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'white';
            ctx.strokeStyle = 'black';
            ctx.miterLimit = 2; // Prevent sharp spikes in characters like 'A'
            
            const globalFontSize = 40;

            // Render each layer
            textLayers.forEach((layer) => {
                if (!layer.text) return;
                
                const fontSize = layer.fontSize || 40;
                ctx.font = `bold ${fontSize}px ${memeFont}`;

                let displayStr = layer.text.toUpperCase();
                const lines = displayStr.split('\n');
                const h = lines.length * fontSize * 1.1;
                const w = canvas.width * 0.9;

                // Box for the dragged/hovered layer (top-most layer gets preference)
                if (hoveredLayer === layer || draggingLayer === layer) {
                    ctx.save();
                    ctx.setLineDash([5, 5]);
                    ctx.strokeStyle = '#9f0';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(layer.x - w / 2, layer.y - 10, w, h + 20);
                    ctx.restore();
                }

                lines.forEach((line, i) => {
                    const yOffset = i * (fontSize * 1.1);
                    const renderX = Math.round(layer.x);
                    const renderY = Math.round(layer.y + yOffset);
                    
                    ctx.save();
                    ctx.font = `bold ${fontSize}px ${memeFont}`; // Ensure correct font size per line
                    ctx.strokeStyle = 'black';
                    ctx.lineWidth = Math.max(2, fontSize / 8); // Slightly thicker stroke for better legibility
                    ctx.strokeText(line, renderX, renderY);
                    ctx.fillText(line, renderX, renderY);
                    ctx.restore();
                });
            });
        }

        // Options hooks removed as they are now hardcoded and the inputs are gone

        const getEventPos = (e) => {
            const rect = canvas.getBoundingClientRect();
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            
            return {
                x: (clientX - rect.left) * (canvas.width / rect.width),
                y: (clientY - rect.top) * (canvas.height / rect.height)
            };
        };

        const isInsideText = (pt, layer) => {
            if (!layer.text) return false;
            const fontSize = layer.fontSize || 40;
            const lines = layer.text.split('\n');
            const w = canvas.width * 0.95;
            const h = lines.length * fontSize * 1.2;
            
            return pt.x >= layer.x - w / 2 && pt.x <= layer.x + w / 2 && 
                   pt.y >= layer.y - 20 && pt.y <= layer.y + h + 20;
        };

        // POINTER EVENTS
        const onStart = (e) => {
            const pt = getEventPos(e);
            
            // Find layer (start from top-most, reverse of render order)
            draggingLayer = [...textLayers].reverse().find(layer => isInsideText(pt, layer)) || null;

            if (draggingLayer) {
                dragOffset = { x: pt.x - draggingLayer.x, y: pt.y - draggingLayer.y };
                if (e.pointerId) canvas.setPointerCapture(e.pointerId);
                canvas.style.cursor = 'grabbing';
                draw();
                e.preventDefault();
            }
        };

        const onMove = (e) => {
            const pt = getEventPos(e);
            
            if (draggingLayer) {
                draggingLayer.x = pt.x - dragOffset.x;
                draggingLayer.y = pt.y - dragOffset.y;
                draw();
                e.preventDefault();
            } else {
                // Hover logic
                const currentHover = [...textLayers].reverse().find(layer => isInsideText(pt, layer)) || null;
                if (currentHover !== hoveredLayer) {
                    hoveredLayer = currentHover;
                    canvas.style.cursor = hoveredLayer ? 'grab' : 'crosshair';
                    draw();
                }
            }
        };

        const onEnd = (e) => {
            if (draggingLayer) {
                if (e.pointerId) canvas.releasePointerCapture(e.pointerId);
                draggingLayer = null;
                canvas.style.cursor = 'grab';
                draw();
            }
        };

        canvas.addEventListener('pointerdown', onStart);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        canvas.addEventListener('pointercancel', onEnd);
        canvas.addEventListener('mousedown', onStart);
        // Upload
        uploadBtn.addEventListener('click', async () => {
            const category = (window.memeTemplate && window.memeTemplate.category) ? window.memeTemplate.category.toLowerCase() : '';
            const subCategory = (window.memeTemplate && window.memeTemplate.sub_category) ? window.memeTemplate.sub_category.toLowerCase() : '';
            
            const isOrakelVon10 = subCategory === 'von10';
            const isOrakelUser = subCategory === 'user';
            const isOrakelNormal = category === 'orakel' && !isOrakelUser && !isOrakelVon10;

            let uploadCanvas = canvas;

            if (isOrakelNormal || isOrakelUser || isOrakelVon10) {
                // Create an off-screen canvas to apply the orakel answer silently
                uploadCanvas = document.createElement('canvas');
                uploadCanvas.width = canvas.width;
                uploadCanvas.height = canvas.height;
                const uCtx = uploadCanvas.getContext('2d');
                
                // Copy current canvas state
                uCtx.drawImage(canvas, 0, 0);
                
                let result = '';
                if (isOrakelNormal) {
                    const outcomes = ['JA', 'NEIN', 'VIELLEICHT', 'AUF JEDEN FALL', 'NIEMALS', 'SOWAS VON JA', 'VERGISS ES', 'FRAG SPÄTER', 'KOMMT DRAUF AN'];
                    result = outcomes[Math.floor(Math.random() * outcomes.length)];
                } else if (isOrakelUser) {
                    try {
                        const res = await fetch('/api/v2/orakel/user');
                        const data = await res.json();
                        result = (data.success && data.username) ? `${data.display_name || data.username}|||ID: ${data.id}` : 'Anonymous';
                    } catch (e) {
                        result = 'Anonymous';
                    }
                } else if (isOrakelVon10) {
                    result = Math.floor(Math.random() * 11).toString();
                }
                
                // Draw Orakel result on the hidden canvas
                uCtx.save();
                uCtx.font = (isOrakelVon10) ? 'bold 150px Impact' : 'bold 80px Impact'; // Bigger font for the rating
                uCtx.textAlign = 'center';
                uCtx.textBaseline = 'middle';
                
                if (isOrakelNormal) {
                    uCtx.shadowBlur = 20;
                    uCtx.shadowColor = 'rgba(101, 37, 212, 1)';
                } else if (isOrakelVon10) {
                    uCtx.shadowBlur = 0; // No shadow as requested
                } else {
                    // No shadow for the User Orakel
                    uCtx.shadowBlur = 0;
                }
                
                uCtx.fillStyle = '#fff';
                uCtx.strokeStyle = '#000';
                uCtx.lineWidth = 10;
                uCtx.miterLimit = 2;
                
                // Adjust position for user Orakel (reverting to +10 offset)
                let yPos = Math.round(isOrakelUser ? (uploadCanvas.height / 2 + 10) : (uploadCanvas.height / 2 + 50));
                
                if (isOrakelVon10) {
                    yPos = Math.round(uploadCanvas.height / 2 ); // 1px lower
                }

                const xPos = Math.round(uploadCanvas.width / 2);
                
                // Auto-fit font size for user orakel — shrink until text fits within image width
                let orakelFontSize = isOrakelVon10 ? 150 : 80;
                const maxTextWidth = uploadCanvas.width - 80; // 40px padding each side

                if (isOrakelUser) {
                    const parts = result.split('|||');
                    const namePart = parts[0];
                    const idPart = parts.length > 1 ? `(${parts[1]})` : '';
                    const combinedText = idPart ? `${namePart} ${idPart}` : namePart;

                    // Even tighter threshold for User Orakel (approx 25% total padding)
                    const userMaxWidth = Math.round(uploadCanvas.width * 0.75);

                    let currentFontSize = 74;
                    uCtx.font = `bold ${currentFontSize}px Impact`;
                    
                    // First attempt: Shrink entire text on one line down to 58px if needed
                    while (uCtx.measureText(combinedText).width > userMaxWidth && currentFontSize > 58) {
                        currentFontSize -= 2;
                        uCtx.font = `bold ${currentFontSize}px Impact`;
                    }

                    const combinedFits = uCtx.measureText(combinedText).width <= userMaxWidth;

                    if (combinedFits) {
                        // Single line — potentially shrunk for long names
                        uCtx.fillText(combinedText, xPos, yPos);
                    } else {
                        // Two lines — auto-fit just the name, ID below
                        let nameFontSize = 74;
                        uCtx.font = `bold ${nameFontSize}px Impact`;
                        while (uCtx.measureText(namePart).width > userMaxWidth && nameFontSize > 16) {
                            nameFontSize -= 2;
                            uCtx.font = `bold ${nameFontSize}px Impact`;
                        }

                        const idFontSize = Math.max(18, Math.round(nameFontSize * 0.45));
                        const lineGap = Math.round(nameFontSize * 0.65);
                        const nameY = Math.round(yPos - lineGap / 2);
                        const idY = Math.round(yPos + lineGap / 2) + 2;

                        uCtx.font = `bold ${nameFontSize}px Impact`;
                        uCtx.fillText(namePart, xPos, nameY);

                        if (idPart) {
                            uCtx.font = `bold ${idFontSize}px Impact`;
                            uCtx.fillText(idPart, xPos, idY);
                        }
                    }
                } else {
                    // Normal / von10 — single line as before
                    uCtx.font = `bold ${orakelFontSize}px Impact`;
                    uCtx.strokeText(result, xPos, yPos);
                    uCtx.fillText(result, xPos, yPos);
                }
                uCtx.restore();
            }

            uploadBtn.disabled = true;
            uploadBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> ' + (window.f0ckI18n?.uploading || 'Uploading...');

            try {
                const blob = await new Promise(resolve => uploadCanvas.toBlob(resolve, 'image/jpeg', 0.95));
                const formData = new FormData();
                formData.append('file', blob, `meme-${Date.now()}.jpg`);
                const defaultTags = document.getElementById('tags').value || 'meme';
                const autoTag = window.memeTemplate ? window.memeTemplate.name : '';
                const tags = `${defaultTags}, ${autoTag}`;

                formData.append('rating', 'sfw');
                formData.append('tags', tags);
                formData.append('csrf_token', window.csrf_token);

                const res = await fetch('/api/v2/upload', {
                    method: 'POST',
                    body: formData,
                    headers: { 'X-CSRF-Token': window.csrf_token, 'X-Requested-With': 'XMLHttpRequest' }
                });

                const result = await res.json();
                if (result.success) {
                    const dest = result.redirect || '/meme';
                    if (window.loadItemAjax) {
                        window.loadItemAjax(dest);
                    } else if (window.loadPageAjax) {
                        window.loadPageAjax(dest);
                    } else {
                        window.location.href = dest;
                    }
                }
                else {
                    window.flashMessage('Error: ' + result.msg, 3000, 'error');
                    uploadBtn.disabled = false;
                    uploadBtn.innerHTML = `<i class="fa fa-upload"></i> ${(window.f0ckI18n?.meme?.upload_btn) || 'Upload Meme'}`;
                }
            } catch (err) {
                window.flashMessage('Upload failed', 3000, 'error');
                uploadBtn.disabled = false;
            }
        });

        // Initial draw
        setTimeout(draw, 300);
    }
})();

