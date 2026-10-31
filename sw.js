// Service worker do chat do cliente: abre na hora com a cópia guardada e busca a versão nova por trás (vale na próxima abertura).
// O link pode vir do WhatsApp, do e-mail ou da bio com ?origem=...: a cópia é a mesma para todos.
const VERSAO = 'webchat-cliente-v2';
const BASE = ['./', 'index.html', 'icon-192.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(BASE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO && k.startsWith('webchat-cliente')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  const url = new URL(r.url);
  // /painel/ e /fila/ ficam fora do cache. A URL da fila leva o token de assinatura (não pode ser guardada no dispositivo)
  // e a chave única './' abaixo serviria a página do chat no lugar da fila.
  if (r.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/painel/') || url.pathname.includes('/fila/')) return;
  const pagina = r.mode === 'navigate';
  const chave = pagina ? new Request(new URL('./', self.registration.scope)) : r;
  e.respondWith(caches.open(VERSAO).then(async (c) => {
    const guardada = await c.match(chave, { ignoreSearch: true });
    const daRede = fetch(r).then((res) => { if (res.ok) c.put(chave, res.clone()); return res; });
    if (guardada) { e.waitUntil(daRede.catch(() => {})); return guardada; }
    return daRede.catch(() => c.match('index.html'));
  }));
});
