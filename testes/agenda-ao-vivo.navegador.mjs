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

await caso('ao abrir o calendário o Klingo é conferido ANTES de pedir a lista, e o horário que ficou ocupado não aparece', async () => {
  const mundo = criarMundo();
  const hoje2 = mundo.dia(2);
  mundo.agenda.aoVivo.retira = { [hoje2]: ['09:00'] };   // alguém marcou 09:00 direto no Klingo um instante atrás
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  await page.waitForSelector('#folhaCorpo .slots .slot', { timeout: 8000 });
  const lista = await slots(page);
  const ordem = nomesChamadas(mundo);
  const iFn = ordem.indexOf('fn:chat-agenda-ao-vivo'), iLista = ordem.indexOf('chat_horarios');
  const status = await page.$eval('#folhaCorpo', (n) => n.textContent);
  const primeiraChamada = mundo.chamadasFuncao[0].corpo;
  await ctx.close();
  return { ok: iFn >= 0 && iLista > iFn && lista.includes('08:00') && lista.includes('08:30') && !lista.includes('09:00') && /Agenda conferida agora/.test(status)
      && /^\d{4}-\d{2}-\d{2}$/.test(primeiraChamada.de) && erros.excecoes.length === 0,
    detalhe: `ordem=${ordem.filter((n) => /horarios|ao-vivo/.test(n)).join('>')} slots=${lista} corpo=${JSON.stringify(primeiraChamada).replace(/"token":"[^"]+"/, '"token":"…"')}` };
});

await caso('enquanto confere, a tela diz "Conferindo a agenda da clínica agora…" e depois mostra a lista', async () => {
  const mundo = criarMundo();
  mundo.agenda.aoVivo.atraso = 900;
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  const durante = await page.waitForSelector('#folhaCorpo .carregando >> text=Conferindo a agenda da clínica agora', { timeout: 3000 }).then(() => true, () => false);
  const aindaSemLista = !nomesChamadas(mundo).includes('chat_horarios');
  await page.waitForSelector('#folhaCorpo .slots .slot', { timeout: 8000 });
  await ctx.close();
  return { ok: durante && aindaSemLista, detalhe: `texto durante=${durante}, lista pedida só depois=${aindaSemLista}` };
});

await caso('se o Klingo não responde, mostra os horários do banco com aviso e "Conferir de novo" tenta outra vez', async () => {
  const mundo = criarMundo();
  mundo.agenda.aoVivo.falha = true;
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  await page.waitForSelector('#folhaCorpo .slots .slot', { timeout: 8000 });
  const aviso = await page.$$eval('#folhaCorpo .aviso-cal', (ns) => ns.map((n) => n.textContent).join(' | '));
  const antes = mundo.chamadasFuncao.length;
  mundo.agenda.aoVivo.falha = false;
  await page.click('#folhaCorpo .aviso-cal button >> text=Conferir de novo');
  await page.waitForFunction(() => /Agenda conferida agora/.test(document.querySelector('#folhaCorpo').textContent), null, { timeout: 8000 });
  const depois = await page.$eval('#folhaCorpo', (n) => n.textContent);
  const lista = await slots(page);
  await ctx.close();
  return { ok: /Não consegui conferir a agenda da clínica agora/.test(aviso) && mundo.chamadasFuncao.length > antes && !/Não consegui conferir/.test(depois) && lista.length >= 3 && erros.excecoes.length === 0,
    detalhe: `aviso="${aviso.slice(0, 90)}…" chamadas ${antes}->${mundo.chamadasFuncao.length}` };
});

await caso('erro HTTP da função (500) também cai no aviso e a paciente continua podendo escolher', async () => {
  const mundo = criarMundo();
  mundo.agenda.aoVivo.status = 500;
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  await page.waitForSelector('#folhaCorpo .slots .slot', { timeout: 8000 });
  const aviso = await page.$eval('#folhaCorpo', (n) => /Não consegui conferir a agenda/.test(n.textContent));
  await page.click('#folhaCorpo .slots .slot >> nth=0');
  const habilitado = await page.$eval('#folhaRodape button', (b) => !b.disabled);
  await ctx.close();
  return { ok: aviso && habilitado && erros.excecoes.length === 0 };
});

await caso('interruptor desligado ("desligado"): mostra os horários do banco sem aviso de falha', async () => {
  const mundo = criarMundo();
  mundo.agenda.aoVivo.motivo = 'desligado';
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  await page.waitForSelector('#folhaCorpo .slots .slot', { timeout: 8000 });
  const texto = await page.$eval('#folhaCorpo', (n) => n.textContent);
  await ctx.close();
  return { ok: !/Não consegui conferir/.test(texto) && !/Agenda conferida agora/.test(texto) };
});

await caso('ao confirmar, o dia é conferido de novo; se o horário foi tomado, avisa e NÃO grava', async () => {
  const mundo = criarMundo();
  const dia2 = mundo.dia(2);
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE({ vivoConfirmaMs: 1 }) });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  await page.waitForSelector('#folhaCorpo .slots .slot', { timeout: 8000 });
  await page.click('#folhaCorpo .slots .slot >> text=08:30');
  await espera(50);
  mundo.agenda.aoVivo.retira = { [dia2]: ['08:30'] };       // outra pessoa marcou 08:30 no Klingo enquanto ela decidia
  const antes = mundo.chamadasFuncao.length;
  await page.click('#folhaRodape button');
  await page.waitForFunction(() => /acabou de ficar indispon/.test(document.body.textContent), null, { timeout: 8000 });
  await page.waitForFunction(() => ![...document.querySelectorAll('#folhaCorpo .slots .slot:not(.off)')].some((b) => b.textContent.trim() === '08:30'), null, { timeout: 8000 });
  const lista = await slots(page);
  await ctx.close();
  return { ok: mundo.chamadasFuncao.length > antes && !mundo.escolhido && !lista.includes('08:30') && lista.includes('08:00'), detalhe: `escolhido=${JSON.stringify(mundo.escolhido)} slots=${lista}` };
});

await caso('ao confirmar com o horário ainda livre, grava a escolha (e confere antes)', async () => {
  const mundo = criarMundo();
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE({ vivoConfirmaMs: 1 }) });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  await page.waitForSelector('#folhaCorpo .slots .slot', { timeout: 8000 });
  await page.click('#folhaCorpo .slots .slot >> text=08:00');
  await espera(50);
  const antes = mundo.chamadasFuncao.length;
  await page.click('#folhaRodape button');
  await page.waitForFunction(() => document.querySelector('#folha').hidden, null, { timeout: 8000 });
  const i = mundo.chamadas.map((c) => c.nome);
  const ultimoFn = i.lastIndexOf('fn:chat-agenda-ao-vivo'), escolher = i.indexOf('chat_horario_escolher');
  await ctx.close();
  return { ok: mundo.chamadasFuncao.length > antes && !!mundo.escolhido && mundo.escolhido.hora === '08:00' && ultimoFn < escolher, detalhe: JSON.stringify(mundo.escolhido) };
});

await caso('depois da primeira tela, os dias seguintes são conferidos em segundo plano e um horário liberado aparece', async () => {
  const mundo = criarMundo();
  const dia20 = mundo.dia(20);
  mundo.agenda.aoVivo.libera = { [dia20]: ['11:00'] };      // alguém cancelou 11:00 daqui a 20 dias
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  await page.waitForSelector('#folhaCorpo .slots .slot', { timeout: 8000 });
  await page.waitForFunction(() => !/conferindo mais datas/.test(document.querySelector('#folhaCorpo').textContent), null, { timeout: 8000 });
  const faixas = mundo.chamadasFuncao.map((c) => `${c.corpo.de}..${c.corpo.ate}`);
  const nova = (await mundo.tratar('chat_horarios', { p_de: mundo.dia(0), p_ate: mundo.dia(45) })).body.dias.find((d) => d.data === dia20);
  await ctx.close();
  return { ok: faixas.length === 4 && nova && nova.slots.some((s) => s.hora === '11:00') && faixas[1] === `${mundo.dia(14)}..${mundo.dia(27)}`, detalhe: faixas.join(' ; ') };
});

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
  return { ok: /Dra Ana.*Próximo horário: \w{3}, \d{2}\/\d{2} às 08:30/.test(textos['DRA ANA']) && /Dr Pedro.*Sem horário livre nos próximos dias/.test(textos['DR PEDRO'])
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

await caso('o token e a conversa vão no corpo; nenhum dado de paciente é enviado à função', async () => {
  const mundo = criarMundo();
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE() });
  await comecarConversa(page, base);
  await abrirCal(mundo, page);
  await page.waitForSelector('#folhaCorpo .slots .slot', { timeout: 8000 });
  const c = mundo.chamadasFuncao[0].corpo;
  await ctx.close();
  return { ok: Object.keys(c).sort().join(',') === 'ate,conversa,de,token' && c.conversa === mundo.conversa && c.token === mundo.token, detalhe: Object.keys(c).join(',') };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
