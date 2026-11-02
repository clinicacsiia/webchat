// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado) -> validação (a pergunta do exame abre pela foto; sem pedido, pelo tipo/parte/lado) -> lógica (folha só da foto, foto vai ao atendente, "seguir só com a foto", pedido montado junto e enviado de uma vez por chat_pedido_enviar, mais fotos depois) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial (foto do pedido separada, junto do pedido por tipo/parte/lado)
//
// Requer um Chromium (CHROMIUM_PATH). O banco é simulado; o SQL tem teste próprio (rodado contra o Supabase em transação desfeita).
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n').slice(0, 3).join(' / ')}`); } }

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');

function mundoComExame() {
  const m = criarMundo();
  m.inserirExame = () => m.inserir('agente', 'Você tem o pedido médico?', { tipo: 'busca_exame', passo: 'exame' });
  m.seguinte = () => (m.passo === 'motivo' ? m.inserirExame() : m.inserir('agente', 'Certo.', null));
  const orig = m.tratar;
  m.fotos = 0; m.enviados = [];
  m.tratar = async (nome, corpo, cab) => {
    if (nome === 'chat_anexo_enviar') { m.fotos++; m.chamadas.push({ nome, corpo }); return { body: { id: 70 + m.fotos } }; }
    if (nome === 'chat_pedido_enviar') { m.enviados.push(corpo); m.chamadas.push({ nome, corpo }); const r = m.inserir('agente', 'Recebi o pedido.', null); return { body: { ok: true, itens: corpo.p_itens.length, mensagem_id: 5, respostas: [r] } }; }
    if (nome === 'chat_exames' && corpo.p_regiao === 'todos') return { body: [{ id: 5001, nome: 'MAMOGRAFIA BILATERAL', unilateral: false, bilateral: true }] };
    return orig(nome, corpo, cab);
  };
  return m;
}

await caso('a pergunta do exame começa pela foto; a lista (tipo, parte, lado) vem logo depois', async () => {
  const mundo = mundoComExame();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  await page.click('#msgs .op >> text=Exame');
  await page.waitForSelector('#msgs .widget[data-tipo=busca_exame] button');
  const rotulos = await page.$$eval('#msgs .widget[data-tipo=busca_exame] button', (bs) => bs.map((b) => b.textContent.trim()));
  await ctx.close();
  return { ok: /pedido médico/.test(rotulos[0]) && /tipo, parte do corpo e lado/.test(rotulos[1]) && erros.excecoes.length === 0, detalhe: rotulos.join(' | ') + (erros.excecoes[0] ? ' | ' + erros.excecoes[0] : '') };
});

await caso('foto: folha separada, foto vai ao atendente, segue só com a foto e envia tudo junto', async () => {
  const mundo = mundoComExame();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  await page.click('#msgs .op >> text=Exame');
  await page.click('#msgs .widget[data-tipo=busca_exame] button >> text=Tenho o pedido médico');
  await page.waitForSelector('#folha:not([hidden])');
  const titulo = await page.locator('#folhaTitulo').innerText();
  const antes = await page.locator('#folhaCorpo').innerText();
  await page.setInputFiles('#folhaCorpo input[type=file]:not([capture])', { name: 'pedido.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => /1 foto enviada/.test(document.querySelector('#folhaRodape')?.innerText || ''), null, { timeout: 15000 });
  await page.click('#folhaRodape button >> text=Seguir só com a foto');
  await page.waitForSelector('#folhaTitulo >> text=Montar pedido de exames');
  await page.waitForSelector('.carrinho');
  const pedido = await page.locator('#folhaCorpo').innerText();
  await page.click('#folhaRodape button >> text=Enviar pedido');
  await page.waitForFunction(() => document.querySelector('#folha')?.hidden, null, { timeout: 5000 });
  const env = mundo.enviados[0];
  await ctx.close();
  return { ok: titulo === 'Foto do pedido médico' && /lerei|leio só o exame|Eu leio só o exame/i.test(antes) && /1 foto do pedido vai junto/.test(pedido) && env && env.p_itens.length === 1 && /pedido médico/.test(env.p_itens[0].texto) && mundo.fotos === 1 && erros.excecoes.length === 0,
    detalhe: `${titulo} | antes=${antes.replace(/\n/g,' ').slice(0,90)} | pedido=${pedido.replace(/\n/g,' ').slice(0,160)} | fotos=${mundo.fotos} | ${JSON.stringify(env && env.p_itens)} | ${erros.excecoes.join(';')}` };
});

await caso('sem pedido: monta por tipo/parte/lado, pode juntar uma foto depois e envia uma vez só', async () => {
  const mundo = mundoComExame();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  await page.click('#msgs .op >> text=Exame');
  await page.click('#msgs .widget[data-tipo=busca_exame] button >> text=Escolher o exame');
  await page.waitForSelector('.passos');
  const passo = await page.locator('#folhaCorpo').innerText();
  await page.click('#folhaCorpo .op >> text=Mamografia');
  await page.waitForSelector('.opcao-ex');
  await page.locator('.opcao-ex').first().click();
  await page.click('#folhaCorpo button >> text=Adicionar ao pedido');
  await page.waitForSelector('.carrinho');
  await page.click('#folhaCorpo button >> text=Tenho o pedido médico');
  await page.waitForSelector('#folhaTitulo >> text=Foto do pedido médico');
  await page.setInputFiles('#folhaCorpo input[type=file]:not([capture])', { name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => /1 foto enviada/.test(document.querySelector('#folhaRodape')?.innerText || ''), null, { timeout: 15000 });
  await page.click('#folhaRodape button >> text=Seguir só com a foto');
  await page.waitForSelector('#folhaTitulo >> text=Montar pedido de exames');
  await page.waitForFunction(() => document.querySelectorAll('.carrinho li').length === 2, null, { timeout: 5000 }).catch(() => {});
  const itensTela = await page.locator('.carrinho li').count();
  await page.click('#folhaRodape button >> text=Enviar pedido');
  await page.waitForFunction(() => document.querySelector('#folha')?.hidden, null, { timeout: 5000 });
  const env = mundo.enviados;
  await ctx.close();
  return { ok: /Que tipo de exame/.test(passo) && itensTela === 2 && env.length === 1 && env[0].p_itens.length === 2 && env[0].p_itens.some((i) => i.procedimento_id) && erros.excecoes.length === 0,
    detalhe: `itensTela=${itensTela} | envios=${env.length} | ${JSON.stringify(env[0] && env[0].p_itens)} | ${erros.excecoes.join(';')}` };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
