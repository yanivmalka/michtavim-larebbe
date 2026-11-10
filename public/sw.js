// Caches the app shell so it opens fast and installs as an app. API calls always go to the network.
const CACHE = 'mlr-v7';
const SHELL = ['/', '/index.html', '/styles.css', '/config.js', '/app.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
