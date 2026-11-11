// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado) -> validação (a equipe assume no meio de uma pergunta do assistente; o paciente toca duas vezes; a rede cai numa consulta de rotina) -> lógica (confere o que o paciente vê e o que chega ao servidor) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (auditoria de 11/11/2026)
//
// Por que existe: em 24 h a produção registrou 21 erros "Essa pergunta já foi respondida". O registro de cada um mostra a mesma
// sequência: chega uma mensagem (a equipe assumiu) e, 1 a 20 s depois, o paciente toca num botão da pergunta antiga do assistente,
// que continuava ligado. O servidor só aceita essa resposta enquanto o assistente conduz a conversa.
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const RAPIDO = [[() => { window.SENTINELA_RITMO = 0.05; }, null]];
async function abrir(mundo) {
  const r = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(r.page, base);
  return r;
}
// Faz o chat consultar o servidor agora (o mesmo caminho de quando o paciente volta para a aba).
const consultar = async (page) => { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await espera(350); };
const chamadas = (mundo, nome) => mundo.chamadas.filter((c) => c.nome === nome && !c.queda).length;
const pergunta = (page) => page.evaluate(() => {
  const w = [...document.querySelectorAll('#msgs .msg.agente .widget')].pop();
  const nota = w.querySelector('.w-pausa');
  return { botoes: w.querySelectorAll('.op').length, ligados: w.querySelectorAll('.op:not(:disabled)').length, nota: nota && !nota.hidden ? nota.textContent : '', pausado: w.classList.contains('pausado') };
});
const apoio = (page) => page.$eval('#apoio', (n) => ({ visivel: !n.hidden, texto: n.textContent, nivel: n.className }));
const assume = (mundo) => { mundo.status = 'em_atendimento'; mundo.motor = false; mundo.inserir('sistema', 'Ana entrou na conversa.'); };

await caso('a equipe assume no meio da pergunta: os botões do assistente se desligam, aparece a orientação e o campo de texto', async () => {
  const mundo = criarMundo(); const { page, ctx, erros } = await abrir(mundo);
  const antes = await pergunta(page);
  assume(mundo); await consultar(page);
  const depois = await pergunta(page);
  const campo = await page.$eval('#formEnviar', (f) => !f.hidden);
  await page.evaluate(() => { const b = document.querySelector('#msgs .op'); b.click(); });   // toque num botão desligado
  await espera(250);
  const n = chamadas(mundo, 'chat_responder'); await ctx.close();
  return { ok: antes.ligados === 2 && depois.ligados === 0 && depois.pausado && /pessoa da equipe está com você/.test(depois.nota) && campo && n === 0 && erros.excecoes.length === 0,
    detalhe: `ligados antes=${antes.ligados} depois=${depois.ligados}; nota="${depois.nota.slice(0, 40)}"; chamadas ao assistente=${n}` };
});

await caso('corrida (o paciente toca ANTES de o chat saber que a equipe assumiu): o servidor recusa, a tela se ajusta sozinha e não repete', async () => {
  const mundo = criarMundo(); const { page, ctx, erros } = await abrir(mundo);
  assume(mundo);   // o servidor já mudou; o chat ainda não consultou
  mundo.falhas.chat_responder = { status: 400, corpo: { code: '22023', message: 'Essa pergunta já foi respondida. Veja a última mensagem.' } };
  await page.click('#msgs .op >> text=Exame');
  await page.waitForFunction(() => { const w = [...document.querySelectorAll('#msgs .msg.agente .widget')].pop(); return w && w.classList.contains('pausado'); }, null, { timeout: 5000 });
  const p = await pergunta(page); const toast = await page.$eval('#toast', (n) => n.textContent);
  const bolhas = await page.$$eval('#msgs .msg.cliente', (ns) => ns.length);
  const n1 = chamadas(mundo, 'chat_responder');
  await page.evaluate(() => { document.querySelectorAll('#msgs .op').forEach((b) => b.click()); }); await espera(250);
  const n2 = chamadas(mundo, 'chat_responder'); await ctx.close();
  return { ok: p.ligados === 0 && /Atualizei a conversa/.test(toast) && bolhas === 0 && n1 === 1 && n2 === 1 && erros.excecoes.length === 0,
    detalhe: `toast="${toast}"; bolha solta do paciente=${bolhas}; chamadas=${n2}` };
});

await caso('a equipe devolve a conversa ao assistente: a pergunta volta a funcionar', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  assume(mundo); await consultar(page);
  const pausada = await pergunta(page);
  mundo.status = 'aguardando'; mundo.motor = true; await consultar(page);
  const volta = await pergunta(page);
  await page.click('#msgs .op >> text=Exame');
  await page.waitForFunction(() => /particular ou por convênio/i.test(document.querySelector('#msgs').textContent), null, { timeout: 5000 });
  const n = chamadas(mundo, 'chat_responder'); await ctx.close();
  return { ok: pausada.ligados === 0 && volta.ligados === 2 && !volta.pausado && volta.nota === '' && n === 1, detalhe: `pausada=${pausada.ligados} de volta=${volta.ligados} chamadas=${n}` };
});

await caso('pedido que já está com a equipe (assistente parado, aguardando atendente): a pergunta antiga fica desligada com a explicação certa', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  mundo.motor = false; mundo.inserir('sistema', 'Seu pedido foi enviado.'); await consultar(page);
  const p = await pergunta(page); await ctx.close();
  return { ok: p.ligados === 0 && /já está com a equipe/.test(p.nota), detalhe: p.nota };
});

await caso('"Falar com um atendente" continua funcionando com o assistente ativo (não é barrado pela trava nova)', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  await page.click('#btnHumano');
  await page.waitForFunction(() => /atendente vai continuar/i.test(document.querySelector('#msgs').textContent), null, { timeout: 5000 });
  const c = mundo.chamadas.find((x) => x.nome === 'chat_responder'); await ctx.close();
  return { ok: !!c && c.corpo.p_valor.acao === 'atendente', detalhe: JSON.stringify(c && c.corpo.p_valor) };
});

await caso('formulário: "Continuar" e logo depois "Pular" (ou toque duplo) mandam UMA resposta só', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  mundo.inserir('agente', 'Informe a carteirinha.', { tipo: 'campos', passo: 'dados_carteira', botao: 'Continuar', pular: 'Pular esta parte',
    campos: [{ nome: 'matricula', rotulo: 'Número da carteirinha', tipo: 'texto' }] });
  await consultar(page);
  await page.fill('#msgs .widget[data-tipo="campos"] input', '12345');
  mundo.atraso.chat_responder = 500;
  await page.evaluate(() => {
    const w = document.querySelector('#msgs .widget[data-tipo="campos"]');
    const [continuar, pular] = [w.querySelector('button[type="submit"]'), w.querySelector('.btn-w.sec')];
    continuar.click(); pular.click(); continuar.disabled = false; continuar.click();   // três toques seguidos enquanto a primeira resposta ainda viaja
  });
  await espera(1200);
  const n = chamadas(mundo, 'chat_responder'); const c = mundo.chamadas.find((x) => x.nome === 'chat_responder'); await ctx.close();
  return { ok: n === 1 && c.corpo.p_passo === 'dados_carteira' && c.corpo.p_valor.matricula === '12345', detalhe: `respostas enviadas=${n}` };
});

await caso('rede: UMA falha isolada na consulta de rotina não mostra aviso nem gera código', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  await espera(300); const inc0 = mundo.incidentes.length;
  mundo.quedas = { chat_listar: 1 }; await consultar(page); await consultar(page);
  const a = await apoio(page); await espera(300);
  const novos = mundo.incidentes.length - inc0; await ctx.close();
  return { ok: !a.visivel && novos === 0, detalhe: `aviso na tela=${a.visivel}; incidentes=${novos}` };
});

await caso('rede: TRÊS falhas seguidas avisam "conexão instável" (sem código de erro para o paciente), a equipe recebe 1 registro e o aviso some quando a rede volta', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  await espera(300); const inc0 = mundo.incidentes.length;
  mundo.quedas = { chat_listar: 3 };
  await consultar(page); await consultar(page); await consultar(page);
  await page.waitForFunction(() => /conexão está instável/i.test(document.querySelector('#apoio').textContent), null, { timeout: 5000 });
  const a = await apoio(page); await espera(400);
  const incs = mundo.incidentes.slice(inc0);
  await consultar(page);   // a rede voltou
  const depois = await apoio(page); await ctx.close();
  return { ok: a.nivel.includes('aviso') && !/CSI-/.test(a.texto) && incs.length === 1 && incs[0].p_tipo === 'RPC' && incs[0].p_detalhe.detalhe.seguidas === 3 && !depois.visivel,
    detalhe: `nível=${a.nivel}; registros para a equipe=${incs.length}; depois da volta visível=${depois.visivel}` };
});

await caso('rede: falha numa AÇÃO do paciente (tocar numa opção) continua avisando na hora, com código', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  mundo.quedas = { chat_responder: 1 };
  await page.click('#msgs .op >> text=Exame');
  await page.waitForFunction(() => /CSI-/.test(document.querySelector('#apoio').textContent), null, { timeout: 5000 });
  const a = await apoio(page); const p = await pergunta(page); await ctx.close();
  return { ok: a.nivel.includes('erro') && p.ligados === 2, detalhe: `nível=${a.nivel}; botões religados=${p.ligados}` };
});

await browser.close(); srv.close();
const passou = resultados.filter(Boolean).length;
console.log(`\n${passou} de ${resultados.length} verificações passaram.`);
process.exit(passou === resultados.length ? 0 : 1);
