// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado + relógios da Sentinela acelerados) -> validação (provoca cada problema: tela travada, erro de chamada, chamada lenta, mensagens fora de ordem, paciente parado) -> lógica (confere o aviso na tela, o código CSI-... e se o incidente chegou ao servidor com o mesmo código) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.1 — 27/11/2026 / Mudança: os 7 casos do pedido de exames e do lado reescritos para a tela atual (tipo, depois UMA lista por parte do corpo com busca e caixinhas; o botão "Lista" e o passo "Ver exames para essas partes" não existem mais).
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
//
// Os relógios da Sentinela andam 20× mais rápido (window.SENTINELA_RITMO = 0.05); os atrasos do servidor simulado são reais.
// Também confere o que o paciente vê na Fase 9: aviso de IA, previsão de agendamento, letra maior e a lista do corpo alinhada.
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const CODIGO = /CSI-\d{6}-\d{4}-[A-Z]{3}-[A-Z0-9]{4}/;

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const RAPIDO = [[() => { window.SENTINELA_RITMO = 0.05; }, null]];
async function abrir(mundo, extras = {}) {
  const r = await novaPaginaChat(browser, mundo, { init: RAPIDO, ...extras });
  await comecarConversa(r.page, base);
  return r;
}
const apoio = (page) => page.$eval('#apoio', (n) => ({ visivel: !n.hidden, texto: n.textContent, nivel: n.className }));
const incidente = (mundo, tipo) => mundo.incidentes.find((i) => i.p_tipo === tipo);

await caso('tela travada: botões todos desligados sem chamada em andamento são religados e o caso vira incidente curado com código', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  await page.evaluate(() => { const m = [...document.querySelectorAll('#msgs .msg.agente')].pop(); m.querySelectorAll('button,input').forEach((b) => { b.disabled = true; }); });
  await page.waitForFunction(() => [...document.querySelectorAll('#msgs .msg.agente')].pop().querySelectorAll('.op:not(:disabled)').length > 0, null, { timeout: 5000 });
  await page.waitForFunction(() => true); await espera(900);
  const inc = incidente(mundo, 'TRV'); await ctx.close();
  return { ok: !!inc && /-TRV-/.test(inc.p_codigo) && inc.p_detalhe.detalhe.curado === true && CODIGO.test(inc.p_codigo), detalhe: inc ? `${inc.p_codigo} curado=${inc.p_detalhe.detalhe.curado}` : 'nenhum incidente TRV chegou ao servidor' };
});

await caso('erro do servidor (500): mostra aviso empático com o código, e o MESMO código chega ao Supabase', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  mundo.falhas.chat_responder = { status: 500, corpo: { code: 'XX000', message: 'falha simulada' }, vezes: 1 };
  await page.click('#msgs .op >> text=Exame');
  await page.waitForFunction(() => /CSI-/.test(document.querySelector('#apoio').textContent), null, { timeout: 5000 });
  const a = await apoio(page); await espera(300);
  const codigo = (CODIGO.exec(a.texto) || [])[0], inc = mundo.incidentes.find((i) => i.p_codigo === codigo); await ctx.close();
  return { ok: !!codigo && /-RPC-/.test(codigo) && !!inc && a.nivel.includes('erro') && /desculpas/i.test(a.texto) && inc.p_detalhe.detalhe.chamada === 'chat_responder' && inc.p_detalhe.detalhe.status === 500,
    detalhe: `código na tela=${codigo}, no servidor=${inc ? inc.p_codigo : 'não chegou'}` };
});

await caso('pergunta já respondida (22023): atualiza a conversa sozinha, avisa com calma e registra DES', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  mundo.falhas.chat_responder = { status: 400, corpo: { code: '22023', message: 'Essa pergunta já foi respondida. Veja a última mensagem.' }, vezes: 1 };
  const antes = mundo.chamadas.filter((c) => c.nome === 'chat_listar').length;
  await page.click('#msgs .op >> text=Exame');
  await page.waitForFunction(() => /Atualizei a conversa/.test(document.querySelector('#apoio').textContent), null, { timeout: 5000 });
  await espera(400);
  const depois = mundo.chamadas.filter((c) => c.nome === 'chat_listar').length; const inc = incidente(mundo, 'DES'); await ctx.close();
  return { ok: depois > antes && !!inc, detalhe: `consultas antes=${antes}, depois=${depois}, incidente DES=${inc ? inc.p_codigo : 'não'}` };
});

await caso('chamada lenta: avisa que está conferindo e, se passar do dobro, oferece atendente com código', async () => {
  const mundo = criarMundo(); mundo.atraso.chat_responder = 2500; const { page, ctx } = await abrir(mundo);
  await page.click('#msgs .op >> text=Exame');
  await page.waitForFunction(() => /demorando/.test(document.querySelector('#apoio').textContent), null, { timeout: 5000 });
  await page.waitForFunction(() => /CSI-\d{6}-\d{4}-LNT-/.test(document.querySelector('#apoio').textContent), null, { timeout: 5000 });
  const a = await apoio(page); await ctx.close();
  return { ok: /Chamar um atendente/.test(a.texto) && /desculpas/i.test(a.texto), detalhe: a.texto.slice(0, 90) };
});

await caso('mensagens fora de ordem na tela: a Sentinela reordena e registra ORD curado', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  await page.click('#msgs .op >> text=Exame');
  await page.waitForSelector('#msgs .msg.agente >> text=particular ou por convênio');
  await espera(300);
  await page.evaluate(() => { const ms = [...document.querySelectorAll('#msgs .msg[data-id]')]; ms[0].parentNode.appendChild(ms[0]); });   // põe a primeira no fim
  await page.waitForFunction(() => { const ids = [...document.querySelectorAll('#msgs .msg[data-id]')].map((n) => +n.dataset.id); return ids.every((x, i) => i === 0 || x > ids[i - 1]); }, null, { timeout: 5000 });
  await espera(700);
  const inc = incidente(mundo, 'ORD'); await ctx.close();
  return { ok: !!inc && inc.p_detalhe.detalhe.curado === true, detalhe: inc ? `${inc.p_codigo}` : 'sem incidente ORD' };
});

await caso('paciente parado na mesma pergunta: oferece ajuda com dica e o botão chama o atendente', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  await page.waitForFunction(() => /Posso ajudar/.test(document.querySelector('#apoio').textContent), null, { timeout: 12000 });
  const a = await apoio(page);
  await page.click('#apoio .ap-btn >> text=Chamar um atendente');
  await page.waitForFunction(() => document.querySelector('#msgs').textContent.includes('Um atendente vai continuar'), null, { timeout: 5000 });
  const chamou = mundo.chamadas.some((c) => c.nome === 'chat_responder' && c.corpo.p_valor && c.corpo.p_valor.acao === 'atendente'); await ctx.close();
  return { ok: chamou && /atendente/.test(a.texto), detalhe: a.texto.slice(0, 100) };
});

await caso('menu "Código de suporte": mostra um código válido e ele chega ao servidor', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  await page.click('#btnMenu'); await page.click('#btnSuporte');
  await page.waitForFunction(() => /CSI-/.test(document.querySelector('#apoio').textContent), null, { timeout: 5000 });
  await espera(400);
  const a = await apoio(page), codigo = (CODIGO.exec(a.texto) || [])[0], inc = mundo.incidentes.find((i) => i.p_codigo === codigo); await ctx.close();
  return { ok: !!codigo && !!inc && inc.p_tipo === 'DIA', detalhe: `código=${codigo}` };
});

await caso('privacidade: o incidente enviado não leva o texto das mensagens nem os dados do formulário', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  mundo.falhas.chat_responder = { status: 500, corpo: { code: 'XX000', message: 'falha simulada' }, vezes: 1 };
  await page.click('#msgs .op >> text=Exame');
  await page.waitForFunction(() => /CSI-/.test(document.querySelector('#apoio').textContent), null, { timeout: 5000 }); await espera(300);
  const bruto = JSON.stringify(mundo.incidentes.map((i) => i.p_detalhe)); await ctx.close();   // p_detalhe é o que o servidor grava; p_token é só a chave da chamada
  const vazou = ['Maria da Silva', '71999998888', 'maria@teste.local', mundo.token].filter((x) => bruto.includes(x));
  return { ok: mundo.incidentes.length > 0 && vazou.length === 0, detalhe: vazou.length ? `vazou: ${vazou.join(', ')}` : `${bruto.length} caracteres, sem dados pessoais nem token` };
});

await caso('aviso de IA: o assistente se apresenta (curto, sem repetir a missão), que a marcação é automática e o atendente só entra se houver problema, e o botão de atendente fica à vista', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  const aviso = await page.$eval('#avisoIA', (n) => n.textContent), status = await page.$eval('#status', (n) => n.textContent), barra = await page.$eval('#barraHumano', (n) => !n.hidden);
  await ctx.close();
  return { ok: /assistente autom[aá]tico/.test(aviso) && aviso.length < 140 && !/previsão/i.test(aviso) && /marco o seu agendamento/.test(aviso) && /só entra se houver algum problema/.test(aviso) && /autom[aá]tico/.test(status) && barra,
    detalhe: `status="${status}", botão de atendente visível=${barra}` };
});

await caso('formulário inicial: fala da missão (família), avisa que uma pessoa confirma, e exige o "estou ciente" (a menção à IA saiu da tela inicial de propósito)', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo);
  await page.goto(`${base}/index.html`); await page.waitForSelector('#avisoForm', { state: 'visible', timeout: 8000 });
  const t = await page.$eval('#avisoForm', (n) => n.textContent);
  const caixa = (await page.$('#avisoForm #fPrevisao')) !== null;
  await page.click('#fQuem .unidade >> nth=0'); await page.fill('#fNome', 'Ana Souza'); await page.fill('#fTel', '71999998888'); await page.fill('#fEmail', 'a@b.co'); await page.check('#fAceite');
  await page.click('#btnIniciar'); await page.waitForTimeout(300);
  const erro = (await page.locator('#erroForm').innerText()).trim(); const iniciou = mundo.chamadas.some((c) => c.nome === 'chat_iniciar'); await ctx.close();
  return { ok: /família/.test(t) && !/previsão/i.test(t) && /pessoa da equipe/.test(t) && caixa && /ciente/.test(erro) && !iniciou, detalhe: `${t.slice(0, 60)} | erro="${erro}"` };
});

await caso('saúde do Klingo no topo da tela inicial: verde "Online" com a API no ar, laranja "Online" só com relatórios, vermelho "Offline" fora do ar', async () => {
  const saida = {};
  for (const estado of ['verde', 'laranja', 'vermelho']) {
    const mundo = criarMundo(); mundo.saude = estado; const { page, ctx } = await novaPaginaChat(browser, mundo);
    await page.goto(`${base}/index.html`); await page.waitForSelector('#avisoForm', { state: 'visible', timeout: 8000 });
    await page.waitForFunction((e) => document.querySelector('#ponto').classList.contains(e), estado, { timeout: 6000 });
    saida[estado] = { txt: (await page.$eval('#status', (n) => n.textContent)).trim(), cor: await page.$eval('#ponto', (n) => getComputedStyle(n).backgroundColor) };
    await ctx.close();
  }
  const ok = saida.verde.txt === 'Online' && saida.laranja.txt === 'Online' && saida.vermelho.txt === 'Offline'
    && saida.verde.cor === 'rgb(34, 197, 94)' && saida.laranja.cor === 'rgb(245, 158, 11)' && saida.vermelho.cor === 'rgb(239, 68, 68)';
  return { ok, detalhe: JSON.stringify(saida) };
});

await caso('mensagem final: deixa claro que ainda não está confirmado (sem a palavra previsão) e que um atendente vai confirmar', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  await page.click('#msgs .op >> text=Exame'); await page.waitForSelector('#msgs .op >> text=Particular');
  await page.click('#msgs .op >> text=Particular'); await page.waitForSelector('#msgs .acomp', { timeout: 6000 });
  await page.waitForFunction(() => /ainda NÃO está confirmado/.test(document.querySelector('#msgs .acomp').textContent), null, { timeout: 6000 });
  const t = await page.$eval('#msgs .acomp', (n) => n.textContent); await ctx.close();
  return { ok: !/previsão/i.test(t) && /NÃO está confirmado/.test(t) && /uma pessoa da equipe/.test(t) && /confirmação de data, horário e valor/.test(t) && /a qualquer momento/.test(t), detalhe: t.slice(0, 120) };
});

await caso('letra: o tamanho padrão é maior que antes (17 px) e o menu aumenta mais', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  const px = () => page.$eval('#msgs .msg.agente', (n) => parseFloat(getComputedStyle(n).fontSize));
  const a = await px(); await page.click('#btnMenu'); await page.click('#btnLetra'); await page.waitForTimeout(100);
  const b = await px(); await page.reload(); await page.waitForSelector('#msgs .msg.agente', { timeout: 8000 }); const c = await px(); await ctx.close();
  return { ok: a >= 17 && b > a * 1.1 && Math.abs(c - b) < 0.5, detalhe: `normal=${a}px, maior=${b.toFixed(1)}px, depois de recarregar=${c.toFixed(1)}px (guardado)` };
});

// ---- Pedido de exames (tela de 16/11/2026): passo 1 = tipo em botões iguais; passo 2 = UMA lista agrupada por parte do corpo, com busca, caixinhas e o seletor de lado dentro do exame marcado.
async function irAoPedido(page, mundo) {
  mundo.perguntaPedido(); await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.click('#msgs .btn-w >> text=Escolher exames no mapa do corpo'); await page.waitForSelector('.op-grade .op', { timeout: 6000 });
}
async function irAosExames(page, mundo) {
  await irAoPedido(page, mundo);
  await page.click('.op-grade .op >> text=Ressonância'); await page.waitForSelector('.grupo-ex', { timeout: 6000 });
}
const abrirGrupo = async (page, nome) => { if (!(await page.$eval(`.grupo-ex:has(.nome:text("${nome}"))`, (d) => d.open))) await page.click(`.grupo-ex:has(.nome:text("${nome}")) summary`); };
const marcar = (page, titulo) => page.click(`.opcao-ex:has(.ex-titulo:text-is("${titulo}")) input`);
const lado = (page) => page.evaluate(() => ({
  botoes: [...document.querySelectorAll('.lado-sel .seg button')].map((b) => [b.textContent, b.getAttribute('aria-pressed'), Math.round(b.getBoundingClientRect().width)]),
  pergunta: (document.querySelector('.lado-q') || {}).textContent || '', nota: (document.querySelector('.lado-sel .w-nota') || {}).textContent || '',
  carrinho: (document.querySelector('.carrinho') || {}).textContent || '' }));

await caso('pedido de exames: tipo em botões iguais e, no passo 2, a lista por parte do corpo alinhada (nomes na mesma coluna, sem rolagem lateral, 2 passos)', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAoPedido(page, mundo);
  const grade = await page.$$eval('.op-grade .op', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().width)));
  await page.click('.op-grade .op >> text=Ressonância'); await page.waitForSelector('.grupo-ex', { timeout: 6000 });
  const m = await page.evaluate(() => {
    const grupos = [...document.querySelectorAll('.grupo-ex')], corpo = document.querySelector('#folhaCorpo');
    return { grupos: grupos.map((g) => g.querySelector('.nome').textContent), colunasNome: [...new Set(grupos.map((g) => Math.round(g.querySelector('.nome').getBoundingClientRect().left)))],
      semRolagemLateral: corpo.scrollWidth <= corpo.clientWidth + 1, passos: document.querySelectorAll('.passos li').length, busca: !!document.querySelector('.busca-ex') };
  });
  await ctx.close();
  return { ok: new Set(grade).size === 1 && grade.length === 3 && m.grupos.length === 3 && m.colunasNome.length === 1 && m.semRolagemLateral && m.passos === 2 && m.busca,
    detalhe: `tipos=${grade.length} de largura ${grade[0]}px, grupos=${m.grupos.join('/')}, colunas de nome=${m.colunasNome.length}, passos=${m.passos}` };
});

await caso('pedido de exames: a busca filtra ao digitar (por exame ou parte do corpo) e marcar um exame de parte com lado abre as 3 opções de lado, grandes e iguais', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAosExames(page, mundo);
  await page.fill('.busca-ex', 'punho'); await page.waitForFunction(() => document.querySelectorAll('.grupo-ex').length === 1);
  const so = await page.$eval('.grupo-ex .nome', (n) => n.textContent);
  await marcar(page, 'Mão e punho'); const a = await lado(page);
  await page.click('.lado-sel .seg button >> text=Direito'); const b = await lado(page);
  await page.fill('.busca-ex', 'zzz'); await page.waitForFunction(() => !document.querySelector('.grupo-ex'));
  const vazio = await page.$eval('.p-dica', (n) => n.textContent);
  await ctx.close();
  return { ok: /Punho/.test(so) && a.botoes.length === 3 && new Set(a.botoes.map((x) => x[2])).size === 1 && a.botoes.every((x) => x[1] === 'false') && /Qual lado/.test(a.pergunta)
      && b.botoes.find((x) => x[0] === 'Direito')[1] === 'true' && /Nenhum exame com esse nome/.test(vazio), detalhe: `grupo=${so}; lados=${a.botoes.map((x) => x[0] + ' ' + x[2] + 'px').join(', ')}` };
});

await caso('pedido de exames: os nomes do Klingo aparecem legíveis (frase normal, detalhe em letra menor), sem caixa alta, e sem repetir o mesmo exame na tela', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAosExames(page, mundo); await abrirGrupo(page, 'Punho / mão');
  const m = await page.evaluate(() => {
    const ops = [...document.querySelectorAll('.grupo-ex:has(.nome) .opcao-ex')].filter((l) => l.closest('.grupo-ex').querySelector('.nome').textContent.includes('Punho'))
      .map((l) => ({ t: l.querySelector('.ex-titulo').textContent, d: (l.querySelector('.ex-detalhe') || {}).textContent || '' }));
    const t = document.querySelector('.ex-titulo'), d = document.querySelector('.ex-detalhe');
    return { ops, tituloPx: parseFloat(getComputedStyle(t).fontSize), detalhePx: d ? parseFloat(getComputedStyle(d).fontSize) : 0,
      tudoMaiusculo: [...document.querySelectorAll('.ex-titulo')].some((e) => e.textContent.length > 4 && e.textContent === e.textContent.toUpperCase()),
      repetidos: ops.length - new Set(ops.map((o) => o.t + '|' + o.d)).size, semRolagemLateral: document.querySelector('#folhaCorpo').scrollWidth <= document.querySelector('#folhaCorpo').clientWidth + 1 };
  });
  await ctx.close();
  const titulos = m.ops.map((x) => x.t);
  return { ok: ['Mão', 'Mão e punho', 'Punho', 'Articulação (Punho / mão)'].every((x) => titulos.includes(x)) && m.ops.find((x) => x.t === 'Mão').d === 'Não inclui punho' && !m.tudoMaiusculo && m.tituloPx > m.detalhePx && m.detalhePx >= 12 && m.repetidos === 0 && m.semRolagemLateral,
    detalhe: `${m.ops.map((x) => x.t + (x.d ? ' [' + x.d + ']' : '')).join(' / ')}; título ${m.tituloPx}px, detalhe ${m.detalhePx}px` };
});

await caso('pedido de exames: parte do corpo com lista longa (crânio) fica fechada com a contagem e abre ao tocar; marcar um exame mostra "1 marcado" e o botão de enviar', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAosExames(page, mundo);
  const antes = await page.$eval('.grupo-ex:has(.nome:text("Crânio"))', (d) => ({ aberto: d.open, cont: d.querySelector('.cont').textContent }));
  await abrirGrupo(page, 'Crânio');
  const n = await page.$$eval('.grupo-ex:has(.nome:text("Crânio")) .opcao-ex', (l) => l.length);
  await page.click('.grupo-ex:has(.nome:text("Crânio")) .opcao-ex >> nth=0 >> input');
  const marcado = await page.$eval('.grupo-ex:has(.nome:text("Crânio")) .cont', (c) => c.textContent);
  const botao = await page.$eval('#folhaRodape .btn-w', (b) => ({ txt: b.textContent, off: b.disabled }));
  await ctx.close();
  return { ok: antes.aberto === false && antes.cont === '13' && n === 13 && marcado === '1 marcado' && /Enviar pedido \(1 exame\)/.test(botao.txt) && botao.off === false, detalhe: `fechado com "${antes.cont}", ${n} exames ao abrir, depois "${marcado}", botão "${botao.txt}"` };
});

await caso('lado: marcar o exame pede o lado (Direito, Esquerdo, Os dois lados), o botão escolhido fica marcado e "Os dois lados" avisa "2 exames: um de cada lado"', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAosExames(page, mundo); await abrirGrupo(page, 'Punho / mão'); await marcar(page, 'Mão e punho');
  const a = await lado(page);
  await page.click('.lado-sel .seg button >> text=Os dois lados'); const b = await lado(page);
  await page.click('.lado-sel .seg button >> text=Esquerdo'); const c = await lado(page);
  await ctx.close();
  const marcadoEm = (x) => x.botoes.filter((k) => k[1] === 'true').map((k) => k[0]).join();
  return { ok: a.botoes.length === 3 && marcadoEm(a) === '' && /Qual lado/.test(a.pergunta) && marcadoEm(b) === 'Os dois lados' && /2 exames: um de cada lado/.test(b.nota) && marcadoEm(c) === 'Esquerdo' && c.nota === '' && /lado esquerdo/.test(c.carrinho),
    detalhe: `sem escolha=[${marcadoEm(a)}]; depois=${marcadoEm(b)}; depois=${marcadoEm(c)}; carrinho="${c.carrinho.replace(/\s+/g, ' ').slice(0, 90)}"` };
});

await caso('lado: o pedido enviado ao servidor leva o lado que o paciente confirmou NO passo do exame (trocou de esquerdo para direito)', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAosExames(page, mundo); await abrirGrupo(page, 'Punho / mão'); await marcar(page, 'Mão e punho');
  await page.click('.lado-sel .seg button >> text=Esquerdo'); await page.click('.lado-sel .seg button >> text=Direito');
  const resumo = await page.$eval('.carrinho', (n) => n.textContent);
  await page.click('#folhaRodape .btn-w'); await page.waitForTimeout(500);
  const chamada = mundo.chamadas.find((c) => c.nome === 'chat_pedido_enviar'); await ctx.close();
  const item = chamada && chamada.corpo.p_itens[0];
  return { ok: /lado direito/.test(resumo) && !/unilateral/i.test(resumo) && chamada.corpo.p_itens.length === 1 && item && item.lado === 'D' && item.regiao === 'punho_mao' && item.modalidade === 'RM' && typeof item.procedimento_id === 'number', detalhe: `resumo="${resumo.replace(/\s+/g, ' ').slice(0, 100)}" item=${JSON.stringify(item)}` };
});

await caso('lado: parte do corpo SEM lado (tórax) não oferece o exame "unilateral" de articulação, que o banco não saberia de que lado é, e não pergunta lado', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAosExames(page, mundo); await abrirGrupo(page, 'Tórax');
  const titulos = await page.$$eval('.grupo-ex:has(.nome:text("Tórax")) .ex-titulo', (l) => l.map((x) => x.textContent));
  await marcar(page, titulos[0]); const x = await lado(page);
  await page.click('#folhaRodape .btn-w'); await page.waitForTimeout(500);
  const item = (mundo.chamadas.find((c) => c.nome === 'chat_pedido_enviar') || { corpo: { p_itens: [{}] } }).corpo.p_itens[0]; await ctx.close();
  return { ok: titulos.length === 2 && !titulos.some((t) => /articula/i.test(t)) && x.botoes.length === 0 && item.lado === 'N' && item.regiao === 'torax', detalhe: `opções=${titulos.join(' / ')}; seletor de lado=${x.botoes.length}; lado enviado=${item.lado}` };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
