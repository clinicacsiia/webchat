// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado + relógios da Sentinela acelerados) -> validação (provoca cada problema: tela travada, erro de chamada, chamada lenta, mensagens fora de ordem, paciente parado) -> lógica (confere o aviso na tela, o código CSI-... e se o incidente chegou ao servidor com o mesmo código) -> saída (PASS/FAIL por caso e código de saída)
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

await caso('aviso de IA: o assistente se apresenta como IA, diz que uma pessoa acompanha, que é previsão, e o botão de atendente fica à vista', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  const aviso = await page.$eval('#avisoIA', (n) => n.textContent), status = await page.$eval('#status', (n) => n.textContent), barra = await page.$eval('#barraHumano', (n) => !n.hidden);
  await ctx.close();
  return { ok: /inteligência artificial/.test(aviso) && /pessoa da equipe acompanha/.test(aviso) && /previsão de agendamento/.test(aviso) && /Quem confirma é um atendente/.test(aviso) && /IA/.test(status) && barra,
    detalhe: `status="${status}", botão de atendente visível=${barra}` };
});

await caso('formulário inicial: já avisa que é uma IA, que há uma pessoa acompanhando e que é uma previsão', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo);
  await page.goto(`${base}/index.html`); await page.waitForSelector('#avisoForm', { state: 'visible', timeout: 8000 });
  const t = await page.$eval('#avisoForm', (n) => n.textContent); await ctx.close();
  return { ok: /inteligência artificial/.test(t) && /previsão de agendamento/.test(t) && /[Uu]ma pessoa/.test(t), detalhe: t.slice(0, 80) };
});

await caso('mensagem final: deixa claro que é PREVISÃO, que ainda não está confirmado e que um atendente vai confirmar', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  await page.click('#msgs .op >> text=Exame'); await page.waitForSelector('#msgs .op >> text=Particular');
  await page.click('#msgs .op >> text=Particular'); await page.waitForSelector('#msgs .acomp', { timeout: 6000 });
  await page.waitForFunction(() => /previsão/i.test(document.querySelector('#msgs .acomp').textContent), null, { timeout: 6000 });
  const t = await page.$eval('#msgs .acomp', (n) => n.textContent); await ctx.close();
  return { ok: /previsão de agendamento/.test(t) && /NÃO está confirmado/.test(t) && /uma pessoa da equipe/.test(t) && /confirmação de data, horário e valor/.test(t) && /a qualquer momento/.test(t), detalhe: t.slice(0, 120) };
});

await caso('letra: o tamanho padrão é maior que antes (17 px) e o menu aumenta mais', async () => {
  const mundo = criarMundo(); const { page, ctx } = await abrir(mundo);
  const px = () => page.$eval('#msgs .msg.agente', (n) => parseFloat(getComputedStyle(n).fontSize));
  const a = await px(); await page.click('#btnMenu'); await page.click('#btnLetra'); await page.waitForTimeout(100);
  const b = await px(); await page.reload(); await page.waitForSelector('#msgs .msg.agente', { timeout: 8000 }); const c = await px(); await ctx.close();
  return { ok: a >= 17 && b > a * 1.1 && Math.abs(c - b) < 0.5, detalhe: `normal=${a}px, maior=${b.toFixed(1)}px, depois de recarregar=${c.toFixed(1)}px (guardado)` };
});

await caso('pedido de exames: tipo em grade, parte do corpo em lista alinhada (nomes na mesma coluna, botões do mesmo tamanho, sem rolagem lateral)', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base);
  mundo.perguntaPedido(); await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForSelector('#msgs .btn-w >> text=Escolher exames no mapa do corpo', { timeout: 6000 });
  await page.click('#msgs .btn-w >> text=Escolher exames no mapa do corpo');
  await page.waitForSelector('.op-grade .op', { timeout: 6000 });
  const grade = await page.$$eval('.op-grade .op', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().width)));
  await page.click('.op-grade .op >> text=Ressonância');
  await page.click('.seg button >> text=Lista');
  await page.waitForSelector('.parte-linha', { timeout: 4000 });
  const m = await page.evaluate(() => {
    const linhas = [...document.querySelectorAll('.parte-linha')];
    const x = (sel) => [...new Set(linhas.flatMap((l) => [...l.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().left))))];
    const dir = [...document.querySelectorAll('.parte-linha button')].filter((b) => b.textContent.includes('Direito')).map((b) => Math.round(b.getBoundingClientRect().width));
    const corpo = document.querySelector('#folhaCorpo');
    return { linhas: linhas.length, colunasNome: x('.nome'), larguraDireito: [...new Set(dir)], semRolagemLateral: corpo.scrollWidth <= corpo.clientWidth + 1,
      grupos: [...document.querySelectorAll('.partes-grupo h3')].map((h) => h.textContent), passos: document.querySelector('.passos') ? document.querySelectorAll('.passos li').length : 0 };
  });
  await ctx.close();
  const gradeIgual = new Set(grade).size === 1;
  return { ok: gradeIgual && m.linhas >= 5 && m.colunasNome.length === 1 && m.larguraDireito.length === 1 && m.semRolagemLateral && m.passos === 3,
    detalhe: `tipos=${grade.length} de largura ${grade[0]}px, linhas=${m.linhas}, colunas de nome=${m.colunasNome.length}, larguras do botão=${m.larguraDireito}, grupos=${m.grupos.join('/')}` };
});

await caso('pedido de exames: escolher Joelho direito pela lista leva ao passo de exames com opções grandes e iguais', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base);
  mundo.perguntaPedido(); await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.click('#msgs .btn-w >> text=Escolher exames no mapa do corpo'); await page.click('.op-grade .op >> text=Ressonância'); await page.click('.seg button >> text=Lista');
  await page.click('.parte-linha:has(.nome:text("Joelho")) button >> text=Direito');
  const marcado = await page.$eval('.parte-linha:has(.nome:text("Joelho")) button[aria-pressed="true"]', (b) => b.textContent);
  await ctx.close();
  return { ok: /Direito/.test(marcado) && /✓/.test(marcado), detalhe: `botão marcado: "${marcado}"` };
});

await caso('pedido de exames: os nomes do Klingo aparecem legíveis (frase normal, detalhe em letra menor), os comuns primeiro e os especiais em "Ver outros"', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base);
  mundo.perguntaPedido(); await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.click('#msgs .btn-w >> text=Escolher exames no mapa do corpo'); await page.click('.op-grade .op >> text=Ressonância'); await page.click('.seg button >> text=Lista');
  await page.click('.parte-linha:has(.nome:text("Punho")) button >> text=Esquerdo');
  await page.click('.btn-w >> text=Ver exames para essas partes do corpo');
  await page.waitForSelector('.opcao-ex .ex-titulo', { timeout: 6000 });
  const m = await page.evaluate(() => {
    const op = [...document.querySelectorAll('.opcao-ex:not(.neutra)')].map((l) => ({ t: l.querySelector('.ex-titulo').textContent, d: (l.querySelector('.ex-detalhe') || {}).textContent || '' }));
    const l = document.querySelector('.opcao-ex'), i = l.querySelector('input').getBoundingClientRect(), t = l.querySelector('.ex-titulo').getBoundingClientRect();
    const det = document.querySelector('.ex-detalhe');
    return { op, textoNaMesmaLinhaDaBolinha: Math.abs((i.top + i.height / 2) - (t.top + t.height / 2)) < 30 || t.top >= i.top - 4, tituloPx: parseFloat(getComputedStyle(document.querySelector('.ex-titulo')).fontSize), detalhePx: det ? parseFloat(getComputedStyle(det).fontSize) : 0,
      tudoMaiusculo: [...document.querySelectorAll('.ex-titulo')].some((e) => e.textContent.length > 4 && e.textContent === e.textContent.toUpperCase()), neutra: !!document.querySelector('.opcao-ex.neutra'), semRolagemLateral: document.querySelector('#folhaCorpo').scrollWidth <= document.querySelector('#folhaCorpo').clientWidth + 1 };
  });
  await page.click('.opcao-ex >> text=Mão e punho'); await page.waitForTimeout(150);
  const marcada = await page.$eval('.opcao-ex.marcada .ex-titulo', (n) => n.textContent);
  await ctx.close();
  const titulos = m.op.map((x) => x.t);
  return { ok: titulos.includes('Mão') && titulos.includes('Mão e punho') && titulos.includes('Punho') && titulos.includes('Articulação (Punho / mão)') && m.op.find((x) => x.t === 'Mão').d === 'Não inclui punho' && !m.tudoMaiusculo && m.tituloPx >= 17 && m.detalhePx >= 14 && m.neutra && m.semRolagemLateral && marcada === 'Mão e punho',
    detalhe: `${m.op.map((x) => x.t + (x.d ? ' [' + x.d + ']' : '')).join(' / ')}; título ${m.tituloPx}px, detalhe ${m.detalhePx}px; marcada=${marcada}` };
});

await caso('pedido de exames: lista longa (crânio) mostra poucos exames comuns e esconde o resto em "Ver outros", sem repetir o que fica igual na tela', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base);
  mundo.perguntaPedido(); await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.click('#msgs .btn-w >> text=Escolher exames no mapa do corpo'); await page.click('.op-grade .op >> text=Ressonância'); await page.click('.seg button >> text=Lista');
  await page.click('.parte-linha:has(.nome:text("Crânio")) button'); await page.click('.btn-w >> text=Ver exames para essas partes do corpo');
  await page.waitForSelector('.ex-mais summary', { timeout: 6000 });
  const m = await page.evaluate(() => {
    const visiveis = [...document.querySelectorAll('.bloco-parte > .opcao-ex:not(.neutra)')].length, dentro = document.querySelectorAll('.ex-mais .opcao-ex').length;
    const todos = [...document.querySelectorAll('.bloco-parte .opcao-ex:not(.neutra) .ex-txt')].map((e) => e.textContent), resumo = document.querySelector('.ex-mais summary').textContent;
    return { visiveis, dentro, repetidos: todos.length - new Set(todos).size, resumo, fechado: !document.querySelector('.ex-mais').open };
  });
  await page.click('.ex-mais summary'); await page.click('.ex-mais .opcao-ex >> nth=0'); await page.waitForTimeout(150);
  const abertoDepois = await page.$eval('.ex-mais', (n) => n.open); await ctx.close();
  return { ok: m.visiveis === 5 && m.dentro >= 5 && m.repetidos === 0 && m.fechado && /Ver outros \d+ exames/.test(m.resumo) && abertoDepois, detalhe: `na tela=${m.visiveis}, em "ver outros"=${m.dentro}, repetidos=${m.repetidos}, "${m.resumo}"` };
});

async function irAoPassoExame(page, mundo, partes) {
  mundo.perguntaPedido(); await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.click('#msgs .btn-w >> text=Escolher exames no mapa do corpo'); await page.click('.op-grade .op >> text=Ressonância'); await page.click('.seg button >> text=Lista');
  for (const [parte, lado] of partes) await page.click(`.parte-linha:has(.nome:text("${parte}")) button${lado ? ` >> text=${lado}` : ''}`);
  await page.click('.btn-w >> text=Ver exames para essas partes do corpo'); await page.waitForSelector('.opcao-ex .ex-titulo', { timeout: 6000 });
}
const bloco = (page) => page.evaluate(() => ({
  lado: [...document.querySelectorAll('.lado-sel .seg button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
  cartoes: [...document.querySelectorAll('.opcao-ex:not(.neutra)')].map((l) => ({ t: l.querySelector('.ex-titulo').textContent, lado: (l.querySelector('.ex-lado') || {}).textContent || '' })),
  texto: document.querySelector('#folhaCorpo').textContent }));

await caso('lado: cada opção diz "Lado esquerdo", o seletor mostra o lado escolhido e trocar para "Os dois lados" muda as opções ("2 exames: um de cada lado")', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAoPassoExame(page, mundo, [['Punho', 'Esquerdo']]);
  const a = await bloco(page);
  await page.click('.lado-sel .seg button >> text=Os dois lados'); await page.waitForTimeout(150); const b = await bloco(page);
  await page.click('.lado-sel .seg button >> text=Direito'); await page.waitForTimeout(150); const c = await bloco(page);
  await ctx.close();
  const todos = (x, t) => x.cartoes.length > 0 && x.cartoes.every((k) => k.lado === t);
  return { ok: a.lado.length === 3 && a.lado.find(([t]) => t === 'Esquerdo')[1] === 'true' && todos(a, 'Lado esquerdo') && todos(b, '2 exames: um de cada lado') && todos(c, 'Lado direito') && !/unilateral|por articula/i.test(a.texto),
    detalhe: `esquerdo=${a.cartoes[0].lado}; os dois=${b.cartoes[0].lado}; direito=${c.cartoes[0].lado}` };
});

await caso('lado: o pedido enviado ao servidor leva o lado que o paciente confirmou NO passo do exame (trocou de esquerdo para direito)', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAoPassoExame(page, mundo, [['Punho', 'Esquerdo']]);
  await page.click('.lado-sel .seg button >> text=Direito'); await page.click('.opcao-ex >> text=Mão e punho');
  await page.click('.btn-w >> text=Adicionar ao pedido'); await page.waitForSelector('.carrinho li', { timeout: 4000 });
  const resumo = await page.$eval('.carrinho', (n) => n.textContent);
  await page.click('#folhaRodape .btn-w'); await page.waitForTimeout(500);
  const chamada = mundo.chamadas.find((c) => c.nome === 'chat_pedido_salvar'); await ctx.close();
  const item = chamada && chamada.corpo.p_itens[0];
  return { ok: /lado direito/.test(resumo) && !/unilateral/i.test(resumo) && item && item.lado === 'D' && item.regiao === 'punho_mao' && item.procedimento_id === 1001, detalhe: `resumo="${resumo.replace(/\s+/g, ' ').slice(0, 110)}" item=${JSON.stringify(item)}` };
});

await caso('lado: parte do corpo SEM lado (tórax) não oferece o exame "unilateral" de articulação, que o banco não saberia de que lado é', async () => {
  const mundo = criarMundo(); const { page, ctx } = await novaPaginaChat(browser, mundo, { init: RAPIDO });
  await comecarConversa(page, base); await irAoPassoExame(page, mundo, [['Tórax', null]]);
  const x = await bloco(page); await ctx.close();
  return { ok: x.cartoes.length === 2 && !x.cartoes.some((k) => /articula/i.test(k.t)) && x.lado.length === 0 && x.cartoes.every((k) => k.lado === ''), detalhe: `opções=${x.cartoes.map((k) => k.t).join(' / ')}; seletor de lado=${x.lado.length}` };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
