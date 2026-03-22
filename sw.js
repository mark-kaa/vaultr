// Service Worker — network-first, omgår cache
const CACHE = 'vaultr-v1774213813';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  // Altid network-first — aldrig cache HTML
  if(e.request.destination === 'document'){
    e.respondWith(fetch(e.request, {cache: 'no-store'}).catch(() => caches.match(e.request)));
    return;
  }
});
