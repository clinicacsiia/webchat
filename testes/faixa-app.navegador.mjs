// FLUXOGRAMA: entrada (chat do paciente com Supabase simulado; celular Android ou iPhone simulado pelo userAgent; permissão de avisos simulada) ->
//   validação (a faixa do topo só aparece quando falta instalar o app ou ligar os avisos) ->
//   lógica (Android: "Instalar" abre o convite do navegador; iPhone: passo a passo do Compartilhar; avisos: o primeiro toque de cada acesso pede a permissão,
//           voltar para a página depois de sair conta como novo acesso; bloqueado mostra como liberar; app instalado + avisos ligados: nada aparece) ->
//   saída (PASS/FAIL)
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
