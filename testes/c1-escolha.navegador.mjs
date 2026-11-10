// FLUXOGRAMA: entrada (chat do paciente com Supabase simulado e uma conversa guardada no aparelho) -> validação (a tela de escolha só aparece com conversa guardada; erro/servidor antigo cai no jeito de antes) -> lógica (aberta: voltar ou encerrar e abrir nova; encerrada em até 2 dias: voltar ou nova; encerrada há mais: direto para a nova; mesmo dia: pergunta o motivo com 3 saídas) -> saída (PASS/FAIL e a chamada chat_nova_conversa com os parâmetros certos)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (Etapa C1)
import { chromium, servidor, criarMundo, novaPaginaChat } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const srv = await servidor(); const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

// abre o chat com o formulário, começa uma conversa, e só então escolhe "Fazer um novo pedido" no menu
async function comConversa(estado) {
  const espera = estado.pode_voltar !== false;
  const mundo = criarMundo(); mundo.estadoReentrada = estado;
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  await page.goto(`${base}/index.html`); await page.waitForSelector('#formInicio', { state: 'visible', timeout: 8000 });
  await page.click('#fQuem .unidade >> nth=0'); await page.fill('#fNome', 'Ana'); await page.fill('#fTel', '71999998888'); await page.fill('#fEmail', 'a@b.co');
  await page.check('#fAceite'); await page.check('#fPrevisao'); await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .msg.agente .op', { timeout: 8000 });
  await page.click('#btnMenu'); await page.click('#btnNova');
  if (espera) await page.waitForSelector('#escNova', { timeout: 4000 });
  return { mundo, page, ctx };
}
const visivel = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const E = (extra = {}) => ({ status: 'aguardando', aberta: true, pode_voltar: true, mesmo_dia: false, janela_dias: 2, teve_resposta_humana: false, em_atendimento: false, ...extra });

await caso('conversa ABERTA no aparelho: aparece a escolha "voltar ao tema" ou "abrir nova"; voltar fecha a tela sem chamar nada', async () => {
  const { mundo, page, ctx } = await comConversa(E());
  const tit = await page.$eval('#folhaTitulo', (n) => n.textContent); const duas = (await visivel(page, '#escVoltar')) && (await visivel(page, '#escNova'));
  await page.click('#escVoltar'); await page.waitForTimeout(200);
  const fechou = !(await visivel(page, '#folha')); const nova = mundo.chamadas.filter((c) => c.nome === 'chat_nova_conversa').length; await ctx.close();
  return { ok: /conversa aberta/.test(tit) && duas && fechou && nova === 0, detalhe: tit };
});
await caso('abrir nova (anterior aberta, outro dia): avisa que a antiga será encerrada e o histórico fica salvo; o formulário abre e o envio usa chat_nova_conversa', async () => {
  const { mundo, page, ctx } = await comConversa(E());
  await page.click('#escNova'); const aviso = await page.$eval('#folhaCorpo', (n) => n.textContent); await page.click('#escContinuar');
  await page.waitForSelector('#formInicio', { state: 'visible' });
  await page.click('#fQuem .unidade >> nth=0'); await page.check('#fPrevisao'); await page.click('#btnIniciar'); await page.waitForTimeout(500);
  const c = mundo.chamadas.find((x) => x.nome === 'chat_nova_conversa'); await ctx.close();
  return { ok: /será encerrada/.test(aviso) && /histórico fica salvo/.test(aviso) && c && !!c.corpo.p_conversa_anterior && c.corpo.p_aceite_previsao === true && c.corpo.p_motivo === null, detalhe: aviso.slice(0, 90) };
});
await caso('mesmo dia: pergunta o motivo; "Não tive retorno" segue com p_motivo=sem_retorno', async () => {
  const { mundo, page, ctx } = await comConversa(E({ mesmo_dia: true }));
  await page.click('#escNova'); const tem3 = (await visivel(page, '#escSemRetorno')) && (await visivel(page, '#escOutro')) && (await visivel(page, '#escVer'));
  await page.click('#escSemRetorno'); await page.waitForSelector('#formInicio', { state: 'visible' });
  await page.click('#fQuem .unidade >> nth=0'); await page.check('#fPrevisao'); await page.click('#btnIniciar'); await page.waitForTimeout(500);
  const c = mundo.chamadas.find((x) => x.nome === 'chat_nova_conversa'); await ctx.close();
  return { ok: tem3 && c && c.corpo.p_motivo === 'sem_retorno' && !c.corpo.p_motivo_texto };
});
await caso('mesmo dia: "Outro assunto" abre o campo de texto e envia motivo + texto', async () => {
  const { mundo, page, ctx } = await comConversa(E({ mesmo_dia: true }));
  await page.click('#escNova'); await page.click('#escOutro'); await page.fill('#escTexto', 'remarcar ultrassom'); await page.click('#escOutroOk');
  await page.waitForSelector('#formInicio', { state: 'visible' });
  await page.click('#fQuem .unidade >> nth=0'); await page.check('#fPrevisao'); await page.click('#btnIniciar'); await page.waitForTimeout(500);
  const c = mundo.chamadas.find((x) => x.nome === 'chat_nova_conversa'); await ctx.close();
  return { ok: c && c.corpo.p_motivo === 'outro_assunto' && c.corpo.p_motivo_texto === 'remarcar ultrassom' };
});
await caso('mesmo dia: "Ver a conversa anterior" volta para a conversa (nada é chamado)', async () => {
  const { mundo, page, ctx } = await comConversa(E({ mesmo_dia: true }));
  await page.click('#escNova'); await page.click('#escVer'); await page.waitForTimeout(200);
  const chat = await visivel(page, '#msgs'); const form = await visivel(page, '#formInicio'); const n = mundo.chamadas.filter((c) => c.nome === 'chat_nova_conversa').length; await ctx.close();
  return { ok: chat && !form && n === 0 };
});
await caso('encerrada há MAIS de 2 dias (pode_voltar=false): vai direto ao formulário, sem tela de escolha', async () => {
  const { page, ctx } = await comConversa(E({ aberta: false, status: 'encerrada', pode_voltar: false }));
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 4000 }); const esc = await visivel(page, '#escNova'); await ctx.close();
  return { ok: !esc };
});
await caso('encerrada em até 2 dias: a escolha diz "terminou há pouco" e explica a janela de 2 dias', async () => {
  const { page, ctx } = await comConversa(E({ aberta: false, status: 'encerrada' }));
  const tit = await page.$eval('#folhaTitulo', (n) => n.textContent); const txt = await page.$eval('#folhaCorpo', (n) => n.textContent); await ctx.close();
  return { ok: /terminou há pouco/.test(tit) && /2 dias/.test(txt) };
});
await caso('servidor sem a função nova (cache antigo): cai no jeito de antes, sem tela e sem erro', async () => {
  const mundo = criarMundo(); const orig = mundo.tratar.bind(mundo);
  mundo.tratar = async (n, ...a) => (n === 'chat_reentrada_estado' ? { status: 404, body: { message: 'Not Found' } } : orig(n, ...a));
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  await page.goto(`${base}/index.html`); await page.waitForSelector('#formInicio', { state: 'visible', timeout: 8000 });
  await page.click('#fQuem .unidade >> nth=0'); await page.fill('#fNome', 'Ana'); await page.fill('#fTel', '71999998888'); await page.fill('#fEmail', 'a@b.co');
  await page.check('#fAceite'); await page.check('#fPrevisao'); await page.click('#btnIniciar'); await page.waitForSelector('#msgs .msg.agente .op', { timeout: 8000 });
  await page.click('#btnMenu'); await page.click('#btnNova'); await page.waitForTimeout(500);
  const form = await visivel(page, '#formInicio'); await ctx.close();
  return { ok: form };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
