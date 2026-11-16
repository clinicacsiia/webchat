// FLUXOGRAMA: entrada (chat do paciente com Supabase simulado; a pergunta do assistente chega com o cartão de valor `destaque`) -> validação (cartão só aparece com valor; sem `destaque` a tela é a de sempre)
//   -> lógica (valor total em destaque, lista por exame, dois botões; tocar manda o passo `valor` com "sim" ou "nao") -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 16/11/2026 / Mudança: primeira versão (paciente Particular vê o valor antes de marcar).
import { chromium, servidor, criarMundo, novaPaginaChat } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const srv = await servidor(); const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

async function abrir(opcoes) {
  const mundo = criarMundo();
  mundo.perguntaMotivo = () => mundo.inserir('agente', 'Antes de marcar, confira o valor do atendimento Particular.', { tipo: 'escolha', passo: 'valor', itens: [
    { valor: 'sim', rotulo: 'Concordo com o valor e quero marcar' }, { valor: 'nao', rotulo: 'Não quero marcar por causa do valor' }], ...opcoes });
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  await page.goto(`${base}/index.html`); await page.waitForSelector('#formInicio', { state: 'visible', timeout: 8000 });
  await page.click('#fQuem .unidade >> nth=0'); await page.fill('#fNome', 'Ana Souza'); await page.fill('#fTel', '71999998888'); await page.fill('#fEmail', 'a@b.co');
  await page.check('#fAceite'); await page.check('#fPrevisao'); await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .msg.agente .op', { timeout: 8000 });
  return { mundo, page, ctx };
}

await caso('com valor: o cartão mostra o total em destaque, a lista por exame e os dois botões', async () => {
  const { page, ctx } = await abrir({ destaque: { titulo: 'Valor total (Particular)', valor: 'R$ 730,00', linhas: ['RM JOELHO: R$ 580,00', 'US ABDOME: R$ 150,00'] } });
  const tot = await page.$eval('.valor-destaque .vd-valor', (n) => n.textContent);
  const tit = await page.$eval('.valor-destaque .vd-titulo', (n) => n.textContent);
  const linhas = await page.$$eval('.valor-destaque .vd-linhas li', (n) => n.map((x) => x.textContent));
  const botoes = await page.$$eval('#msgs .msg.agente .op strong', (n) => n.map((x) => x.textContent));
  const tamanho = await page.$eval('.valor-destaque .vd-valor', (n) => parseFloat(getComputedStyle(n).fontSize));
  await ctx.close();
  return { ok: tot === 'R$ 730,00' && /Particular/.test(tit) && linhas.length === 2 && botoes.length === 2 && tamanho >= 28, detalhe: `${tot}; ${linhas.length} linhas; fonte ${tamanho}px; botões: ${botoes.join(' | ')}` };
});
await caso('um exame só: não repete a linha (o total já é o valor do exame)', async () => {
  const { page, ctx } = await abrir({ destaque: { titulo: 'Valor total (Particular)', valor: 'R$ 580,00', linhas: ['RM JOELHO: R$ 580,00'] } });
  const lista = await page.$$('.valor-destaque .vd-linhas'); await ctx.close();
  return { ok: lista.length === 0 };
});
await caso('tocar em "Concordo" manda o passo valor com "sim"; "Não quero" manda "nao"', async () => {
  const a = await abrir({ destaque: { titulo: 'Valor total (Particular)', valor: 'R$ 580,00', linhas: [] } });
  await a.page.click('#msgs .msg.agente .op >> nth=0'); await a.page.waitForTimeout(400);
  const c1 = a.mundo.chamadas.find((x) => x.nome === 'chat_responder'); await a.ctx.close();
  const b = await abrir({ destaque: { titulo: 'Valor total (Particular)', valor: 'R$ 580,00', linhas: [] } });
  await b.page.click('#msgs .msg.agente .op >> nth=1'); await b.page.waitForTimeout(400);
  const c2 = b.mundo.chamadas.find((x) => x.nome === 'chat_responder'); await b.ctx.close();
  return { ok: c1 && c1.corpo.p_passo === 'valor' && c1.corpo.p_valor === 'sim' && c2 && c2.corpo.p_passo === 'valor' && c2.corpo.p_valor === 'nao', detalhe: `${c1?.corpo.p_valor} / ${c2?.corpo.p_valor}` };
});
await caso('sem preço (sem destaque): só os dois botões, nenhum cartão de valor', async () => {
  const { page, ctx } = await abrir({});
  const cartao = await page.$$('.valor-destaque'); const botoes = await page.$$('#msgs .msg.agente .op'); await ctx.close();
  return { ok: cartao.length === 0 && botoes.length === 2 };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
