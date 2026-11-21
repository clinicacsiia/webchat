// FLUXOGRAMA: entrada (chat do paciente com Supabase simulado; celular Android ou iPhone simulado pelo userAgent; permissão de avisos simulada) ->
//   validação (a faixa do topo só aparece quando falta instalar o app ou ligar os avisos) ->
//   lógica (Android: "Instalar" abre o convite do navegador; iPhone: passo a passo do Compartilhar; avisos: o primeiro toque de cada acesso pede a permissão,
//           voltar para a página depois de sair conta como novo acesso; bloqueado mostra como liberar; app instalado + avisos ligados: nada aparece) ->
//   saída (PASS/FAIL)
// Versão 1.1 — 21/11/2026 / Mudança: passo a passo do iPhone por versão e navegador (iOS 26/27 com o Compartilhar dentro do "⋯", iOS até 18 com o Compartilhar embaixo, Chrome do iPhone, Instagram e iOS antigo mandam abrir no Safari) e seta apontando o botão; ícone de 180 px e manifesto também no /acesso/.
// Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial (botão de instalar no celular e pedido de avisos a cada acesso)
import { chromium, servidor, criarMundo, novaPaginaChat } from './mock-chat.mjs';
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const srv = await servidor(); const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// Simula o aparelho: userAgent, permissão (null = navegador sem avisos, como o Safari do iPhone fora do app) e se abriu instalado.
function aparelho({ ua, permissao, instalado }) {
  try { Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true }); } catch { /* ignora */ }
  if (permissao === null) { try { delete window.Notification; } catch { /* ignora */ } }
  else {
    window.__pedidos = 0; let atual = permissao;
    try {
      Object.defineProperty(Notification, 'permission', { get: () => atual, configurable: true });
      Notification.requestPermission = async () => { window.__pedidos++; atual = window.__resposta || atual; return atual; };
    } catch { /* ignora */ }
  }
  if (instalado) { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => (/display-mode: standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q)); }
}
async function abrir(opcoes) {
  const mundo = criarMundo();
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: [[aparelho, opcoes]] });
  await page.goto(`${base}/index.html`); await page.waitForSelector('#formInicio', { state: 'visible', timeout: 8000 });
  return { mundo, page, ctx };
}
const faixa = (page) => page.evaluate(() => ({
  faixa: !document.getElementById('faixaApp').hidden,
  instalar: !document.getElementById('faixaInstalar').hidden, instalarTxt: document.getElementById('faixaInstalarTxt').textContent,
  avisos: !document.getElementById('faixaAvisos').hidden, avisosTxt: document.getElementById('faixaAvisosTxt').textContent, botaoAvisos: document.getElementById('btnAtivarAvisos').textContent,
  pedidos: window.__pedidos
}));
// Sai da página (fica escondida) e volta depois de alguns segundos: conta como novo acesso.
async function sairEVoltar(page) {
  await page.evaluate(() => {
    let escondida = true; Object.defineProperty(document, 'hidden', { get: () => escondida, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const agora = Date.now; Date.now = () => agora() + 10000;
    escondida = false; document.dispatchEvent(new Event('visibilitychange'));
  });
}

await caso('Android sem avisos: a faixa mostra "Instalar" e "Ativar avisos"; "Instalar" abre o convite do navegador', async () => {
  const { page, ctx } = await abrir({ ua: UA_ANDROID, permissao: 'default' });
  const a = await faixa(page);
  await page.evaluate(() => {   // o Chrome manda o convite de instalação
    const ev = new Event('beforeinstallprompt', { cancelable: true });
    ev.prompt = async () => { window.__convite = (window.__convite || 0) + 1; }; ev.userChoice = Promise.resolve({ outcome: 'accepted' });
    dispatchEvent(ev);
  });
  await page.click('#btnInstalar'); await page.waitForTimeout(200);
  const b = await page.evaluate(() => ({ convite: window.__convite || 0, instalar: !document.getElementById('faixaInstalar').hidden, pedidos: window.__pedidos }));
  await ctx.close();
  return { ok: a.faixa && a.instalar && a.avisos && b.convite === 1 && !b.instalar && b.pedidos === 0, detalhe: JSON.stringify({ a, b }) };
});

await caso('Android sem convite do navegador: "Instalar" mostra o passo a passo dos três pontinhos', async () => {
  const { page, ctx } = await abrir({ ua: UA_ANDROID, permissao: 'granted' });
  await page.click('#btnInstalar'); await page.waitForSelector('#dicaApp:not([hidden])', { timeout: 3000 });
  const txt = await page.textContent('#dicaApp'); await ctx.close();
  return { ok: /Instalar app/.test(txt) && /tela inicial/.test(txt), detalhe: txt.slice(0, 80) };
});

await caso('iPhone no Safari: a faixa explica que os avisos só chegam com o app instalado e "Instalar" mostra "Adicionar à Tela de Início"', async () => {
  const { page, ctx } = await abrir({ ua: UA_IPHONE, permissao: null });
  const a = await faixa(page);
  await page.click('#btnInstalar'); await page.waitForSelector('#dicaApp:not([hidden])', { timeout: 3000 });
  const txt = await page.textContent('#dicaApp');
  await page.click('#dicaAppOk'); const fechou = await page.$eval('#dicaApp', (d) => d.hidden); await ctx.close();
  return { ok: a.instalar && !a.avisos && /iPhone/.test(a.instalarTxt) && /Compartilhar/.test(txt) && /Adicionar à Tela de Início/.test(txt) && fechou, detalhe: a.instalarTxt };
});

const UA_IOS26 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const UA_IOS27 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Mobile/15E148 Safari/604.1';
const UA_CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1';
const UA_CHROME_IOS_ANTIGO = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/110.0.5481.83 Mobile/15E148 Safari/604.1';
const UA_INSTAGRAM = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.21.95 (iPhone18,1; iOS 26_1; pt_BR; pt; scale=3.00; 1206x2622; 700000000)';
async function dicaIOS(ua) {
  const { page, ctx } = await abrir({ ua, permissao: null });
  await page.click('#btnInstalar'); await page.waitForSelector('#dicaApp:not([hidden])', { timeout: 3000 });
  const r = await page.evaluate(() => ({
    titulo: document.getElementById('dicaAppTitulo').textContent, txt: document.getElementById('dicaApp').textContent,
    seta: document.getElementById('dicaSeta').hidden ? '' : document.getElementById('dicaSeta').dataset.lugar,
    safari: (document.getElementById('dicaAbrirSafari') || {}).href || '', alto: document.getElementById('dicaApp').classList.contains('no-alto')
  }));
  await page.click('#dicaAppOk'); r.setaFechou = await page.$eval('#dicaSeta', (d) => d.hidden);
  await ctx.close(); return r;
}
for (const [nome, ua] of [['iOS 26 (iPhone 17)', UA_IOS26], ['iOS 27', UA_IOS27]]) {
  await caso(`${nome} no Safari: o passo a passo manda tocar no "⋯", depois Compartilhar, e a seta aponta embaixo à direita`, async () => {
    const r = await dicaIOS(ua);
    return { ok: /⋯/.test(r.txt) && /Compartilhar/.test(r.txt) && /Adicionar à Tela de Início/.test(r.txt) && /Abrir como App Web/.test(r.txt) && /CPF e PIN/.test(r.txt) && /WhatsApp/.test(r.txt)
      && r.seta === 'baixo-direita' && r.alto && r.setaFechou, detalhe: JSON.stringify({ seta: r.seta, titulo: r.titulo }) };
  });
}
await caso('iOS 17 no Safari: Compartilhar na barra de baixo, no meio (seta no meio de baixo), sem "Abrir como App Web"', async () => {
  const r = await dicaIOS(UA_IPHONE);
  return { ok: /barra de baixo, no meio/.test(r.txt) && !/Abrir como App Web/.test(r.txt) && r.seta === 'baixo-meio', detalhe: r.seta };
});
await caso('Chrome do iPhone: Compartilhar no alto à direita, seta no alto, e o botão "Abrir no Safari"', async () => {
  const r = await dicaIOS(UA_CHROME_IOS);
  return { ok: /Chrome/.test(r.titulo) && /no alto, à direita/.test(r.txt) && r.seta === 'cima-direita' && /^x-safari-http/.test(r.safari), detalhe: JSON.stringify(r).slice(0, 160) };
});
await caso('Instagram no iPhone: não instala; pede para abrir no Safari (botão x-safari e copiar link), sem seta', async () => {
  const r = await dicaIOS(UA_INSTAGRAM);
  return { ok: /Abra no Safari/.test(r.titulo) && /outro app/.test(r.txt) && /Copiar o link/.test(r.txt) && /^x-safari-http/.test(r.safari) && !/\?|#/.test(r.safari.replace(/^x-safari-https?:\/\/[^/]+\/[^?#]*/, '')) && r.seta === '', detalhe: r.safari };
});
await caso('Chrome em iOS 16.2: o iPhone não deixa instalar fora do Safari; manda abrir no Safari', async () => {
  const r = await dicaIOS(UA_CHROME_IOS_ANTIGO);
  return { ok: /Abra no Safari/.test(r.titulo) && /não deixa instalar/.test(r.txt), detalhe: r.titulo };
});
await caso('cabeçalho: ícone de 180 px do iPhone, nome curto "CSI" e o /acesso/ com o manifesto liberado na CSP', async () => {
  const { page, ctx } = await abrir({ ua: UA_IOS26, permissao: null });
  const a = await page.evaluate(() => ({ icone: document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href'), titulo: document.querySelector('meta[name="apple-mobile-web-app-title"]').content }));
  const ok180 = await page.evaluate(async () => { const r = await fetch('apple-touch-icon.png'); const b = await createImageBitmap(await r.blob()); return b.width === 180 && b.height === 180; });
  const acesso = await page.evaluate(async () => (await fetch('acesso/index.html')).text());
  await ctx.close();
  return { ok: a.icone === 'apple-touch-icon.png' && a.titulo === 'CSI' && ok180 && /rel="manifest" href="\.\.\/manifest\.webmanifest"/.test(acesso) && /manifest-src 'self'/.test(acesso), detalhe: JSON.stringify(a) };
});

await caso('avisos não permitidos: o primeiro toque pede a permissão; sair e voltar pede de novo (a cada acesso)', async () => {
  const { page, ctx } = await abrir({ ua: UA_ANDROID, permissao: 'default' });
  await page.click('#fNome'); await page.click('#fTel'); await page.waitForTimeout(100);
  const a = await faixa(page);   // recusou (continua "default"): 1 pedido só neste acesso
  await page.click('#faixaAvisosX'); const b = await faixa(page);   // fechou a faixa
  await sairEVoltar(page); await page.waitForTimeout(100);
  const c = await faixa(page);   // voltou: a faixa reaparece
  await page.click('#fNome'); await page.waitForTimeout(100);
  const d = await faixa(page); await ctx.close();
  return { ok: a.pedidos === 1 && a.avisos && !b.avisos && c.avisos && d.pedidos === 2, detalhe: [a.pedidos, b.avisos, c.avisos, d.pedidos].join(' / ') };
});

await caso('"Ativar avisos" liga e a faixa some', async () => {
  const { page, ctx } = await abrir({ ua: UA_ANDROID, permissao: 'default' });
  await page.evaluate(() => { window.__resposta = 'granted'; });
  await page.click('#btnAtivarAvisos'); await page.waitForTimeout(200);
  const a = await faixa(page); await ctx.close();
  return { ok: !a.avisos && a.pedidos === 1, detalhe: JSON.stringify(a) };
});

await caso('avisos bloqueados: a faixa diz "bloqueados" e "Como liberar" mostra o caminho para Permitir, sem pedir de novo', async () => {
  const { page, ctx } = await abrir({ ua: UA_ANDROID, permissao: 'denied' });
  const a = await faixa(page);
  await page.click('#btnAtivarAvisos'); await page.waitForSelector('#dicaApp:not([hidden])', { timeout: 3000 });
  const txt = await page.textContent('#dicaApp'); await page.click('#dicaAppOk'); await page.click('#fNome');
  const b = await faixa(page); await ctx.close();
  return { ok: a.avisos && /bloqueados/.test(a.avisosTxt) && a.botaoAvisos === 'Como liberar' && /Permitir/.test(txt) && b.pedidos === 0, detalhe: a.avisosTxt };
});

await caso('app instalado e avisos ligados: a faixa não aparece', async () => {
  const { page, ctx } = await abrir({ ua: UA_ANDROID, permissao: 'granted', instalado: true });
  const a = await faixa(page); const menu = await page.$eval('#btnInstalarMenu', (b) => b.hidden); await ctx.close();
  return { ok: !a.faixa && menu, detalhe: JSON.stringify(a) };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
