/**
 * Shared Multi-part Form Data Parsing Utilities
 */

/**
 * Native multipart form data parser
 * @param {Buffer} buffer The raw request body buffer
 * @param {string} boundary The boundary string from the Content-Type header
 * @returns {Object} Parsed form parts
 */
export const parseMultipart = (buffer, boundary) => {
    const parts = {};
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const segments = [];

    let start = 0;
    let idx;

    while ((idx = buffer.indexOf(boundaryBuffer, start)) !== -1) {
        if (start !== 0) {
            segments.push(buffer.slice(start, idx - 2)); // -2 for \r\n before boundary
        }
        start = idx + boundaryBuffer.length + 2; // +2 for \r\n after boundary
    }

    for (const segment of segments) {
        const headerEnd = segment.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headers = segment.slice(0, headerEnd).toString();
        const body = segment.slice(headerEnd + 4);

        const nameMatch = headers.match(/name="([^"]+)"/);

        // Robust filename extraction:
        // 1. RFC 5987: filename*=UTF-8''encoded-name (used by modern browsers for non-ASCII)
        // 2. Standard: filename="name" (ASCII)
        // 3. Fallback: filename=name (unquoted)
        let extractedFilename = null;
        const filenameStarMatch = headers.match(/filename\*\s*=\s*[Uu][Tt][Ff]-8''([^\r\n;]+)/i);
        if (filenameStarMatch) {
            try { extractedFilename = decodeURIComponent(filenameStarMatch[1].trim()); } catch (e) { extractedFilename = filenameStarMatch[1].trim(); }
        } else {
            const filenameQuotedMatch = headers.match(/filename="((?:[^"\\]|\\.)*)"/);
            if (filenameQuotedMatch) {
                extractedFilename = filenameQuotedMatch[1].replace(/\\(.)/g, '$1');
            } else {
                const filenameUnquotedMatch = headers.match(/filename=([^\r\n;]+)/);
                if (filenameUnquotedMatch) extractedFilename = filenameUnquotedMatch[1].trim();
            }
        }

        const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

        if (nameMatch) {
            let name = nameMatch[1];
            if (name.endsWith('[]')) {
                name = name.slice(0, -2);
            }
            if (extractedFilename !== null) {
                const fileObj = {
                    filename: extractedFilename,
                    contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
                    data: body
                };
                if (!parts[name]) {
                    parts[name] = fileObj;
                } else if (Array.isArray(parts[name])) {
                    parts[name].push(fileObj);
                } else {
                    parts[name] = [parts[name], fileObj];
                }
            } else {
                const textVal = body.toString().trim();
                if (!parts[name]) {
                    parts[name] = textVal;
                } else if (Array.isArray(parts[name])) {
                    parts[name].push(textVal);
                } else {
                    parts[name] = [parts[name], textVal];
                }
            }
        }
    }

    return parts;
};

/**
 * Collects the raw request body buffer
 * @param {IncomingMessage} req 
 * @param {number} maxBytes 
 * @returns {Promise<Buffer>}
 */
export const collectBody = (req, maxBytes = 157286400) => { // Default to 150MB (matching maxfilesize)
    return new Promise((resolve, reject) => {
        const chunks = [];
        let received = 0;

        // Fast-path: reject immediately if Content-Length header already exceeds limit
        const declaredLength = parseInt(req.headers['content-length'] || '0', 10);
        if (declaredLength > maxBytes) {
            console.error(`[BODY_TOO_LARGE] Rejection via Content-Length: ${declaredLength} > ${maxBytes}`);
            req.resume();
            return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
        }

        req.on('data', chunk => {
            received += chunk.length;
            if (received > maxBytes) {
                req.destroy();
                return reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);

        if (req.isPaused()) req.resume();
    });
};
