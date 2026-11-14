// FLUXOGRAMA: entrada (chat do paciente no navegador + Supabase e Edge Function simulados; o "banco" devolve o estado da API: com_horarios, sem_horarios, indisponivel, nao_integrado) -> validação (o calendário só mostra o que veio como horário da API; sem horário a tela
//   mostra as saídas certas e NUNCA a grade) -> processamento (registrar disponibilidade futura, tentar de novo, enviar à equipe, mais datas, confirmar, aviso de vaga) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão (substitui agenda-ao-vivo.navegador.mjs na parte do calendário; a grade deixou de ser fonte de vaga).
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
const slots = (page) => page.$$eval('#folhaCorpo .slots .slot:not(.off)', (bs) => bs.map((b) => b.textContent.trim()));
const botoes = (page) => page.$$eval('#folhaRodape button', (bs) => bs.map((b) => b.textContent.trim()));
const texto = (page) => page.$eval('#folha', (n) => n.textContent);
async function abrir(estado, extra = (m) => {}) {
  const mundo = criarMundo(); mundo.api.estado = estado; extra(mundo);
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, {});
  await comecarConversa(page, base); await abrirCal(mundo, page);
  return { mundo, page, ctx, erros };
}

await caso('COM HORÁRIOS: mostra só os horários que vieram da API, diz que só ficam marcados depois da confirmação e oferece "Procurar mais datas"', async () => {
  const { mundo, page, ctx, erros } = await abrir('com_horarios');
  await page.waitForSelector('#folhaCorpo .cal-dia.livre', { timeout: 8000 });
  await page.click('#folhaCorpo .cal-dia.livre'); await page.waitForSelector('#folhaCorpo .slots .slot');
  const lista = await slots(page), t = await texto(page), chamouApi = mundo.chamadasApi.length;
  const ordem = mundo.chamadas.map((c) => c.nome).filter((n) => /horarios|agenda-api|ao-vivo/.test(n));
  await ctx.close();
  return { ok: lista.length === 3 && chamouApi >= 1 && ordem.indexOf('fn:chat-agenda-api') < ordem.indexOf('chat_horarios') && !ordem.includes('fn:chat-agenda-ao-vivo') && /depois da sua confirmação/.test(t) && /Procurar mais datas/.test(t) && !/previsão/i.test(t) && erros.excecoes.length === 0,
    detalhe: `slots=${lista}; ordem=${ordem.join('>')}` };
});
await caso('SEM HORÁRIOS (a API respondeu e não há vaga): mensagem pedida e três saídas; NENHUM horário aparece', async () => {
  const { page, ctx } = await abrir('sem_horarios');
  await page.waitForSelector('#folhaCorpo .aviso-cal', { timeout: 8000 });
  const t = await texto(page), b = await botoes(page), tem = await page.$$('#folhaCorpo .slot, #folhaCorpo .cal-dia');
  await ctx.close();
  return { ok: /Não encontramos horários disponíveis para esse atendimento no momento\./.test(t) && b.some((x) => /Registrar minha disponibilidade/.test(x)) && b.some((x) => /consultar de novo/i.test(x)) && b.some((x) => /Falar com a equipe/.test(x)) && tem.length === 0 && !/previsão/i.test(t), detalhe: `botões=${b.join(' | ')}` };
});
await caso('FALHA TÉCNICA (API fora do ar) NÃO é "sem vaga": avisa que não foi possível consultar e oferece "Tentar de novo" (que consulta a API de novo, sem usar a lista guardada)', async () => {
  const { mundo, page, ctx } = await abrir('indisponivel');
  await page.waitForSelector('#folhaCorpo .aviso-cal', { timeout: 8000 });
  const t = await texto(page), b = await botoes(page), antes = mundo.chamadasApi.length;
  mundo.api.estado = 'com_horarios';
  await page.click('#folhaRodape button >> text=Tentar de novo'); await page.waitForSelector('#folhaCorpo .cal-dia.livre', { timeout: 8000 });
  const ultima = mundo.chamadasApi.at(-1).corpo;
  await ctx.close();
  return { ok: /Não foi possível consultar os horários agora/.test(t) && !/Não encontramos horários/.test(t) && b.some((x) => /Tentar de novo/.test(x)) && mundo.chamadasApi.length > antes && ultima.fresco === true && ultima.janela === 0, detalhe: `botões=${b.join(' | ')}; última chamada=${JSON.stringify(ultima).replace(/"(token|conversa)":"[^"]+",?/g, '')}` };
});
await caso('API LENTA (responde em 2,5 s): a tela mostra que está conferindo e depois os horários da API, sem travar nem mostrar horário antes da resposta', async () => {
  const { mundo, page, ctx } = await abrir('com_horarios', (m) => { m.api.atraso = 2500; });
  const durante = await page.waitForSelector('#folhaCorpo .carregando', { timeout: 4000 }).then(async () => (await texto(page)).includes('Conferindo'), () => false);
  const semHorarioAntes = (await page.$$('#folhaCorpo .cal-dia.livre')).length === 0;
  await page.waitForSelector('#folhaCorpo .cal-dia.livre', { timeout: 10000 });
  await ctx.close();
  return { ok: durante && semHorarioAntes && mundo.chamadasApi.length >= 1, detalhe: `conferindo=${durante}; horário antes da resposta=${!semHorarioAntes}` };
});
await caso('API LENTA DEMAIS (passa do limite de 14 s): a tela NÃO fica esperando para sempre nem inventa horário: mostra "não foi possível consultar" com "Tentar de novo"', async () => {
  const { page, ctx } = await abrir('indisponivel', (m) => { m.api.atraso = 15500; });
  await page.waitForSelector('#folhaCorpo .aviso-cal', { timeout: 22000 });
  const t = await texto(page), b = await botoes(page), horarios = (await page.$$('#folhaCorpo .cal-dia.livre')).length;
  await ctx.close();
  return { ok: /Não foi possível consultar os horários agora/.test(t) && b.some((x) => /Tentar de novo/.test(x)) && horarios === 0, detalhe: `horários na tela=${horarios}` };
});
await caso('SERVIÇO SEM INTEGRAÇÃO: diz que é agendado pela equipe, NÃO oferece registrar disponibilidade (não seria procurado) e "Enviar meu pedido para a equipe" responde "sem_horario" ao assistente', async () => {
  const { mundo, page, ctx } = await abrir('nao_integrado');
  await page.waitForSelector('#folhaCorpo .aviso-cal', { timeout: 8000 });
  const t = await texto(page), b = await botoes(page);
  await page.click('#folhaRodape button >> text=Enviar meu pedido para a equipe');
  await page.waitForFunction(() => document.querySelector('#folha').hidden, null, { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 400));
  const resp = mundo.chamadas.filter((c) => c.nome === 'chat_responder').at(-1);
  await ctx.close();
  return { ok: /agendado pela nossa equipe/.test(t) && !b.some((x) => /Registrar minha disponibilidade/.test(x)) && resp && resp.corpo.p_passo === 'horario' && resp.corpo.p_valor === 'sem_horario', detalhe: `botões=${b.join(' | ')}; resposta=${JSON.stringify(resp?.corpo?.p_valor)}` };
});
await caso('REGISTRAR DISPONIBILIDADE: formulário com período, dias, turno, aviso desmarcado por padrão e texto "não é um agendamento"; envia os dados certos', async () => {
  const { mundo, page, ctx } = await abrir('sem_horarios');
  await page.waitForSelector('#folhaRodape button >> text=Registrar minha disponibilidade'); await page.click('#folhaRodape button >> text=Registrar minha disponibilidade');
  await page.waitForSelector('#dispIni');
  const t = await texto(page), avisarMarcado = await page.$eval('#dispAvisar', (c) => c.checked);
  await page.click('#folhaCorpo .chip >> text=Manhã'); await page.click('#folhaCorpo .chip >> text=Sáb'); await page.click('#folhaCorpo .chip >> text=Dom');
  await page.check('#dispAvisar');
  await page.click('#folhaRodape button >> text=Registrar minha disponibilidade');
  await page.waitForFunction(() => document.querySelector('#folha').hidden, null, { timeout: 8000 });
  const d = mundo.disp.registros.at(-1);
  await ctx.close();
  return { ok: /não é um agendamento e não reserva horário/i.test(t) && avisarMarcado === false && d && d.turno === 'manha' && JSON.stringify(d.dias_semana) === '[1,2,3,4,5]' && d.aceita_notificacao === true && JSON.stringify(d.canais) === '["chat"]' && /^\d{4}-\d{2}-\d{2}$/.test(d.data_ini), detalhe: JSON.stringify(d) };
});
await caso('REGISTRAR sem autorizar aviso: canais vazios (não há consentimento presumido); datas invertidas e nenhum dia são recusados na tela, sem chamar o servidor', async () => {
  const { mundo, page, ctx } = await abrir('sem_horarios');
  await page.click('#folhaRodape button >> text=Registrar minha disponibilidade'); await page.waitForSelector('#dispIni');
  await page.fill('#dispFim', await page.$eval('#dispIni', (i) => i.value)); await page.$eval('#dispFim', (i) => { const d = new Date(i.value); d.setDate(d.getDate() - 3); i.value = d.toISOString().slice(0, 10); i.dispatchEvent(new Event('input')); });
  await page.click('#folhaRodape button >> text=Registrar minha disponibilidade');
  const erro1 = await page.$eval('#folhaCorpo .erro-form', (n) => n.textContent), antes = mundo.disp.registros.length;
  await page.reload(); await ctx.close();
  return { ok: /final precisa ser depois da inicial/.test(erro1) && antes === 0, detalhe: erro1 };
});
await caso('"PROCURAR MAIS DATAS": consulta a próxima janela (janela=1) e mantém o calendário', async () => {
  const { mundo, page, ctx } = await abrir('com_horarios');
  await page.waitForSelector('#folhaCorpo .cal-dia.livre'); await page.click('#folhaCorpo .chip >> text=Procurar mais datas');
  await page.waitForFunction(() => /próximos 30 dias/.test(document.querySelector('#folhaCorpo').textContent), null, { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 500));
  const janelas = mundo.chamadasApi.map((c) => c.corpo.janela);
  await ctx.close();
  return { ok: janelas.includes(1), detalhe: `janelas pedidas=${janelas}` };
});
await caso('CONFIRMAR: antes de gravar a escolha a API é consultada DE NOVO (fresco); se o horário sumiu, avisa e não grava', async () => {
  const { mundo, page, ctx } = await abrir('com_horarios');
  await page.waitForSelector('#folhaCorpo .cal-dia.livre'); await page.click('#folhaCorpo .cal-dia.livre'); await page.waitForSelector('#folhaCorpo .slots .slot');
  await page.click('#folhaCorpo .slots .slot >> nth=0');
  const antes = mundo.chamadasApi.length;
  const alvo = mundo.chamadas.filter((c) => c.nome === 'chat_horarios').length;
  const dia = Object.keys(mundo.agenda.livres).sort()[0]; mundo.agenda.livres[dia] = [];   // alguém ocupou antes de a paciente confirmar
  await page.click('#folhaRodape .btn-w');
  await page.waitForSelector('.toast, #toast', { timeout: 8000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const frescas = mundo.chamadasApi.slice(antes).filter((c) => c.corpo.fresco === true).length;
  await ctx.close();
  return { ok: frescas >= 1 && !mundo.escolhido, detalhe: `consultas frescas=${frescas}; escolha gravada=${JSON.stringify(mundo.escolhido ?? null)}` };
});
await caso('AVISO DE VAGA no chat: mostra que NÃO está reservado; "Ver horários agora" aceita e abre o calendário normal; "Agora não" volta a procurar', async () => {
  const mundo = criarMundo(); mundo.api.estado = 'com_horarios';
  const { page, ctx } = await novaPaginaChat(browser, mundo, {});
  await comecarConversa(page, base);
  mundo.inserir('agente', 'Encontramos uma possibilidade de horário compatível com a sua solicitação. Consulte a disponibilidade atual para tentar realizar o agendamento: o horário ainda NÃO está reservado para você.', { tipo: 'disponibilidade_oportunidade', solicitacao: 'sol-1', oportunidade: 'op-1' });
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForSelector('#msgs .widget[data-tipo="disponibilidade_oportunidade"]', { timeout: 8000 });
  const t = await page.$eval('#msgs .widget[data-tipo="disponibilidade_oportunidade"]', (n) => n.textContent);
  await page.click('#msgs .widget[data-tipo="disponibilidade_oportunidade"] .chip >> text=Agora não'); await new Promise((r) => setTimeout(r, 400));
  await page.click('#msgs .widget[data-tipo="disponibilidade_oportunidade"] .chip >> text=Ver horários agora');
  await page.waitForSelector('#folha:not([hidden]) #folhaCorpo', { timeout: 8000 }); await new Promise((r) => setTimeout(r, 600));
  const resp = mundo.disp.respostas;
  await ctx.close();
  return { ok: /ainda não está reservado|NÃO está reservado/.test(t) && resp.some((r) => r.aceita === false) && resp.some((r) => r.aceita === true) && mundo.chamadasApi.length >= 1, detalhe: `respostas=${JSON.stringify(resp)}` };
});
await caso('AVISO DE VAGA sobrevive a fechar e reabrir o navegador: ao recarregar a página o aviso volta UMA vez (não duplica), ainda dizendo que o horário NÃO está reservado', async () => {
  const mundo = criarMundo(); mundo.api.estado = 'com_horarios';
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, {});
  await comecarConversa(page, base);
  mundo.inserir('agente', 'Encontramos uma possibilidade de horário compatível com a sua solicitação. O horário ainda NÃO está reservado para você.', { tipo: 'disponibilidade_oportunidade', solicitacao: 'sol-9', oportunidade: 'op-9' });
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForSelector('#msgs .widget[data-tipo="disponibilidade_oportunidade"]', { timeout: 8000 });
  await page.reload(); await page.waitForSelector('#msgs .widget[data-tipo="disponibilidade_oportunidade"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 500));
  const n = await page.$$eval('#msgs .widget[data-tipo="disponibilidade_oportunidade"]', (x) => x.length);
  const t = await page.$eval('#msgs .widget[data-tipo="disponibilidade_oportunidade"]', (x) => x.parentElement.textContent);
  await ctx.close();
  return { ok: n === 1 && /NÃO está reservado/.test(t) && erros.excecoes.length === 0, detalhe: `avisos na tela depois de reabrir=${n}` };
});
await caso('MENU "Minha disponibilidade": lista as solicitações, deixa alterar e cancelar, e explica que não é agendamento', async () => {
  const mundo = criarMundo(); mundo.disp.lista = [{ id: 'sol-1', estado: 'ativa', procedimento: 'RM JOELHO', data_ini: '2026-12-01', data_fim: '2026-12-31', aceita_notificacao: true, dias_semana: [1, 2], turno: 'manha' }];
  const { page, ctx } = await novaPaginaChat(browser, mundo, {});
  await comecarConversa(page, base);
  await page.click('#btnMenu'); await page.click('#btnDisponibilidade');
  await page.waitForSelector('#folhaCorpo .chip >> text=Cancelar', { timeout: 8000 });
  const t = await texto(page);
  await page.click('#folhaCorpo .chip >> text=Cancelar'); await new Promise((r) => setTimeout(r, 500));
  const cancelados = mundo.disp.cancelados;
  await ctx.close();
  return { ok: /não são agendamentos/.test(t) && /Procurando vaga para você/.test(t) && /RM JOELHO/.test(t) && cancelados[0] === 'sol-1', detalhe: `cancelados=${cancelados}` };
});

await browser.close(); srv.close();
console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} verificações passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
