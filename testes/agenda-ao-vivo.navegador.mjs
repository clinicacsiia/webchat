// FLUXOGRAMA: entrada (chat do paciente + Supabase e Edge Function simulados; a "leitura do Klingo" revela o que mudou na agenda) -> validação (a lista de horários só é pedida DEPOIS da conferência; falha, desligado e demora) -> lógica (calendário mostra o que o Klingo mostra agora, avisa quando não conseguiu conferir e confere de novo ao confirmar) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (AGE-04: dia, horário e médico ao vivo no chat)
//
// Requer um Chromium (CHROMIUM_PATH). Não fala com o Supabase nem com o Klingo reais.
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const TESTE = (extra = {}) => [[(x) => { window.__WEBCHAT_TESTE__ = x; }, extra]];

// Abre o calendário como a paciente: o assistente manda o botão "Escolher data e horário" e ela toca nele.
async function abrirCal(mundo, page) {
  mundo.inserir('agente', 'Agora escolha o dia e o horário.', { tipo: 'calendario', passo: 'horario', grupo: 1, rotulo: 'Escolher data e horário' });
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForSelector('#msgs .btn-w >> text=Escolher data e horário', { timeout: 8000 });
  await page.click('#msgs .btn-w >> text=Escolher data e horário');
}
const slots = (page) => page.$$eval('#folhaCorpo .slots .slot:not(.off)', (bs) => bs.map((b) => b.textContent.trim()));
const nomesChamadas = (mundo) => mundo.chamadas.map((c) => c.nome);

// Versão 2.0 — 14/11/2026: os casos do CALENDÁRIO da grade (conferir a ocupação antes de pedir a lista, aviso de previsão, "Conferir de novo") foram retirados: o calendário agora só mostra horário da API (ver calendario-api.navegador.mjs).
await caso('na pergunta de médico, confere o Klingo e mostra o próximo horário de cada um (e quem está sem horário)', async () => {
  const mundo = criarMundo();
  mundo.medicos = [{ nome: 'DRA ANA', proximo: `${mundo.dia(2)} 08:30`, livres: 10 }, { nome: 'DR PEDRO', proximo: null, livres: 0 }];
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  mundo.inserir('agente', 'Tem preferência de médico?', { tipo: 'escolha', passo: 'medico', itens: [
    { valor: '', rotulo: 'Tanto faz (qualquer médico)' }, { valor: 'DRA ANA', rotulo: 'Dra Ana' }, { valor: 'DR PEDRO', rotulo: 'Dr Pedro' }] });
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForFunction(() => [...document.querySelectorAll('#msgs .op')].some((b) => /Sem horário livre/.test(b.textContent)), null, { timeout: 8000 });
  const textos = await page.$$eval('#msgs .op[data-valor]', (bs) => Object.fromEntries(bs.map((b) => [b.dataset.valor, b.textContent.replace(/\s+/g, ' ').trim()])));
  const ordem = nomesChamadas(mundo);
  await ctx.close();
  return { ok: /Dra Ana.*Próximo horário: [^\s,]{3}, \d{2}\/\d{2} às 08:30/.test(textos['DRA ANA']) && /Dr Pedro.*Sem horário livre nos próximos dias/.test(textos['DR PEDRO'])
      && !/Próximo|Sem horário|conferindo/.test(textos['']) && ordem.indexOf('fn:chat-agenda-ao-vivo') < ordem.indexOf('chat_medicos_disponiveis') && erros.excecoes.length === 0,
    detalhe: JSON.stringify(textos) };
});

await caso('se a lista de médicos não puder ser conferida, os nomes ficam sem anotação (nada de texto "conferindo" preso)', async () => {
  const mundo = criarMundo();
  mundo.falhas.chat_medicos_disponiveis = { status: 500, corpo: { code: 'XX000', message: 'falha simulada' } };
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  mundo.inserir('agente', 'Tem preferência de médico?', { tipo: 'escolha', passo: 'medico', itens: [{ valor: '', rotulo: 'Tanto faz' }, { valor: 'DRA ANA', rotulo: 'Dra Ana' }] });
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !!document.querySelector('#msgs .op[data-valor="DRA ANA"]'), null, { timeout: 8000 });
  await espera(1500);
  const texto = await page.$eval('#msgs .op[data-valor="DRA ANA"]', (b) => b.textContent.trim());
  await ctx.close();
  return { ok: texto === 'Dra Ana', detalhe: texto };
});

await caso('o token e a conversa vão no corpo da consulta à API de horários; nenhum dado de paciente é enviado à função', async () => {
  const mundo = criarMundo();
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  await page.waitForSelector('#folhaCorpo .cal-dia.livre', { timeout: 8000 });
  const c = mundo.chamadasApi[0].corpo;
  await ctx.close();
  return { ok: Object.keys(c).sort().join(',') === 'conversa,fresco,janela,token' && c.conversa === mundo.conversa && c.token === mundo.token, detalhe: Object.keys(c).join(',') };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
