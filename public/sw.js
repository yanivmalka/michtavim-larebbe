// Caches the app shell so it opens fast and installs as an app. API calls always go to the network.
const CACHE = 'mlr-v29';
const SHELL = ['/', '/index.html', '/styles.css', '/config.js', '/app.js', '/rashei-teivot.js', '/firebase-config.js', '/vendor/cloud.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) return;
  if (url.pathname.startsWith('/join/')) { e.respondWith(fetch(e.request).catch(() => caches.match('/index.html'))); return; }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// a tap on "the answer is ready": open (or focus) the app on that conversation
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const conv = e.notification.data?.conv;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const client = list[0];
    if (client) { client.postMessage({ openConv: conv }); return client.focus(); }
    return self.clients.openWindow(conv ? `/?conv=${encodeURIComponent(conv)}` : '/');
  }));
});
