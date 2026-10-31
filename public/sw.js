const CACHE_NAME = 'f0ckm-pwa';
const ASSETS_TO_CACHE = [
  '/',
  '/s/css/f0ckm.css',
  '/s/js/f0ckm.js',
  '/s/img/favicon.png'
];

// Stream bridge for memory-efficient exports
const streamControllers = new Map();
const streamQueues = new Map();

self.addEventListener('install', (event) => {
  console.log('[SW] Installing v8...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url => cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err)))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating v8...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Handle streaming export downloads
  if (url.pathname === '/api/v2/export/stream') {
    const streamId = url.searchParams.get('id');
    const fileName = url.searchParams.get('filename') || 'export.zip';

    const stream = new ReadableStream({
      start(controller) {
        streamControllers.set(streamId, controller);
        // Flush any chunks that arrived before the fetch was set up
        const queue = streamQueues.get(streamId) || [];
        streamQueues.delete(streamId);
        for (const item of queue) {
          try {
            if (item.chunk) controller.enqueue(item.chunk);
            if (item.done) { controller.close(); streamControllers.delete(streamId); }
            if (item.port) item.port.postMessage({ type: 'ACK' });
          } catch (e) {
            if (item.port) item.port.postMessage({ type: 'ERROR', error: e.message });
          }
        }
      },
      cancel() {
        streamControllers.delete(streamId);
        streamQueues.delete(streamId);
      }
    });

    event.respondWith(new Response(stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Accept-Ranges': 'none',
        'X-Content-Type-Options': 'nosniff'
      }
    }));
    return;
  }

  if (url.pathname === '/') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          return cached || fetch(event.request);
        })
    );
  } else if (ASSETS_TO_CACHE.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((response) => {
        return response || fetch(event.request).catch(() => new Response('Asset not found', { status: 404 }));
      })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLAIM') {
    self.clients.claim();
    return;
  }
  if (event.data && event.data.type === 'EXPORT_CHUNK') {
    const { id, chunk, done } = event.data;
    const controller = streamControllers.get(id);
    
    if (controller) {
      try {
        if (chunk) controller.enqueue(chunk);
        if (done) {
          controller.close();
          streamControllers.delete(id);
          streamQueues.delete(id);
        }
        if (event.ports && event.ports[0]) event.ports[0].postMessage({ type: 'ACK' });
      } catch (e) {
        console.error('[SW] Stream error:', e);
        streamControllers.delete(id);
        if (event.ports && event.ports[0]) event.ports[0].postMessage({ type: 'ERROR', error: e.message });
      }
    } else {
      // Controller not ready yet — queue the chunk for when the fetch arrives
      if (!streamQueues.has(id)) streamQueues.set(id, []);
      // Transfer port out of event so we can reply after controller is set
      const port = (event.ports && event.ports[0]) || null;
      streamQueues.get(id).push({ chunk, done, port });
    }
  }
});
