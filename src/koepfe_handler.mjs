import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import lib from './inc/lib.mjs';
import cfg from './inc/config.mjs';

function parseMultipart(req) {
    return new Promise((resolve, reject) => {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(body);
            const boundaryMatch = req.headers['content-type']?.match(/boundary=(.+)$/i);
            if (!boundaryMatch) return reject(new Error('No boundary'));
            const boundary = '--' + boundaryMatch[1];
            let start = buffer.indexOf(boundary) + boundary.length + 2;
            let fileData = null;
            let filename = null;
            let csrfToken = null;
            
            while (start < buffer.length) {
                const headerEnd = buffer.indexOf('\r\n\r\n', start);
                if (headerEnd === -1) break;
                const headerStr = buffer.slice(start, headerEnd).toString();
                const nextBoundary = buffer.indexOf(boundary, headerEnd);
                if (nextBoundary === -1) break;
                const chunkData = buffer.slice(headerEnd + 4, nextBoundary - 2);

                if (headerStr.includes('name="file"')) {
                    const fnMatch = headerStr.match(/filename="(.+?)"/);
                    if (fnMatch) filename = fnMatch[1];
                    fileData = chunkData;
                } else if (headerStr.includes('name="csrf_token"')) {
                    csrfToken = chunkData.toString();
                }
                start = nextBoundary + boundary.length + 2;
            }
            resolve({ fileData, filename, csrfToken });
        });
        req.on('error', reject);
    });
}

import db from './inc/sql.mjs';

export async function handleKoepfeUpload(req, res) {
    // Manual Session Lookup since this is a bypass middleware
    let user = [];
    if (req.cookies && req.cookies.session) {
        user = await db`
            select "user".id, "user".login, "user".user, "user".admin, "user_sessions".csrf_token
            from "user_sessions"
            left join "user" on "user".id = "user_sessions".user_id
            where "user_sessions".session = ${lib.sha256(req.cookies.session)}
            limit 1
          `;
    }

    if (user.length === 0 || !user[0].admin) {
        return res.reply ? res.reply({ code: 403, body: JSON.stringify({ success: false, msg: 'Forbidden' }) }) : res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Forbidden' }));
    }
    
    req.session = user[0];
    
    try {
        const { fileData, filename, csrfToken } = await parseMultipart(req);
        
        if (!req.session.csrf_token || csrfToken !== req.session.csrf_token) {
             return res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: 'Invalid CSRF' }));
        }

        if (!fileData || fileData.length === 0) {
            throw new Error('No file data');
        }

        const ext = path.extname(filename || '.png').toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(ext)) {
            throw new Error('Unsupported format');
        }

        const newName = crypto.randomBytes(8).toString('hex') + ext;
        const targetPath = path.join(cfg.paths.koepfe, newName);

        await fs.writeFile(targetPath, fileData);

        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, file: '/s/koepfe/' + newName }));

    } catch (e) {
        console.error(e);
        return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, msg: e.message }));
    }
}
