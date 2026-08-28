const CACHE = 'sdr-monstr-v10';
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-32.png', './icons/icon-192.png', './icons/icon-512.png'];

// KNOWN DEBT (28 Aug 2026): the install below caches './' and './index.html'
// with a plain fetch, which can hit the browser HTTP cache. GitHub Pages
// serves HTML with Cache-Control: max-age=600, so right after a deploy a
// returning user can keep seeing the previous version for up to ~10 min
// (plus one reload) before this cache refills with the new shell. Fix when it
// matters: precache the shell with `cache: 'reload'`, e.g.
//   c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))
// Not done now — the flip-flop is short and self-healing.

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache Supabase API calls — always go to network
  if (url.hostname.endsWith('supabase.co')) return;

  // App navigations: network-first, so a new deploy is picked up immediately.
  // Falls back to the cached shell when offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Static assets (icons, manifest, etc.): cache-first.
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
      if (e.request.method === 'GET' && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => cached))
  );
});
