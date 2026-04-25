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
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

        if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
                parts[name] = {
                    filename: filenameMatch[1],
                    contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
                    data: body
                };
            } else {
                parts[name] = body.toString().trim();
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
