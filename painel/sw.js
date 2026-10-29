// Service worker do painel: rede primeiro, cache só como reserva offline.
const VERSAO = 'webchat-painel-v1';
const BASE = ['./', 'index.html', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(BASE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO && k.startsWith('webchat-painel')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r)
      .then((res) => {
        if (res.ok) { const copia = res.clone(); caches.open(VERSAO).then((c) => c.put(r, copia)); }
        return res;
      })
      .catch(() => caches.match(r).then((m) => m || caches.match('index.html')))
  );
});
