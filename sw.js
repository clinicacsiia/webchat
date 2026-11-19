// Service worker do chat do cliente: abre na hora com a cópia guardada e busca a versão nova por trás (vale na próxima abertura).
// O link pode vir do WhatsApp, do e-mail ou da bio com ?origem=...: a cópia é a mesma para todos.
const VERSAO = 'webchat-cliente-v76';
const BASE = ['./', 'index.html', 'privacidade.html', 'termos.html', 'sentinela.js', 'nomes-exame.js', 'icon-192.png', 'img/logo-csi.svg', 'img/logo-csi-sem-anel.svg', 'img/logo-csi-anel.svg', 'img/logo-csi-simbolo.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  // cache: 'reload' = busca na rede de verdade (o GitHub Pages guarda 10 minutos e a instalação podia gravar uma cópia velha)
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(BASE.map((u) => new Request(u, { cache: 'reload' })))));
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
  // /painel/, /fila/, /minha-vez/, /agendamento/ e /simulacao/ (módulos e dados que mudam) ficam fora do cache. A URL da fila leva o token de assinatura (não pode ser guardada no dispositivo)
  // e a chave única './' abaixo serviria a página do chat no lugar da fila.
  // /acesso/ (PIN e cadastro) também fica de fora: a página tem de ser sempre a da rede. Antes ela era respondida com a cópia do chat e o PIN não aparecia.
  if (r.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/painel/') || url.pathname.includes('/fila/') || url.pathname.includes('/minha-vez/') || url.pathname.includes('/agendamento/') || url.pathname.includes('/acesso/') || url.pathname.includes('/simulacao/')) return;
  const pagina = r.mode === 'navigate';
  // Navegação: só as páginas guardadas, cada uma com a sua cópia. Qualquer outra vai direto para a rede (antes todas recebiam a cópia do chat).
  const raiz = new URL('./', self.registration.scope).pathname;
  const PAGINAS = { [raiz]: './', [raiz + 'index.html']: './', [raiz + 'privacidade.html']: 'privacidade.html', [raiz + 'termos.html']: 'termos.html' };
  if (pagina && !(url.pathname in PAGINAS)) return;
  const chave = pagina ? new Request(new URL(PAGINAS[url.pathname], self.registration.scope)) : r;
  e.respondWith(caches.open(VERSAO).then(async (c) => {
    const guardada = await c.match(chave, { ignoreSearch: true });
    const daRede = fetch(r).then((res) => {
      if (res.ok) {
        // Abre-se na hora com a cópia guardada; se a da rede for outra versão, avisa a página (ela atualiza no momento certo).
        const velha = guardada && guardada.headers && guardada.headers.get && guardada.headers.get('etag'), nova = res.headers && res.headers.get && res.headers.get('etag');
        if (velha && nova && velha !== nova && self.clients && self.clients.matchAll) {
          self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((cl) => cl.postMessage({ tipo: 'nova_versao' }))).catch(() => {});
        }
        c.put(chave, res.clone());
      }
      return res;
    });
    if (guardada) { e.waitUntil(daRede.catch(() => {})); return guardada; }
    return daRede.catch(() => c.match('index.html'));
  }));
});

// Push do chat: avisa que chegou resposta mesmo com o chat fechado. Se o chat já está na tela (visível), não repete o aviso.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    if (cs.some((c) => c.visibilityState === 'visible')) return;
    return self.registration.showNotification(String(d.titulo || 'CSI · Clínica de Saúde e Imagem').slice(0, 80), {
      body: String(d.corpo || 'Você recebeu uma resposta no chat.').slice(0, 200),
      icon: 'icon-192.png', badge: 'icon-192.png', tag: 'chat-resposta', renotify: true, vibrate: [200, 100, 200]
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
