// FLUXOGRAMA: entrada (chat do paciente com Supabase simulado; chat_config devolve as chaves de entrada) -> validação (sem chave ou erro de rede = só o webchat, como antes)
//   -> lógica (webchat ligado: formulário + Começar; previsão ligada: botão "Previsão de marcação" para previsao/; webchat desligado + previsão ligada: SÓ o botão Previsão; os dois desligados: o webchat volta)
//   -> saída (PASS/FAIL por caso) | ROLLBACK: reverter index.html e supabase/entrada-previsao.sql
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (Configurações > Entrada do paciente).
import { chromium, servidor, criarMundo, novaPaginaChat } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const srv = await servidor(); const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const visivel = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);

async function abrir(configExtra, mexer) {
  const mundo = criarMundo(); mundo.configExtra = configExtra; if (mexer) mexer(mundo);
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  await page.goto(`${base}/index.html`); await page.waitForSelector('#telaInicio', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(600);
  const r = { form: await visivel(page, '#formInicio'), comecar: await visivel(page, '#btnIniciar'), prev: await visivel(page, '#btnPrevisaoEntrada'), dica: await visivel(page, '#dicaPrevisaoEntrada'),
    href: await page.getAttribute('#btnPrevisaoEntrada', 'href'), acompanhar: await page.locator('#linkAcompanhar').count() };
  return { ...r, page, ctx };
}

await caso('sem as chaves (como hoje): só o webchat, sem botão Previsão', async () => {
  const r = await abrir({}); await r.ctx.close();
  return { ok: r.form && r.comecar && !r.prev && !r.dica, detalhe: JSON.stringify({ form: r.form, comecar: r.comecar, prev: r.prev }) };
});
await caso('webchat ligado e previsão desligada: igual a hoje', async () => {
  const r = await abrir({ entrada_webchat_modo: 'sim', entrada_previsao_modo: 'nao' }); await r.ctx.close();
  return { ok: r.form && r.comecar && !r.prev };
});
await caso('os dois ligados: aparecem o Começar e o botão Previsão (sem a explicação, que é só para quem não tem outro caminho)', async () => {
  const r = await abrir({ entrada_webchat_modo: 'sim', entrada_previsao_modo: 'sim' }); await r.ctx.close();
  return { ok: r.form && r.comecar && r.prev && !r.dica && r.href === 'previsao/', detalhe: r.href };
});
await caso('webchat DESLIGADO e previsão ligada: some o Começar e o formulário, fica só o botão Previsão (com a explicação)', async () => {
  const r = await abrir({ entrada_webchat_modo: 'nao', entrada_previsao_modo: 'sim' });
  const texto = await r.page.locator('#btnPrevisaoEntrada').innerText();
  await r.ctx.close();
  return { ok: !r.form && !r.comecar && r.prev && r.dica && /Previsão de marcação/.test(texto), detalhe: JSON.stringify({ form: r.form, comecar: r.comecar, prev: r.prev }) };
});
await caso('os dois desligados: o webchat volta sozinho (o paciente nunca fica sem caminho)', async () => {
  const r = await abrir({ entrada_webchat_modo: 'nao', entrada_previsao_modo: 'nao' }); await r.ctx.close();
  return { ok: r.form && r.comecar && !r.prev };
});
await caso('chat_config falhando (sem rede): o webchat abre normalmente', async () => {
  const r = await abrir({ entrada_webchat_modo: 'nao', entrada_previsao_modo: 'sim' }, (m) => { m.falhas.chat_config = { status: 500, corpo: { message: 'falha simulada' } }; }); await r.ctx.close();
  return { ok: r.form && r.comecar && !r.prev };
});
await caso('tocar no botão Previsão leva à página previsao/', async () => {
  const r = await abrir({ entrada_webchat_modo: 'nao', entrada_previsao_modo: 'sim' });
  await r.page.route('**/previsao/**', (rota) => rota.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>previsao</title><body>PREVISAO-DE-MENTIRA</body>' }));
  await r.page.click('#btnPrevisaoEntrada'); await r.page.waitForURL(/\/previsao\/$/, { timeout: 5000 });
  const url = r.page.url(); await r.ctx.close();
  return { ok: /\/previsao\/$/.test(url), detalhe: url };
});

await browser.close(); srv.close();
const falhas = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} casos passaram`);
process.exit(falhas ? 1 : 0);
