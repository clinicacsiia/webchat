// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado com exames de RM em 3 partes do corpo) -> validação (só aparece exame que o banco devolveu; sem lado escolhido não envia) -> lógica (tipo -> lista com caixinhas por parte do corpo -> busca filtra ao digitar -> marcar acende a parte no boneco -> lado direito/esquerdo/os dois -> vários exames -> envio único) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 16/11/2026 / Mudança: pedido de exames por lista com caixinhas e busca; o boneco só mostra (sem tocar nele)
//
// Requer um Chromium (CHROMIUM_PATH). O banco é simulado; os exames saem de chat_exames, que no banco só devolve exame com agenda ativa no Klingo.
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n').slice(0, 3).join(' / ')}`); } }

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

function mundo() {
  const m = criarMundo();
  m.inserirExame = () => m.inserir('agente', 'Você tem o pedido médico?', { tipo: 'busca_exame', passo: 'exame' });
  m.seguinte = () => (m.passo === 'motivo' ? m.inserirExame() : m.inserir('agente', 'Certo.', null));
  const orig = m.tratar; m.enviados = [];
  m.tratar = async (nome, corpo, cab) => {
    if (nome === 'chat_pedido_enviar') { m.enviados.push(corpo); m.chamadas.push({ nome, corpo }); const r = m.inserir('agente', 'Recebi o pedido.', null); return { body: { ok: true, itens: corpo.p_itens.length, mensagem_id: 5, respostas: [r] } }; }
    return orig(nome, corpo, cab);
  };
  return m;
}
async function abrir(m) {
  const r = await novaPaginaChat(browser, m);
  await comecarConversa(r.page, base);
  await r.page.click('#msgs .op >> text=Exame');
  await r.page.click('#msgs .widget[data-tipo=busca_exame] button >> text=Escolher o exame');
  await r.page.click('#folhaCorpo .op >> text=Ressonância');
  await r.page.waitForSelector('#listaEx .grupo-ex');
  return r;
}
const grupos = (page) => page.$$eval('#listaEx .grupo-ex summary .nome', (n) => n.map((x) => x.textContent.trim()));
const acesas = (page) => page.$$eval('.pedido-corpo .parte.sel', (n) => n.length);

await caso('lista por parte do corpo, sem desenho clicável nem lista de partes; boneco só de visualização', async () => {
  const { page, ctx, erros } = await abrir(mundo());
  const g = await grupos(page);
  const antigos = await page.locator('text=Desenho do corpo').count() + await page.locator('text=Qual parte do corpo').count();
  const clicaveis = await page.locator('.pedido-corpo .parte[role=button]').count();
  const caixas = await page.locator('#listaEx input[type=checkbox]').count();
  const zero = await acesas(page);
  await ctx.close();
  return { ok: g.includes('Crânio') && g.includes('Tórax') && g.includes('Punho / mão') && !g.includes('Joelho') && antigos === 0 && clicaveis === 0 && caixas > 0 && zero === 0 && erros.excecoes.length === 0, detalhe: `${g.join(',')} | caixas=${caixas} | ${erros.excecoes.join(';')}` };
});

await caso('digitar filtra (por exame ou parte do corpo, sem acento) e mostra o que casa', async () => {
  const { page, ctx } = await abrir(mundo());
  await page.fill('.busca-ex', 'cranio');
  const g1 = await grupos(page), n1 = await page.locator('#listaEx input[type=checkbox]').count();
  await page.fill('.busca-ex', 'tractografia');
  const n2 = await page.locator('#listaEx input[type=checkbox]').count();
  await page.fill('.busca-ex', 'xyzxyz');
  const vazio = await page.locator('#listaEx').innerText();
  await page.fill('.busca-ex', '');
  const g3 = await grupos(page);
  await ctx.close();
  return { ok: g1.length === 1 && g1[0] === 'Crânio' && n1 > 3 && n2 === 1 && /Nenhum exame/.test(vazio) && g3.length === 3, detalhe: `${g1} | ${n1} | ${n2} | ${vazio.slice(0, 40)} | ${g3.length}` };
});

await caso('marcar acende a parte no boneco e entra no pedido; vários exames; lado obrigatório; envio único', async () => {
  const m = mundo();
  const { page, ctx, erros } = await abrir(m);
  await page.fill('.busca-ex', 'tórax');
  await page.locator('#listaEx .opcao-ex').first().click();   // exame de tórax (sem lado)
  await page.waitForSelector('.carrinho li');
  const acesoTorax = await acesas(page);
  await page.fill('.busca-ex', 'mão e punho');
  await page.locator('#listaEx .opcao-ex').first().click();   // punho/mão: pede o lado
  await page.waitForSelector('.lado-sel.dentro');
  const bloqueado = await page.locator('#folhaRodape button.btn-w').first().isDisabled();
  const aviso = await page.locator('#folhaRodape .aviso-lado').count();
  await page.click('.lado-sel.dentro button >> text=Esquerdo');
  const liberado = !(await page.locator('#folhaRodape button.btn-w').first().isDisabled());
  const itensTela = await page.locator('.carrinho li').count();
  const letras = await page.$$eval('.pedido-corpo text.letra', (n) => n.map((x) => x.textContent));
  await page.click('#folhaRodape button >> text=Enviar pedido');
  await page.waitForFunction(() => document.querySelector('#folha')?.hidden, null, { timeout: 5000 });
  const env = m.enviados;
  await ctx.close();
  const it = env[0] && env[0].p_itens;
  return { ok: acesoTorax >= 1 && bloqueado && aviso === 1 && liberado && itensTela === 2 && letras.length >= 1 && env.length === 1 && it.length === 2
    && it.some((i) => i.regiao === 'torax' && i.lado === 'N') && it.some((i) => i.regiao === 'punho_mao' && i.lado === 'E') && erros.excecoes.length === 0,
    detalhe: `aceso=${acesoTorax} bloq=${bloqueado} aviso=${aviso} lib=${liberado} itens=${itensTela} letras=${letras} | ${JSON.stringify(it)} | ${erros.excecoes.join(';')}` };
});

await caso('desmarcar tira do pedido e apaga a parte do boneco', async () => {
  const { page, ctx } = await abrir(mundo());
  await page.fill('.busca-ex', 'tórax');
  await page.locator('#listaEx .opcao-ex').first().click();
  const antes = await acesas(page);
  await page.locator('#listaEx .opcao-ex').first().click();
  const depois = await acesas(page), itens = await page.locator('.carrinho li').count();
  await ctx.close();
  return { ok: antes >= 1 && depois === 0 && itens === 0, detalhe: `${antes}->${depois} itens=${itens}` };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
