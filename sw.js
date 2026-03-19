// Service Worker — network-first, omgår GitHub Pages cache
const CACHE = 'vaultr-v1773957450';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if(e.request.url.includes('mark-kaa.github.io/pokemon-samling')){
    e.respondWith(fetch(e.request, {cache: 'no-store'}).catch(() => caches.match(e.request)));
  }
});
