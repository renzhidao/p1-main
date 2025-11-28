const CACHE_NAME = 'p1-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './easytier.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.0/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/davidshimjs-qrcodejs@0.0.2/qrcode.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});