// FLUXOGRAMA: entrada (a Sentinela real numa página mínima, com o servidor simulado devolvendo "pin_obrigatorio" como a produção faz desde 15/11) -> validação (versão antiga do chat explica e oferece atualizar; versão nova fica quieta porque a própria tela leva ao PIN) -> lógica (o botão apaga a cópia velha guardada no aparelho e leva à página do PIN com ?voltar=chat, sem tocar na conversa guardada) -> saída (casos PASS/FAIL)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (código CSI-261116-1020-RPC-JQY9: paciente com o chat 2026.11.14-2 via só "problema com o servidor")
import { chromium, servidor } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const PAGINA = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><div id="apoio" hidden></div><script src="/sentinela.js"></script></body></html>`;

// Abre a Sentinela com a versão de chat informada e dispara a chamada que a produção recusa.
async function abrir(versao) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const incidentes = [];
  await page.route(`${base}/pagina.html`, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGINA }));
  await page.route(`${base}/acesso/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<title>acesso</title>porta do PIN' }));
  await page.route('**/rest/v1/rpc/chat_incidente', (r) => { try { incidentes.push(JSON.parse(r.request().postData() || '{}')); } catch { /* ignora */ } r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' }); });
  await page.route('**/rest/v1/rpc/chat_listar', (r) => r.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'P0001', message: 'pin_obrigatorio', hint: 'Digite o seu PIN para continuar.' }) }));
  await page.goto(`${base}/pagina.html`);
  await page.evaluate((v) => {
    localStorage.setItem('webchat.conversa.v1', JSON.stringify({ id: 'conversa-de-teste', token: 'x' }));
    window.Sentinela.iniciar({ apoio: document.querySelector('#apoio'), contexto: () => ({ versao: v, conversa: 'conversa-de-teste', tela: 'conversa' }),
      acoes: { enviarIncidente: async (inc) => { await fetch('https://x.supabase.co/rest/v1/rpc/chat_incidente', { method: 'POST', body: JSON.stringify({ p_codigo: inc.codigo, p_tipo: inc.tipo, p_detalhe: inc }) }); } } });
    return fetch('https://x.supabase.co/rest/v1/rpc/chat_listar', { method: 'POST', body: '{}' }).catch(() => null);
  }, versao);
  return { ctx, page, incidentes };
}
const apoio = (page) => page.$eval('#apoio', (n) => ({ visivel: !n.hidden, texto: n.textContent }));

await caso('chat de 14/11 (2026.11.14-2) recusado por falta de PIN: explica a versão antiga, mostra o código e oferece atualizar e continuar', async () => {
  const { ctx, page } = await abrir('2026.11.14-2');
  await page.waitForFunction(() => /Precisamos atualizar/.test(document.querySelector('#apoio').textContent), null, { timeout: 4000 });
  const a = await apoio(page); await ctx.close();
  return { ok: a.visivel && /versão antiga/.test(a.texto) && /PIN/.test(a.texto) && /mesma conversa/.test(a.texto) && /CSI-\d{6}-\d{4}-PIN-[A-Z0-9]{4}/.test(a.texto) && /Atualizar e continuar a conversa/.test(a.texto) && !/problema para falar com o servidor/.test(a.texto), detalhe: a.texto.slice(0, 120) };
});

await caso('o incidente vai para a equipe como tipo PIN, com o mesmo código da tela e sem texto de paciente', async () => {
  const { ctx, page, incidentes } = await abrir('2026.11.14-2');
  await page.waitForFunction(() => /CSI-/.test(document.querySelector('#apoio').textContent), null, { timeout: 4000 }); await espera(500);
  const cod = (await apoio(page)).texto.match(/CSI-\d{6}-\d{4}-PIN-[A-Z0-9]{4}/)?.[0]; await ctx.close();
  const inc = incidentes.find((i) => i.p_codigo === cod);
  return { ok: !!inc && inc.p_tipo === 'PIN' && inc.p_detalhe.detalhe.versao_antiga === true && inc.p_detalhe.detalhe.chamada === 'chat_listar', detalhe: `${cod} ${inc ? inc.p_tipo : 'não chegou'}` };
});

await caso('o botão apaga a cópia velha do aparelho, mantém a conversa guardada e leva à página do PIN com ?voltar=chat', async () => {
  const { ctx, page } = await abrir('2026.11.14-2');
  await page.evaluate(async () => { await caches.open('webchat-cliente-v50'); await caches.open('outro-site'); });
  await page.waitForSelector('#apoio .ap-btn.principal', { timeout: 4000 });
  await page.click('#apoio .ap-btn.principal');
  await page.waitForURL(/\/acesso\/\?voltar=chat/, { timeout: 8000 });
  const r = await page.evaluate(async () => ({ caches: await caches.keys(), conversa: localStorage.getItem('webchat.conversa.v1') }));
  await ctx.close();
  return { ok: !r.caches.includes('webchat-cliente-v50') && r.caches.includes('outro-site') && /conversa-de-teste/.test(r.conversa || ''), detalhe: JSON.stringify(r) };
});

await caso('chat novo (2026.11.16-8) fica quieto: a própria tela leva ao PIN, a Sentinela não fala nem registra', async () => {
  const { ctx, page, incidentes } = await abrir('2026.11.16-8');
  await espera(1200);
  const a = await apoio(page); await ctx.close();
  return { ok: !a.visivel && incidentes.length === 0, detalhe: `visivel=${a.visivel} incidentes=${incidentes.length}` };
});

await caso('chat sem versão conhecida conta como antigo', async () => {
  const { ctx, page } = await abrir(null);
  await page.waitForFunction(() => /Precisamos atualizar/.test(document.querySelector('#apoio').textContent), null, { timeout: 4000 });
  await ctx.close(); return { ok: true };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
