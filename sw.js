// ShelfVision service worker — offline-first app shell + runtime caching of
// AI model files (CDN scripts and TF model weights) so audits work offline
// after the first online run.

const SHELL_CACHE = 'shelfvision-shell-v1';
const RUNTIME_CACHE = 'shelfvision-runtime-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/ai.js',
  './js/db.js',
  './js/erpnext.js',
  './js/tracker.js',
  './js/camera.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![SHELL_CACHE, RUNTIME_CACHE].includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Never cache ERPNext API traffic.
  if (url.pathname.startsWith('/api/')) return;

  const isModelAsset =
    url.hostname.includes('jsdelivr.net') ||
    url.hostname.includes('tfhub.dev') ||
    url.hostname.includes('kaggle.com') ||
    url.hostname.includes('storage.googleapis.com');

  if (isModelAsset) {
    // Cache-first for immutable model/CDN assets.
    e.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin === location.origin) {
    // Network-first for the app shell so updates land, cache fallback offline.
    // cache:'no-cache' forces revalidation so stale HTTP-cache copies of the
    // JS modules are never served after a deploy.
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});
