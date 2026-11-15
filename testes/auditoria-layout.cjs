// FLUXOGRAMA: entrada (qualquer teste *.navegador.mjs + variáveis AUD_*) -> validação (só liga se AUD_SAIDA existir) -> lógica (injeta auditoria-layout-pagina.js em todo contexto do Playwright, opcionalmente força largura/altura da tela e a escala de letra) -> saída (um achado por linha em JSONL; resumo por auditoria-layout-resumo.mjs)
// Versão 1.0 — 15/11/2026 / Mudança: implementação inicial (varredura de CSS/layout da auditoria de 15/11/2026)
//
// Uso (a partir de testes/):
//   AUD_SAIDA=/tmp/achados.jsonl AUD_LARG=360 AUD_ALT=740 AUD_ESC=1.36 CHROMIUM_PATH=... node -r ./auditoria-layout.cjs chat-corrida.navegador.mjs
//   node auditoria-layout-resumo.mjs /tmp           (resume todos os .jsonl da pasta)
// AUD_LARG/AUD_ALT forçam o tamanho da tela (celular = 360x740; "teclado aberto" = 360x480). AUD_ESC=1.36 liga a "letra muito grande" do chat.
const fs = require('node:fs');
const path = require('node:path');
if (process.env.AUD_SAIDA) {
  const SAIDA = process.env.AUD_SAIDA;
  const LARG = Number(process.env.AUD_LARG || 0), ALT = Number(process.env.AUD_ALT || 0);
  const SCRIPT = (process.env.AUD_ESC ? `window.__AUD_ESC=${Number(process.env.AUD_ESC)};` : '') + fs.readFileSync(path.join(__dirname, 'auditoria-layout-pagina.js'), 'utf8');
  const pw = require(require.resolve('playwright', { paths: [__dirname] }));
  const preparar = async (ctx) => {
    try { await ctx.exposeFunction('__audRelatar', (j) => { try { fs.appendFileSync(SAIDA, j + '\n'); } catch { /* sem arquivo de saída: ignora */ } }); } catch { /* já exposta */ }
    await ctx.addInitScript(SCRIPT);
  };
  const t = pw.chromium, lancar = t.launch.bind(t);
  t.launch = async (...a) => {
    const b = await lancar(...a);
    const nc = b.newContext.bind(b), np = b.newPage.bind(b);
    b.newContext = async (o = {}) => { if (LARG) o = { ...o, viewport: { width: LARG, height: ALT || 740 } }; const c = await nc(o); await preparar(c); return c; };
    b.newPage = async (o = {}) => { if (LARG) o = { ...o, viewport: { width: LARG, height: ALT || 740 } }; const p = await np(o); await preparar(p.context()); return p; };
    return b;
  };
}
