/*
 * Service worker: cache-first for the app shell and vendored libraries, so the whole app,
 * OpenCV included, runs with no connection after the first visit.
 *
 * Bump VERSION on every deploy that changes a cached file. Shell files are fetched with
 * cache: 'reload' so a new version never picks up a stale copy from the HTTP cache.
 */
const VERSION = '1';
const CACHE = 'docscan-v' + VERSION;

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/actions.js',
  './js/capture.js',
  './js/cv-client.js',
  './js/pdf.js',
  './js/pipeline.js',
  './js/storage.js',
  './js/store.js',
  './js/ui.js',
  './js/views/crop.js',
  './js/views/export.js',
  './js/views/home.js',
  './js/views/page.js',
  './js/worker/cv-worker.js',
  './vendor/pdf-lib.min.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Pinned and 10 MB: allowed to come from the HTTP cache the page just filled
const PINNED = ['./vendor/opencv.js'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled([
        ...SHELL.map(url => cache.add(new Request(url, { cache: 'reload' }))),
        ...PINNED.map(url => cache.add(url)),
      ]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('docscan-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
