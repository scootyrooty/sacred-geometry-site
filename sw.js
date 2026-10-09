/* All resources are local. Change this version whenever shipped files change. */
const VERSION = 'ambient-scenes-c24d9bb9b82b';
const ASSETS = ["./","./index.html","./style.css","./manifest.webmanifest","./icon.svg","./icon-192.png","./icon-512.png","./core/platform.js","./core/scenes.js","./core/timeline.js","./geometry.js","./scenes/grid-of-life.js","./core/torus-gpu.js","./scenes/torus.js","./core/renderer.js","./core/remote.js","./app.js"];
const CACHE = VERSION + '-' + self.registration.scope;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.endsWith('-' + self.registration.scope) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(event.request, {ignoreSearch:true});
    if (cached) return cached;
    if (event.request.mode === 'navigate') return cache.match('./index.html');
    return fetch(event.request);
  }));
});
self.addEventListener('message', event => {
  if (event.data === 'CHECK_OFFLINE') event.waitUntil(caches.open(CACHE).then(async cache => {
    const complete = (await Promise.all(ASSETS.map(asset => cache.match(asset)))).every(Boolean);
    event.ports[0]?.postMessage({ready:complete, version:VERSION});
  }));
});
