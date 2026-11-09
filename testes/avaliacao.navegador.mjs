// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado; despedida com opcoes.encerrada_em e a resposta de chat_avaliacao_estado) -> validação (o botão só aparece quando o servidor manda mostrar; formulário voluntário, com teclado e sem cortes em tela pequena) -> lógica (ignorar, enviar 0 e 10, falha e nova tentativa, clique duplo; nada disso altera a conversa encerrada) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-10)
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const TESTE = [[() => { window.__WEBCHAT_TESTE__ = {}; }, null]];
const ENC = '2026-11-09T10:00:00+00:00';

function mundoAvaliacao({ mostrar = true, estadoErro = false, falhasEnvio = 0, atrasoEnvio = 0 } = {}) {
  const mundo = criarMundo(); const tratar = mundo.tratar; mundo.envios = []; let falhas = falhasEnvio;
  mundo.tratar = async (nome, corpo, cab) => {
    if (nome === 'chat_avaliacao_estado') { mundo.chamadas.push({ nome, corpo }); return estadoErro ? { status: 400, body: { code: 'XX000', message: 'falha' } } : { body: { mostrar } }; }
    if (nome === 'chat_avaliar') {
      mundo.envios.push(corpo); mundo.chamadas.push({ nome, corpo });
      if (atrasoEnvio) await espera(atrasoEnvio);
      if (falhas > 0) { falhas--; return { status: 400, body: { code: 'XX000', message: 'falha simulada' } }; }
      return { body: { ok: true, nova: true } };
    }
    return tratar(nome, corpo, cab);
  };
  return mundo;
}
async function abrirComDespedida(mundo, texto = 'Atendimento encerrado. Se precisar, é só mandar uma nova mensagem.') {
  const t = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page_base(t), base);
  const m = mundo.inserir('sistema', texto, { tipo: 'despedida', versao: null, imagem: false, encerrada_em: ENC });
  await t.page.evaluate((x) => window.__WEBCHAT_TESTE__.adicionar(x, false), { id: m.id, autor: 'sistema', texto: m.texto, opcoes: m.opcoes, criado_em: m.criado_em });
  await espera(500);
  return t;
}
const page_base = (t) => t.page;
const nota = (page, grupo, n) => page.locator(`label.aval-nota:has(input[name="${grupo}"][value="${n}"])`).click();
const canal = (page, c) => page.locator(`label.aval-canal:has(input[value="${c}"])`).click();
const msgsTotal = (mundo) => mundo.msgs.length;

await caso('o botão Avaliar aparece abaixo da despedida e o formulário só abre ao tocar', async () => {
  const mundo = mundoAvaliacao(); const { page, ctx, erros } = await abrirComDespedida(mundo);
  const dados = await page.evaluate(() => { const n = [...document.querySelectorAll('#msgs .msg.sistema')].pop(); const b = n.querySelector('.aval button'); const texto = n.querySelector('span:not(.hora)');
    return { botao: b && b.textContent, depois: !!(texto && b && (texto.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)), form: !!n.querySelector('form') }; });
  const ch = mundo.chamadas.find((c) => c.nome === 'chat_avaliacao_estado');
  await ctx.close();
  return { ok: dados.botao === 'Avaliar o atendimento' && dados.depois && !dados.form && ch.corpo.p_encerrada_em === ENC && !erros.excecoes.length, detalhe: JSON.stringify(dados) };
});

await caso('o servidor diz para não mostrar (chave desligada, já avaliou, Não respondido) ou falha: nenhum botão e nenhum erro', async () => {
  const a = mundoAvaliacao({ mostrar: false }), b = mundoAvaliacao({ estadoErro: true });
  const ta = await abrirComDespedida(a), tb = await abrirComDespedida(b);
  const n = async (t) => t.page.locator('.aval').count();
  const r = [await n(ta), await n(tb)]; const e = [...ta.erros.excecoes, ...tb.erros.excecoes];
  await ta.ctx.close(); await tb.ctx.close();
  return { ok: r.join() === '0,0' && !e.length, detalhe: r.join() };
});

await caso('ignorar: "Agora não" fecha o formulário, volta o botão e não envia nem altera nada', async () => {
  const mundo = mundoAvaliacao(); const { page, ctx } = await abrirComDespedida(mundo);
  const antes = msgsTotal(mundo);
  await page.click('.aval button:has-text("Avaliar o atendimento")'); await page.waitForSelector('.aval-form');
  await page.click('.aval-form button:has-text("Agora não")'); await page.waitForTimeout(200);
  const voltou = await page.locator('.aval button:has-text("Avaliar o atendimento")').isVisible();
  const foco = await page.evaluate(() => document.activeElement.textContent);
  await ctx.close();
  return { ok: voltou && mundo.envios.length === 0 && msgsTotal(mundo) === antes && foco === 'Avaliar o atendimento' };
});

await caso('enviar com 0 e 10 e o canal: manda os três valores, agradece e o botão não volta', async () => {
  const mundo = mundoAvaliacao(); const { page, ctx } = await abrirComDespedida(mundo);
  await page.click('.aval button:has-text("Avaliar o atendimento")'); await page.waitForSelector('.aval-form');
  await nota(page, 'atendimento', 0); await nota(page, 'site', 10); await canal(page, 'Instagram');
  await page.click('.aval-form button[type=submit]'); await page.waitForSelector('.aval p:has-text("Obrigado")');
  const botoes = await page.locator('.aval button').count();
  await ctx.close();
  const e = mundo.envios[0];
  return { ok: mundo.envios.length === 1 && e.p_nota_atendimento === 0 && e.p_nota_site === 10 && e.p_canal === 'Instagram' && e.p_token === 'token-de-teste' && botoes === 0, detalhe: JSON.stringify(e) };
});

await caso('faltando resposta: avisa e não chama o servidor', async () => {
  const mundo = mundoAvaliacao(); const { page, ctx } = await abrirComDespedida(mundo);
  await page.click('.aval button:has-text("Avaliar o atendimento")'); await page.waitForSelector('.aval-form');
  await nota(page, 'atendimento', 7);
  await page.click('.aval-form button[type=submit]'); await page.waitForTimeout(200);
  const msg = await page.locator('.aval-form [role=status]').innerText();
  await ctx.close();
  return { ok: /Escolha uma nota/.test(msg) && mundo.envios.length === 0 };
});

await caso('falha de rede: as respostas continuam marcadas e a segunda tentativa funciona', async () => {
  const mundo = mundoAvaliacao({ falhasEnvio: 1 }); const { page, ctx } = await abrirComDespedida(mundo);
  await page.click('.aval button:has-text("Avaliar o atendimento")'); await page.waitForSelector('.aval-form');
  await nota(page, 'atendimento', 10); await nota(page, 'site', 0); await canal(page, 'Google');
  await page.click('.aval-form button[type=submit]'); await page.waitForTimeout(400);
  const msg = await page.locator('.aval-form [role=status]').innerText();
  const marcado = await page.evaluate(() => [...document.querySelectorAll('.aval-form input:checked')].map((i) => i.name + '=' + i.value).join(','));
  const habilitado = await page.locator('.aval-form button[type=submit]').isEnabled();
  await page.click('.aval-form button[type=submit]'); await page.waitForSelector('.aval p:has-text("Obrigado")');
  await ctx.close();
  return { ok: /Não foi possível enviar/.test(msg) && marcado === 'atendimento=10,site=0,canal=Google' && habilitado && mundo.envios.length === 2, detalhe: marcado };
});

await caso('clique duplo em Enviar: só uma avaliação sai', async () => {
  const mundo = mundoAvaliacao({ atrasoEnvio: 500 }); const { page, ctx } = await abrirComDespedida(mundo);
  await page.click('.aval button:has-text("Avaliar o atendimento")'); await page.waitForSelector('.aval-form');
  await nota(page, 'atendimento', 8); await nota(page, 'site', 8); await canal(page, 'WhatsApp');
  await page.dblclick('.aval-form button[type=submit]'); await page.waitForSelector('.aval p:has-text("Obrigado")');
  await ctx.close();
  return { ok: mundo.envios.length === 1 };
});

await caso('teclado: Enter abre o formulário, o foco vai para a primeira nota e as setas escolhem', async () => {
  const mundo = mundoAvaliacao(); const { page, ctx } = await abrirComDespedida(mundo);
  await page.focus('.aval button'); await page.keyboard.press('Enter'); await page.waitForSelector('.aval-form');
  const foco = await page.evaluate(() => document.activeElement.name);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  const marcado = await page.evaluate(() => document.activeElement.value + '|' + document.activeElement.checked);
  await ctx.close();
  return { ok: foco === 'atendimento' && marcado === '2|true', detalhe: `${foco} ${marcado}` };
});

await caso('celular pequeno com letra grande: nada sai da tela e todos os controles ficam alcançáveis', async () => {
  const mundo = mundoAvaliacao(); const { page, ctx } = await abrirComDespedida(mundo);
  await page.evaluate(() => document.documentElement.style.setProperty('--esc', '1.4'));
  await page.click('.aval button:has-text("Avaliar o atendimento")'); await page.waitForSelector('.aval-form');
  const m = await page.evaluate(() => { const box = document.getElementById('msgs'); const f = document.querySelector('.aval-form');
    const r = f.getBoundingClientRect(); const menor = Math.min(...[...f.querySelectorAll('.aval-nota span, .aval-canal span')].map((s) => s.getBoundingClientRect().height));
    return { rolagemLateral: box.scrollWidth > box.clientWidth + 1, formLargura: Math.round(r.width), janela: window.innerWidth, menor: Math.round(menor) }; });
  await page.locator('.aval-form button[type=submit]').scrollIntoViewIfNeeded();
  await ctx.close();
  return { ok: !m.rolagemLateral && m.formLargura <= m.janela && m.menor >= 44, detalhe: JSON.stringify(m) };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
