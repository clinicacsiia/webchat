// Service worker do portal "Minha vez": recebe o aviso (Web Push) com a página fechada e abre o portal ao tocar.
// Não guarda nada em cache: a fila tem que ser sempre a de agora.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { titulo: 'Fila da clínica', corpo: e.data ? e.data.text() : '' }; }
  const vez = d.tipo === 'vez';
  e.waitUntil(self.registration.showNotification(String(d.titulo || 'Fila da clínica').slice(0, 80), {
    body: String(d.corpo || '').slice(0, 200),
    icon: 'icon-192.png', badge: 'icon-192.png',
    tag: 'fila-' + (d.tipo || 'aviso'),          // o mesmo aviso dado pela página e pelo push aparece uma vez só
    renotify: true, requireInteraction: vez,
    vibrate: vez ? [300, 120, 300, 120, 600] : [200, 100, 200],
    data: { tipo: d.tipo || '' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(self.registration.scope);
  }));
});
