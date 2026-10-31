import db from "./sql.mjs";

// Maps for fast O(1) in-memory lookups:
// dest (string) -> owner username (lowercase string)
const _privateDests = new Map();
const _privateIds = new Map();

// Unavailable items (visibility === 3, serves HTTP 451 for non-logged in users):
const _unavailableDests = new Map();
const _unavailableIds = new Map();

let _initialized = false;
let _initPromise = null;

/**
 * Load all active private and unavailable items into memory cache.
 */
export async function initPrivateItems() {
  try {
    const rows = await db`
      SELECT id, dest, LOWER(username) as username, visibility
      FROM items
      WHERE visibility IN (2, 3) AND is_deleted = false
    `;
    _privateDests.clear();
    _privateIds.clear();
    _unavailableDests.clear();
    _unavailableIds.clear();

    for (const r of rows) {
      const u = r.username || '';
      if (r.visibility === 2) {
        if (r.dest) _privateDests.set(r.dest, u);
        if (r.id) _privateIds.set(Number(r.id), u);
      } else if (r.visibility === 3) {
        if (r.dest) _unavailableDests.set(r.dest, u);
        if (r.id) _unavailableIds.set(Number(r.id), u);
      }
    }
    if (!_initialized) {
      console.log(`[BOOT] Loaded ${_privateDests.size} private item(s) and ${_unavailableDests.size} unavailable item(s) into memory cache`);
    }
    _initialized = true;
  } catch (err) {
    console.error('[BOOT] Failed to load private/unavailable items into cache:', err.message);
  }
}

export function ensurePrivateItemsInit() {
  if (!_initialized && !_initPromise) {
    _initPromise = initPrivateItems().finally(() => { _initPromise = null; });
  }
  return _initPromise;
}

// Background sync every 30 seconds
setInterval(() => {
  initPrivateItems().catch(() => {});
}, 30_000).unref();

export function addPrivateItem(id, dest, username) {
  const u = (username || '').toLowerCase();
  if (dest) _privateDests.set(dest, u);
  if (id) _privateIds.set(Number(id), u);
  // Ensure not in unavailable
  removeUnavailableItem(id, dest);
}

export function removePrivateItem(id, dest) {
  if (dest) _privateDests.delete(dest);
  if (id) _privateIds.delete(Number(id));
}

export function addUnavailableItem(id, dest, username) {
  const u = (username || '').toLowerCase();
  if (dest) _unavailableDests.set(dest, u);
  if (id) _unavailableIds.set(Number(id), u);
  // Ensure not in private
  removePrivateItem(id, dest);
}

export function removeUnavailableItem(id, dest) {
  if (dest) _unavailableDests.delete(dest);
  if (id) _unavailableIds.delete(Number(id));
}

/**
 * Checks if a given pathname (/b/<dest>, /t/<id>..., /ca/<id>...) is a private or unavailable item.
 * Returns { isPrivate: boolean, isUnavailable: boolean, owner: string } or null if normal public.
 */
export function getPrivateItemFromPath(pathname) {
  if (!pathname || typeof pathname !== 'string') return null;

  if (pathname.startsWith('/b/')) {
    let dest;
    try {
      dest = decodeURIComponent(pathname.slice(3));
    } catch {
      dest = pathname.slice(3);
    }
    dest = dest.split('?')[0].split('#')[0];
    const privOwner = _privateDests.get(dest);
    if (privOwner !== undefined) {
      return { isPrivate: true, isUnavailable: false, owner: privOwner };
    }
    const unavOwner = _unavailableDests.get(dest);
    if (unavOwner !== undefined) {
      return { isPrivate: false, isUnavailable: true, owner: unavOwner };
    }
    return null;
  }

  if (pathname.startsWith('/t/')) {
    let filename;
    try {
      filename = decodeURIComponent(pathname.slice(3));
    } catch {
      filename = pathname.slice(3);
    }
    filename = filename.split('?')[0].split('#')[0];
    const match = filename.match(/^(\d+)/);
    if (match) {
      const id = parseInt(match[1], 10);
      const privOwner = _privateIds.get(id);
      if (privOwner !== undefined) {
        return { isPrivate: true, isUnavailable: false, owner: privOwner };
      }
      const unavOwner = _unavailableIds.get(id);
      if (unavOwner !== undefined) {
        return { isPrivate: false, isUnavailable: true, owner: unavOwner };
      }
    }
    return null;
  }

  if (pathname.startsWith('/ca/')) {
    let filename;
    try {
      filename = decodeURIComponent(pathname.slice(4));
    } catch {
      filename = pathname.slice(4);
    }
    filename = filename.split('?')[0].split('#')[0];
    const match = filename.match(/^(\d+)/);
    if (match) {
      const id = parseInt(match[1], 10);
      const privOwner = _privateIds.get(id);
      if (privOwner !== undefined) {
        return { isPrivate: true, isUnavailable: false, owner: privOwner };
      }
      const unavOwner = _unavailableIds.get(id);
      if (unavOwner !== undefined) {
        return { isPrivate: false, isUnavailable: true, owner: unavOwner };
      }
    }
    return null;
  }

  return null;
}

export function isPrivateItemPath(pathname) {
  return getPrivateItemFromPath(pathname) !== null;
}

/**
 * Render standard 502 Bad Gateway response.
 */
export function render502(req, res) {
  if (req.headers && req.headers['x-requested-with'] === 'XMLHttpRequest') {
    res.writeHead(502, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }).end(JSON.stringify({ success: false, msg: 'Bad Gateway' }));
  } else {
    const body = (typeof global._buildGatePage === 'function')
      ? global._buildGatePage(req)
      : (global._nginx502 || `<html>\n<head><title>502 Bad Gateway</title></head>\n<body bgcolor="white">\n<center><h1>502 Bad Gateway</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>`);
    res.writeHead(502, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }).end(body);
  }
}

/**
 * Render HTTP 451 Unavailable For Legal Reasons response.
 */
export function render451(req, res) {
  if (req.headers && (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.headers.accept?.includes('application/json'))) {
    res.writeHead(451, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }).end(JSON.stringify({ success: false, is_unavailable: true, msg: '451 - Unavailable For Legal Reasons' }));
  } else {
    const body = `<html>\r
<head><title>451 Unavailable For Legal Reasons</title></head>\r
<body>\r
<center><h1>451 Unavailable For Legal Reasons</h1></center>\r
<hr><center>nginx</center>\r
</body>\r
</html>\r
`;
    res.writeHead(451, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }).end(body);
  }
}

