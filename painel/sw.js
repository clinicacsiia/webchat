// Service worker do painel: rede primeiro, cache só como reserva offline.
const VERSAO = 'webchat-painel-v12';
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

// Aviso à equipe com o painel fechado (Web Push enviado pela Edge Function avisar-equipe). O texto nunca leva nome nem dado de saúde.
// Se o painel já está na tela, ele mesmo avisa (som e notificação), então não repete.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    if (cs.some((c) => c.visibilityState === 'visible')) return;
    return self.registration.showNotification(String(d.titulo || 'CSI · Painel').slice(0, 80), {
      body: String(d.corpo || 'Há um paciente aguardando atendimento.').slice(0, 200),
      icon: 'icon-192.png', badge: 'icon-192.png', tag: 'equipe-atendimento', renotify: true, vibrate: [200, 100, 200]
    });
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(self.registration.scope);
  }));
});
