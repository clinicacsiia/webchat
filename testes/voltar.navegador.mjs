// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado) -> validação (o botão "Voltar e corrigir" só aparece depois da primeira pergunta) -> lógica (toca, o assistente refaz a pergunta anterior e a conversa segue) -> saída (PASS/FAIL)
// Versão 1.0 — 12/11/2026 / Mudança: Implementação inicial. Não substitui o teste do banco (sql-voltar.test.mjs). Requer um Chromium (CHROMIUM_PATH).
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

await caso('na primeira pergunta o botão não aparece; depois de responder, aparece; ao tocar, a pergunta anterior volta e o botão some de novo', async () => {
  const mundo = criarMundo();
  const { page } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  const naPrimeira = await page.isVisible('#btnCorrigir');
  await page.click('#msgs .op >> text=Exame');
  await page.waitForSelector('#msgs .msg.agente >> text=particular ou por convênio', { timeout: 6000 });
  await page.waitForSelector('#btnCorrigir', { state: 'visible', timeout: 4000 });
  await page.click('#btnCorrigir');
  await page.waitForSelector('#msgs .msg.agente >> text=Tudo bem, vamos corrigir', { timeout: 6000 });
  await page.waitForSelector('#btnCorrigir', { state: 'hidden', timeout: 4000 });
  const ativa = await page.$$eval('#msgs .msg.agente:last-of-type .widget .op', (bs) => bs.length > 0 && bs.every((b) => !b.disabled));
  const chamou = mundo.chamadas.some((c) => c.nome === 'chat_voltar');
  await page.click('#msgs .msg.agente:last-of-type .op >> text=Consulta');
  await page.waitForSelector('#msgs .msg.agente >> text=particular ou por convênio >> nth=1', { timeout: 6000 }).catch(() => {});
  return { ok: !naPrimeira && ativa && chamou, detalhe: `visível na 1ª=${naPrimeira}; pergunta refeita ativa=${ativa}; chamou chat_voltar=${chamou}` };
});
await caso('com uma pessoa da equipe atendendo, o botão não aparece', async () => {
  const mundo = criarMundo();
  const { page } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  await page.click('#msgs .op >> text=Exame');
  await page.waitForSelector('#btnCorrigir', { state: 'visible', timeout: 4000 });
  await page.click('#btnHumano');
  await page.waitForSelector('#msgs .msg.agente >> text=atendente vai continuar', { timeout: 6000 });
  await page.waitForSelector('#btnCorrigir', { state: 'hidden', timeout: 4000 });
  return { ok: true, detalhe: '' };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} passaram`);
process.exit(ok === resultados.length ? 0 : 1);
