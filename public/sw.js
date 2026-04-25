const CACHE_NAME = 'w0bm-pwa-v8';
const ASSETS_TO_CACHE = [
  '/',
  '/s/css/f0ckm.css',
  '/s/js/f0ckm.js',
  '/s/img/favicon.png'
];

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
