// Keeps the app shell on the device, so the app opens at once – also offline, and while the server is waking up.
// The shell is served from the cache; every opening fetches a fresh copy of the whole shell in the background
// and swaps it in together (never a mix of old and new files), so a new version shows on the next opening.
// API calls always go to the network.
const CACHE = 'mlr-v37';
const SHELL = ['/', '/index.html', '/styles.css', '/config.js', '/app.js', '/rashei-teivot.js', '/aramaic.js', '/lang-detect.js', '/firebase-config.js',
  '/js/dom.js', '/js/sounds.js', '/js/util.js', '/js/store.js', '/js/pageImages.js', '/js/media.js', '/js/speech.js',
  '/vendor/cloud.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  // old versions of the shell go; the page images the app keeps (mlr-pages-*) stay
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && !k.startsWith('mlr-pages-')).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()),
));

let refreshing = null;
function refreshShell() {
  refreshing ??= (async () => {
    const fresh = await Promise.all(SHELL.map(async (u) => {
      const r = await fetch(u, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${u}: ${r.status}`);
      return [u, r];
    }));
    const c = await caches.open(CACHE);
    await Promise.all(fresh.map(([u, r]) => c.put(u, r)));
  })().catch(() => {}).finally(() => { refreshing = null; });
  return refreshing;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) return;
  if (url.pathname.startsWith('/join/')) { e.respondWith(fetch(e.request).catch(() => caches.match('/index.html'))); return; }
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.open(CACHE).then((c) => c.match(url.pathname)).then((hit) => hit || fetch(e.request)));
    if (e.request.mode === 'navigate') e.waitUntil(refreshShell());
    return;
  }
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
