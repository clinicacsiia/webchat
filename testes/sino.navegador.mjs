// FLUXOGRAMA: entrada (chat do paciente com Supabase simulado e a permissão de notificações simulada: concedida, bloqueada ou pendente) -> validação (o item do sino só aparece com conversa e navegador compatível) -> lógica (ligado -> silenciar -> ligar de novo; bloqueado explica como liberar; pendente pede a permissão) -> saída (PASS/FAIL)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (NOT-01)
import { chromium, servidor, criarMundo, novaPaginaChat } from './mock-chat.mjs';
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const srv = await servidor(); const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
async function abrir(permissao) {
  const mundo = criarMundo();
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: [[(p) => { try { Object.defineProperty(Notification, 'permission', { get: () => p, configurable: true }); Notification.requestPermission = async () => p; } catch { /* sem Notification */ } }, permissao]] });
  await page.goto(`${base}/index.html`); await page.waitForSelector('#formInicio', { state: 'visible', timeout: 8000 });
  await page.click('#fQuem .unidade >> nth=0'); await page.fill('#fNome', 'Ana Souza'); await page.fill('#fTel', '71999998888'); await page.fill('#fEmail', 'a@b.co');
  await page.check('#fAceite'); await page.check('#fPrevisao'); await page.click('#btnIniciar'); await page.waitForSelector('#msgs .msg.agente .op', { timeout: 8000 });
  return { mundo, page, ctx };
}
const abrirMenu = async (page) => { await page.click('#btnMenu'); await page.waitForFunction(() => { const b = document.getElementById('btnSino'); return b && !b.hidden && b.textContent.length > 3; }, null, { timeout: 4000 }); return page.$eval('#btnSino', (b) => ({ estado: b.dataset.estado, txt: b.textContent })); };
await caso('permissão concedida: o item mostra "ligados"; tocar silencia (chama o servidor) e tocar de novo religa', async () => {
  const { mundo, page, ctx } = await abrir('granted');
  const a = await abrirMenu(page); await page.click('#btnSino'); await page.waitForTimeout(300);
  const b = await abrirMenu(page); await page.click('#btnSino'); await page.waitForTimeout(300);
  const c = await abrirMenu(page);
  const chamadas = mundo.chamadas.filter((x) => x.nome === 'chat_push_silenciar').map((x) => x.corpo.p_silenciar); await ctx.close();
  return { ok: a.estado === 'ligado' && b.estado === 'silenciado' && c.estado === 'ligado' && chamadas.join() === 'true,false', detalhe: [a.estado, b.estado, c.estado, chamadas.join('/')].join(' > ') };
});
await caso('permissão bloqueada: mostra "bloqueados neste aparelho" e explica como liberar, sem chamar o servidor', async () => {
  const { mundo, page, ctx } = await abrir('denied'); let aviso = '';
  page.on('dialog', async (d) => { aviso = d.message(); await d.accept(); });
  const a = await abrirMenu(page); await page.click('#btnSino'); await page.waitForTimeout(300);
  const n = mundo.chamadas.filter((x) => x.nome === 'chat_push_silenciar').length; await ctx.close();
  return { ok: a.estado === 'bloqueado' && /bloqueados neste aparelho/.test(a.txt) && /Permitir/.test(aviso) && n === 0, detalhe: aviso.slice(0, 60) };
});
await caso('permissão ainda não pedida: o item oferece "Ativar avisos no celular"', async () => {
  const { page, ctx } = await abrir('default'); const a = await abrirMenu(page); await ctx.close();
  return { ok: a.estado === 'desligado' && /Ativar avisos/.test(a.txt) };
});
await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
