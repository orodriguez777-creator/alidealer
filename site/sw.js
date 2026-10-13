// Lets the site install as an app and open without a connection.
// Always tries the network first so deals and prices are never stale.
const CACHE = 'alidealer-v1';
const SHELL = ['/', '/offline.html', '/styles.css?v=18', '/config.js?v=18', '/store.js?v=19', '/icon-192.png', '/cart.png'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    const url = new URL(req.url);
    // deals, clicks and admin always go straight to the network
    if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/admin')) return;
    e.respondWith(fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
    }).catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('/offline.html') : Response.error())));
});
