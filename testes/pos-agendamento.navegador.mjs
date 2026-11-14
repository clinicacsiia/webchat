// FLUXOGRAMA: entrada (chat do paciente com Supabase simulado; o "banco" manda as mensagens do pós-agendamento) -> validação (a tela mostra a espera com o título que o banco mandou, a lista de marcações e os botões das ações; clicar manda passo e valor certos)
//   -> processamento (cancelar com confirmação em duas etapas; nada é mostrado como "cancelado" antes da mensagem do banco) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão (pós-agendamento v2.1). Dados inventados; não fala com o Klingo nem com o Supabase reais.
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const online = (page) => page.evaluate(() => dispatchEvent(new Event('online')));

await caso('a espera mostra o título que o banco mandou ("Consultando…") e NÃO o texto de reserva de horário', async () => {
  const mundo = criarMundo(); const { page, ctx, erros } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  mundo.inserir('agente', 'Estou consultando as suas marcações no sistema da clínica.', { tipo: 'marcando', operacao: '11111111-1111-4111-8111-111111111111', titulo: 'Consultando as suas marcações…' });
  await online(page); await page.waitForSelector('#msgs .acomp.marcando', { timeout: 8000 });
  const t = await page.$eval('#msgs .acomp.marcando', (e) => e.textContent);
  await ctx.close();
  return { ok: /Consultando as suas marcações/.test(t) && !/Reservando o seu horário/.test(t) && erros.excecoes.length === 0, detalhe: t.slice(0, 60) };
});
await caso('sem título (marcação comum) continua "Reservando o seu horário…" (nada mudou para quem marca)', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  mundo.inserir('agente', 'Reservando.', { tipo: 'marcando', operacao: '11111111-1111-4111-8111-111111111111' });
  await online(page); await page.waitForSelector('#msgs .acomp.marcando', { timeout: 8000 });
  const t = await page.$eval('#msgs .acomp.marcando', (e) => e.textContent); await ctx.close();
  return { ok: /Reservando o seu horário/.test(t), detalhe: t.slice(0, 50) };
});
await caso('a lista de marcações vira botões; tocar numa manda passo "marc_lista" e o valor "m:<protocolo>"', async () => {
  const mundo = criarMundo(); const { page, ctx, erros } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  mundo.inserir('agente', 'Encontrei estas marcações ativas. Qual delas você quer ver?', { tipo: 'escolha', passo: 'marc_lista', itens: [
    { valor: 'm:26701', rotulo: 'US ABDOME — sexta-feira, 20/11 às 08:30' }, { valor: 'm:26702', rotulo: 'RM JOELHO — quinta-feira, 19/11 às 10:00' }, { valor: 'nenhum', rotulo: 'Não é nenhuma destas' }] });
  await online(page); await page.waitForSelector('#msgs .op[data-valor="m:26701"]', { timeout: 8000 });
  await page.click('#msgs .op[data-valor="m:26701"]');
  await page.waitForFunction(() => true); await new Promise((r) => setTimeout(r, 400));
  const env = mundo.chamadas.filter((c) => c.nome === 'chat_responder').at(-1);
  await ctx.close();
  return { ok: !!env && env.corpo.p_passo === 'marc_lista' && JSON.stringify(env.corpo.p_valor).includes('m:26701') && erros.excecoes.length === 0, detalhe: JSON.stringify(env?.corpo ?? {}).slice(0, 120) };
});
await caso('confirmação de cancelamento: dois botões ("Sim, cancelar" / "Não, manter a marcação") e o passo certo', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  mundo.inserir('agente', 'Confirma o cancelamento desta marcação?', { tipo: 'escolha', passo: 'marc_cancelar', itens: [{ valor: 'cancelar_sim', rotulo: 'Sim, cancelar' }, { valor: 'cancelar_nao', rotulo: 'Não, manter a marcação' }] });
  await online(page); await page.waitForSelector('#msgs .op[data-valor="cancelar_nao"]', { timeout: 8000 });
  const rot = await page.$$eval('#msgs .op[data-valor]', (bs) => bs.map((b) => b.textContent.trim()).filter((t) => /cancelar|manter/i.test(t)));
  await page.click('#msgs .op[data-valor="cancelar_nao"]'); await new Promise((r) => setTimeout(r, 400));
  const env = mundo.chamadas.filter((c) => c.nome === 'chat_responder').at(-1);
  await ctx.close();
  return { ok: rot.length === 2 && env?.corpo.p_passo === 'marc_cancelar' && JSON.stringify(env.corpo.p_valor).includes('cancelar_nao'), detalhe: rot.join(' | ') };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} passaram`);
process.exit(ok === resultados.length ? 0 : 1);
