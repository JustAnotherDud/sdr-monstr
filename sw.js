const CACHE = 'sdr-monstr-v14';
// Third-party files that never change for a given URL live in their own cache, so a
// CACHE bump does not throw away the offline copy of supabase-js.
const RUNTIME = 'sdr-monstr-runtime-v1';
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-32.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the HTTP cache, so a deploy never precaches the previous shell
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE && k !== RUNTIME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

async function putCopy(cacheName, req, res) {
  if (req.method === 'GET' && res.ok) (await caches.open(cacheName)).put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache Supabase API calls, always go to network
  if (url.hostname.endsWith('supabase.co')) return;

  // esm.sh serves supabase-js pinned to an exact version (index.html), and every file under
  // that version is immutable: cache-first, so the app opens offline. Changing the pin in
  // index.html changes the URL, so a new version is fetched and cached on first use.
  if (url.hostname === 'esm.sh' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(RUNTIME).then((c) => c.match(e.request)).then((cached) => cached || fetch(e.request).then((res) => putCopy(RUNTIME, e.request, res)))
    );
    return;
  }

  // Font stylesheet: stale-while-revalidate (the content can change, a late update is harmless).
  if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(
      caches.open(RUNTIME).then((c) => c.match(e.request)).then((cached) => {
        const fresh = fetch(e.request).then((res) => putCopy(RUNTIME, e.request, res)).catch(() => cached);
        return cached || fresh;
      })
    );
    return;
  }

  // App navigations: network-first, so a new deploy is picked up immediately.
  // Falls back to the cached shell when offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((res) => putCopy(CACHE, e.request, res))
        .catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Static assets (icons, manifest, etc.): cache-first.
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => putCopy(CACHE, e.request, res)))
  );
});
