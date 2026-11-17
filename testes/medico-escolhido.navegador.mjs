// FLUXOGRAMA: entrada (chat do paciente no navegador + Supabase simulado; o paciente escolheu um médico) -> validação (a lista mostra só o médico escolhido, o chat procura nas 3 janelas da API (45 dias) e NUNCA oferece trocar de médico)
//   -> processamento (médico sem horário: avisa que vai abrir a solicitação de disponibilidade (previsão) e abre ao toque do botão) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (pedido do dono depois do caso da paciente que pediu uma médica e o chat marcou com outra).
// Requer um Chromium (CHROMIUM_PATH). Não fala com o Supabase nem com o Klingo reais.
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
async function abrirCal(mundo, page) {
  mundo.inserir('agente', 'Agora escolha o dia e o horário.', { tipo: 'calendario', passo: 'horario', grupo: 1, rotulo: 'Escolher data e horário' });
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForSelector('#msgs .btn-w >> text=Escolher data e horário', { timeout: 8000 });
  await page.click('#msgs .btn-w >> text=Escolher data e horário');
}
const botoes = (page) => page.$$eval('#folhaRodape button', (bs) => bs.map((b) => b.textContent.trim()));
const texto = (page) => page.$eval('#folha', (n) => n.textContent);
async function abrir(medico) {
  const mundo = criarMundo(); mundo.api.estado = 'com_horarios'; mundo.medico = medico;
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, {});
  await comecarConversa(page, base); await abrirCal(mundo, page);
  return { mundo, page, ctx, erros };
}

await caso('o médico só tem horário na 3ª janela da API (30 a 45 dias): o chat procura sozinho nas janelas 0, 1 e 2 e mostra só os horários dele(a), sem botão para trocar de médico', async () => {
  const { mundo, page, ctx, erros } = await abrir({ nome: 'MAIANA DE TESTE SILVA', achaNaJanela: 2 });
  await page.waitForSelector('#folhaCorpo .cal-dia.livre', { timeout: 10000 });
  const t = await texto(page), janelas = mundo.chamadasApi.map((c) => c.corpo.janela);
  await ctx.close();
  return { ok: JSON.stringify(janelas) === '[0,1,2]' && /Mostrando só os horários de Maiana/.test(t) && /o\(a\) médico\(a\) que você escolheu/.test(t) && !/outros médicos/.test(t) && erros.excecoes.length === 0,
           detalhe: `janelas=${janelas}; erros=${erros.excecoes.length}` };
});
await caso('o médico não tem horário em nenhuma janela: avisa que não há horário em 45 dias e que vai abrir a solicitação (previsão) para a equipe avaliar; nenhum horário de outro médico, nenhum botão de trocar', async () => {
  const { mundo, page, ctx } = await abrir({ nome: 'MAIANA DE TESTE SILVA' });
  await page.waitForSelector('#folhaCorpo .aviso-cal', { timeout: 10000 });
  const t = await texto(page), b = await botoes(page), slots = await page.$$('#folhaCorpo .slot, #folhaCorpo .cal-dia'), janelas = mundo.chamadasApi.map((c) => c.corpo.janela);
  await ctx.close();
  return { ok: JSON.stringify(janelas) === '[0,1,2]' && /não tem horário disponível nos próximos 45 dias\./.test(t) && /Vamos abrir uma solicitação \(previsão\) aqui no chat para a nossa equipe avaliar/.test(t) && /não é um agendamento/.test(t)
                && b.includes('Abrir a solicitação') && b.includes('Falar com a equipe') && !/outro/i.test(b.join('|')) && !/outros médicos/.test(t) && slots.length === 0, detalhe: `botões=${b.join(' | ')}; janelas=${janelas}` };
});
await caso('tocar em "Abrir a solicitação" chama o banco uma vez, fecha a janela e não escolhe nenhum horário', async () => {
  const { mundo, page, ctx } = await abrir({ nome: 'MAIANA DE TESTE SILVA' });
  await page.waitForSelector('#folhaRodape button >> text=Abrir a solicitação', { timeout: 10000 });
  await page.click('#folhaRodape button >> text=Abrir a solicitação');
  await page.waitForFunction(() => document.querySelector('#folha').hidden, null, { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 300));
  const abertos = (mundo.medico.abertos || []).length, marcou = mundo.chamadas.some((c) => c.nome === 'chat_horario_escolher');
  await ctx.close();
  return { ok: abertos === 1 && !marcou, detalhe: `aberturas=${abertos}; escolheu horário=${marcou}` };
});

const falhou = resultados.filter((x) => !x).length;
console.log(falhou ? `\n${falhou} FALHA(S)` : `\nTodos os ${resultados.length} testes passaram.`);
await browser.close(); srv.close();
process.exit(falhou ? 1 : 0);
