// FLUXOGRAMA: entrada (o index.html REAL do chat e o minha-vez/index.html REAL num Chromium de celular; o Supabase é simulado por interceptação de rede) -> validação (botão grande e balão só com o acesso rápido; lista, ações e PIN do portal) -> lógica (balão = novidades do banco; tocar no pedido oferece a conversa; cancelar e remarcar pedem confirmação; resultado e arquivo guardado; PIN pedido sem login automático) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (acompanhar pedidos). O banco em si é provado em sql-acompanhar-pedidos.test.mjs.
// Dados inventados. Requer Chromium (CHROMIUM_PATH ou o do Playwright).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium, criarMundo, novaPaginaChat } from './mock-chat.mjs';
import { REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, d = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, 'exceção: ' + String(e.message).split('\n')[0]); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  const f = resolve(REPO, '.' + new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
  if (!f.startsWith(REPO) || !existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TIPOS[extname(f)] || 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const lib = readFileSync(resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'), 'utf8');

const DEV = 'dispositivo-de-teste';
const C1 = '11111111-1111-4111-8111-111111111111', C2 = '22222222-2222-4222-8222-222222222222', C3 = '33333333-3333-4333-8333-333333333333', C9 = '99999999-9999-4999-8999-999999999999';
const dia = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dadosPadrao = () => ({
  ok: true, nome: 'Ana Souza Teste', telefone_final: '0001', email_salvo: true,
  pessoas: [{ nome: 'Ana Souza Teste', eu: true }, { nome: 'Leo Souza Teste', eu: false }],
  pedidos: [
    { conversa: C1, pessoa: 'Ana Souza Teste', eu: true, aberta: false, tipo: 'exame', exames: [{ id: 11, nome: 'RM JOELHO DIREITO', unidade: 'Centro', data: dia(3), hora: '08:40', ok: 2, excecao: null, resultado: null }], sig: 'a', novo: true },
    { conversa: C2, pessoa: 'Leo Souza Teste', eu: false, aberta: true, tipo: 'exame', exames: [{ id: 12, nome: 'US ABDOME TOTAL', unidade: 'Centro', data: dia(5), hora: '09:20', ok: 3, excecao: null, resultado: null }], sig: 'b', novo: false },
    { conversa: C3, pessoa: 'Ana Souza Teste', eu: true, aberta: false, tipo: 'exame', exames: [{ id: 13, nome: 'RM COLUNA LOMBAR', unidade: 'Centro', data: dia(-2), hora: '10:00', ok: 5, excecao: null, resultado: 'disponivel' }], sig: 'c', novo: false },
  ],
  novidades: 1,
  resultados: [{ id: 'r1', pessoa: 'Leo Souza Teste', eu: false, nome: 'TC TORAX', data_exame: '2026-10-10', entregue_em: '2026-10-15T12:00:00Z', tem_arquivo: true, conversa: C9 }],
});
const perfil = (extra = {}) => ({ ok: true, perfil: { nome: 'Ana Souza Teste', nascimento: '1988-04-12', telefone: '71991230001', email: 'ana@exemplo.invalid', cpf_salvo: true, cpf_mascara: '***.***.***-25', selecao: ['eu'], filhos: [{ id: 'f1', nome: 'Leo Souza Teste', nascimento: '2019-08-30', cpf_salvo: false, cpf_mascara: null }], confiaveis: [], marcacoes: [], confiam_em_mim: [], ...extra } });

// ======================================================= 1) a tela principal do chat
async function abrirChat({ token = true, contagem = { ok: true, novidades: 2 }, perfilResp = perfil(), conversa = false } = {}) {
  const mundo = criarMundo({ acessoAtivo: true });
  mundo.acompanhar = { vincular: [], contagem: 0 };
  const original = mundo.tratar;
  mundo.tratar = async (nome, corpo, cab) => {
    if (nome === 'app_perfil') return { body: perfilResp };
    if (nome === 'app_pendencias') return { body: { ok: true, pendencias: [] } };
    if (nome === 'app_conversa_vincular') { mundo.acompanhar.vincular.push(corpo); return { body: { ok: true } }; }
    if (nome === 'app_pedidos_contagem') { mundo.acompanhar.contagem++; return { body: typeof contagem === 'function' ? contagem() : contagem }; }
    return original(nome, corpo, cab);
  };
  const init = [];
  if (token) init.push([(t) => { try { localStorage.setItem('csi_acesso_v2', JSON.stringify({ dev: t, nome1: 'Ana' })); } catch { /* sem armazenamento */ } }, DEV]);
  if (conversa) init.push([(c) => { try { localStorage.setItem('webchat.conversa.v1', JSON.stringify(c)); } catch { /* sem armazenamento */ } }, { id: mundo.conversa, token: mundo.token, tipo: 'proprio', nomeCrianca: '', irmaos: [], irmaosModo: '' }]);
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init });
  await page.goto(`${base}/index.html`);
  await page.waitForSelector(conversa ? '#telaChat' : '#formInicio', { state: 'visible', timeout: 10000 }).catch(() => {});
  await espera(900);
  return { page, ctx, mundo, erros };
}

await caso('tela principal: botão grande "Acompanhe seus pedidos" com o balão das novidades (2), levando ao check-in', async () => {
  const { page, ctx, mundo, erros } = await abrirChat();
  const a = await page.$eval('#linkAcompanhar', (n) => ({ visivel: !n.hidden && n.offsetHeight > 40, href: n.getAttribute('href'), txt: n.textContent }));
  const b = await page.$eval('#balaoAcompanhar', (n) => ({ oculto: n.hidden, txt: n.textContent, aria: n.getAttribute('aria-label') }));
  await ctx.close();
  return { ok: a.visivel && /minha-vez\/\?acompanhar=1$/.test(a.href) && /Acompanhe seus pedidos/.test(a.txt) && !b.oculto && b.txt === '2' && b.aria === '2 novidades' && erros.excecoes.length === 0 && mundo.acompanhar.contagem >= 1,
    detalhe: JSON.stringify({ a, b, erros: erros.excecoes }) };
});
await caso('sem novidades o balão some; o botão continua', async () => {
  const { page, ctx } = await abrirChat({ contagem: { ok: true, novidades: 0 } });
  const a = await page.$eval('#linkAcompanhar', (n) => !n.hidden), b = await page.$eval('#balaoAcompanhar', (n) => n.hidden);
  await ctx.close();
  return { ok: a && b };
});
await caso('sem acesso rápido neste aparelho (sem código guardado) não aparece botão nenhum', async () => {
  const { page, ctx } = await abrirChat({ token: false });
  const a = await page.$eval('#linkAcompanhar', (n) => n.hidden), m = await page.$eval('#btnAcompanhar', (n) => n.hidden);
  await ctx.close();
  return { ok: a && m };
});
await caso('PIN vencido: o botão continua (a pessoa digita o PIN no portal) e o balão some', async () => {
  const { page, ctx } = await abrirChat({ perfilResp: { ok: false, erro: 'bloqueado', mensagem: 'Digite seu PIN para continuar.' }, contagem: { ok: false, erro: 'bloqueado' } });
  const a = await page.$eval('#linkAcompanhar', (n) => !n.hidden), b = await page.$eval('#balaoAcompanhar', (n) => n.hidden);
  await ctx.close();
  return { ok: a && b };
});
await caso('o balão acompanha o banco: sobe de 0 para 3 sozinho na próxima conferência (voltando à aba)', async () => {
  let n = 0;
  const { page, ctx } = await abrirChat({ contagem: () => ({ ok: true, novidades: n }) });
  const antes = await page.$eval('#balaoAcompanhar', (x) => x.hidden);
  n = 3;
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await espera(700);
  const depois = await page.$eval('#balaoAcompanhar', (x) => ({ oculto: x.hidden, txt: x.textContent }));
  await ctx.close();
  return { ok: antes === true && depois.oculto === false && depois.txt === '3', detalhe: JSON.stringify(depois) };
});
await caso('no chat aberto: o acesso é pelo menu (com o balão) e a conversa do aparelho é ligada ao cadastro', async () => {
  const { page, ctx, mundo } = await abrirChat({ conversa: true });
  const grande = await page.$eval('#linkAcompanhar', (n) => n.hidden);
  await page.click('#btnMenu');
  const item = await page.$eval('#btnAcompanhar', (n) => ({ visivel: !n.hidden && n.offsetHeight > 0, txt: n.textContent }));
  const vinc = mundo.acompanhar.vincular.find((v) => v.p_conversa === mundo.conversa);
  await ctx.close();
  return { ok: grande && item.visivel && /Acompanhe seus pedidos/.test(item.txt) && /2$/.test(item.txt) && !!vinc && vinc.p_token === DEV && vinc.p_conv_token === mundo.token, detalhe: JSON.stringify({ grande, item, vinc: !!vinc }) };
});

// ======================================================= 2) o portal (check-in) com login automático
async function abrirPortal({ dev = true, dados = dadosPadrao(), bloqueado = false, perfilResp = perfil(), url = '/minha-vez/?acompanhar=1' } = {}) {
  const ctx = await browser.newContext({ permissions: [], viewport: { width: 390, height: 780 } });
  if (dev) await ctx.addInitScript((t) => { try { localStorage.setItem('csi_acesso_v2', JSON.stringify({ dev: t, nome1: 'Ana' })); } catch { /* sem armazenamento */ } }, DEV);
  const estado = { rpcs: [], corpos: {}, dados, bloqueado, pinCerto: '1357', acao: null, checkin: null, nav: [] };
  await ctx.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: lib }));
  await ctx.route('**/*.supabase.co/**', async (r) => {
    const u = new URL(r.request().url()), j = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const nome = u.pathname.split('/').pop(); let c = {}; try { c = JSON.parse(r.request().postData() || '{}'); } catch { /* sem corpo */ }
      estado.rpcs.push(nome); (estado.corpos[nome] = estado.corpos[nome] || []).push(c);
      switch (nome) {
        case 'app_pedidos': return estado.bloqueado ? j({ ok: false, erro: 'bloqueado', mensagem: 'Digite seu PIN para continuar.' }) : j(estado.dados);
        case 'app_desbloquear': if (c.p_pin === estado.pinCerto) { estado.bloqueado = false; return j({ ok: true, perfil: perfil().perfil }); } return j({ ok: false, erro: 'pin', mensagem: 'PIN incorreto. Tente de novo.' });
        case 'app_perfil': return j(perfilResp);
        case 'app_pedido_visto': return j({ ok: true });
        case 'app_pedido_acao': return j(estado.acao ? estado.acao(c) : { ok: true, conversa: c.p_conversa, token: 'tok-' + c.p_conversa, tipo: 'proprio', paciente_nome: null, aberta: true });
        case 'app_pedido_apagar': return j(estado.apagar ? estado.apagar(c) : { ok: true, cancelado: false });
        case 'app_pedido_reabrir': return j(estado.reabrir ? estado.reabrir(c) : { ok: true, conversa: c.p_conversa, token: 'tok-reaberto', aberta: true, reaberta: true, tipo: 'proprio', paciente_nome: null });
        case 'app_pedido_avaliar': return j(estado.avaliar ? estado.avaliar(c) : { ok: true, nova: true });
        case 'app_resultado_arquivo': return j({ ok: true, mime: 'application/pdf', nome: 'laudo.pdf', base64: Buffer.from('%PDF-1.4 teste').toString('base64') });
        case 'checkin_publico': estado.checkin = c; return j({ situacao: 'aguardando', ticket: 'tk-9', senha: 7, posicao: 3, a_frente: 2 });
        case 'fila_minha_vez_ticket': return j({ situacao: 'aguardando', senha: 7, posicao: 3, a_frente: 2, total: 5, pode_chegar: true });
        case 'fila_config_publica': return j({ vapid: null });
        default: return j(null);
      }
    }
    return j([]);
  });
  const page = await ctx.newPage();
  const erros = []; page.on('pageerror', (e) => erros.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}${url}`);
  await espera(800);
  return { page, ctx, estado, erros };
}
const textoDe = (page) => page.$eval('#raiz', (n) => n.innerText);

await caso('login automático: com o código do aparelho a página já entra sozinha e mostra os pedidos de TODOS (titular e filho), sem pedir senha', async () => {
  const { page, ctx, estado, erros } = await abrirPortal();
  const t = await textoDe(page);
  const n = await page.$$eval('.cartao.pedido', (ns) => ns.length);
  await ctx.close();
  return { ok: /Acompanhe seus pedidos/.test(t) && n === 3 && /Ana|Olá, Ana/.test(t) && /Leo/.test(t) && !/Entrar com e-mail/.test(t) && erros.length === 0 && estado.corpos.app_pedidos[0].p_token === DEV && estado.corpos.app_pedidos[0].p_renova === true, detalhe: `${n} pedidos ${erros.join('|')}` };
});
await caso('cada pedido mostra o status (marcado, confirmado, exame feito), a data e a unidade; os exames saem com o nome legível', async () => {
  const { page, ctx } = await abrirPortal();
  const t = await textoDe(page);
  await ctx.close();
  return { ok: /Exame marcado/.test(t) && /Tudo certo! Falta só você chegar/.test(t) && /Exame realizado/.test(t) && /às 08:40 · Centro/.test(t) && /Ressonância|RM/i.test(t), detalhe: t.slice(0, 200).replace(/\n/g, ' | ') };
});
await caso('pedido com novidade tem a etiqueta "Novidade"; o portal marca como visto sozinho (o balão da tela principal some)', async () => {
  const { page, ctx, estado } = await abrirPortal();
  const novo = await page.$$eval('.novo', (ns) => ns.length);
  await espera(4200);
  const visto = (estado.corpos.app_pedido_visto || [])[0];
  await ctx.close();
  return { ok: novo === 1 && !!visto && visto.p_token === DEV && !visto.p_conversa, detalhe: `${novo} ${JSON.stringify(visto)}` };
});
await caso('filtro por pessoa: "Eu" mostra só os da Ana; "Leo" só os do filho', async () => {
  const { page, ctx } = await abrirPortal();
  await page.click('.chip:has-text("Leo")');
  const leo = await page.$$eval('.cartao.pedido', (ns) => ns.length);
  await page.click('.chip:has-text("Eu")');
  const eu = await page.$$eval('.cartao.pedido', (ns) => ns.length);
  await page.click('.chip:has-text("Todos")');
  const todos = await page.$$eval('.cartao.pedido', (ns) => ns.length);
  await ctx.close();
  return { ok: leo === 1 && eu === 2 && todos === 3, detalhe: `${leo}/${eu}/${todos}` };
});
await caso('tocar no pedido OFERECE levar até a conversa; aceitando, o código da conversa vai para o aparelho e o chat abre nela', async () => {
  const { page, ctx, estado } = await abrirPortal();
  estado.acao = (c) => ({ ok: true, conversa: c.p_conversa, token: 'tok-secreto', tipo: 'filho', paciente_nome: 'Leo Souza Teste', aberta: true });
  await page.locator('.cartao.pedido', { hasText: 'Leo' }).click();
  const oferta = await page.$eval('.folha', (n) => n.innerText);
  await page.click('#acaoConversa');
  await page.waitForURL(`${base}/`, { timeout: 8000 }).catch(() => {});
  const conv = await page.evaluate(() => JSON.parse(localStorage.getItem('webchat.conversa.v1') || 'null'));
  const acao = estado.corpos.app_pedido_acao[0];
  await ctx.close();
  return { ok: /conversa deste pedido/.test(oferta) && acao.p_acao === 'conversa' && acao.p_conversa === C2 && conv && conv.id === C2 && conv.token === 'tok-secreto' && conv.tipo === 'filho' && conv.nomeCrianca === 'Leo Souza Teste', detalhe: `${JSON.stringify(acao)} ${JSON.stringify(conv)}` };
});
await caso('Cancelar e Remarcar só aparecem para exame marcado/confirmado e pedem confirmação; cancelar chama a ação "cancelar" com o exame certo', async () => {
  const { page, ctx, estado } = await abrirPortal();
  await page.locator('.cartao.pedido', { hasText: 'JOELHO' }).click();
  const botoes = await page.$$eval('.folha button', (bs) => bs.map((b) => b.textContent.trim()));
  let confirmou = null; page.removeAllListeners('dialog'); page.on('dialog', (d) => { confirmou = d.message(); d.accept(); });
  await page.locator('.folha button', { hasText: 'Cancelar:' }).click();
  await page.waitForURL(`${base}/`, { timeout: 8000 }).catch(() => {});
  const acao = estado.corpos.app_pedido_acao[0];
  await ctx.close();
  return { ok: botoes.some((b) => /Remarcar:/.test(b)) && botoes.some((b) => /Cancelar:/.test(b)) && /confirmar o cancelamento/.test(confirmou || '') && acao.p_acao === 'cancelar' && acao.p_exame === 11 && acao.p_conversa === C1, detalhe: JSON.stringify({ botoes, confirmou, acao }) };
});
await caso('exame já feito: sem cancelar/remarcar; com resultado disponível o botão é "Pedir meu resultado" (ação "resultado" com o exame)', async () => {
  const { page, ctx, estado } = await abrirPortal();
  const aviso = await page.locator('.cartao.pedido', { hasText: 'LOMBAR' }).innerText();
  await page.locator('.cartao.pedido', { hasText: 'LOMBAR' }).click();
  const botoes = await page.$$eval('.folha button', (bs) => bs.map((b) => b.textContent.trim()));
  await page.locator('.folha button', { hasText: 'Pedir meu resultado' }).click();
  await page.waitForURL(`${base}/`, { timeout: 8000 }).catch(() => {});
  const acao = estado.corpos.app_pedido_acao[0];
  await ctx.close();
  return { ok: /resultado está disponível/.test(aviso) && !botoes.some((b) => /Cancelar:|Remarcar:/.test(b)) && acao.p_acao === 'resultado' && acao.p_exame === 13, detalhe: JSON.stringify({ botoes, acao }) };
});
await caso('resultados entregues ficam guardados à parte; "Ver o resultado" baixa o arquivo do banco', async () => {
  const { page, ctx, estado } = await abrirPortal();
  const t = await page.$eval('#resultados', (n) => n.innerText);
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null), page.click('#resultados button:has-text("Ver o resultado")')]);
  await espera(300);
  const chamada = (estado.corpos.app_resultado_arquivo || [])[0];
  await ctx.close();
  return { ok: /Resultados guardados/.test(t) && /Leo/.test(t) && !!chamada && chamada.p_id === 'r1' && chamada.p_token === DEV && !!popup, detalhe: `${JSON.stringify(chamada)} popup=${!!popup}` };
});
await caso('check-in de um toque: usa nome, e-mail e celular do cadastro (nada digitado) e já abre a fila', async () => {
  const { page, ctx, estado } = await abrirPortal();
  await page.click('#btnCheckinApp');
  await espera(900);
  const t = await textoDe(page);
  const c = estado.checkin;
  await ctx.close();
  return { ok: !!c && c.p_nome === 'Ana Souza Teste' && c.p_email === 'ana@exemplo.invalid' && c.p_telefone === '71991230001' && /Você está na fila|3º/.test(t) && /Acompanhe seus pedidos/.test(t), detalhe: `${JSON.stringify(c)} :: ${t.slice(0, 120).replace(/\n/g, ' | ')}` };
});
await caso('check-in sem e-mail no cadastro: pergunta só o e-mail, uma vez', async () => {
  const { page, ctx, estado } = await abrirPortal({ perfilResp: perfil({ email: null }) });
  await page.click('#btnCheckinApp');
  await page.waitForSelector('#ceApp', { timeout: 4000 });
  await page.fill('#ceApp', 'nova@exemplo.invalid');
  await page.click('.folha button:has-text("Fazer check-in")');
  await espera(900);
  const c = estado.checkin;
  await ctx.close();
  return { ok: !!c && c.p_email === 'nova@exemplo.invalid' };
});
await caso('PIN vencido (30 min): o portal pede o PIN em vez de mostrar dado; PIN errado avisa; PIN certo abre os pedidos', async () => {
  const { page, ctx, estado } = await abrirPortal({ bloqueado: true });
  const pedeu = await page.$$eval('.pin-teclas button[data-tecla]', (bs) => bs.length);
  const antes = await textoDe(page);
  for (const d of '1111') await page.click(`.pin-teclas [data-tecla="${d}"]`);
  await espera(600);
  const errado = await textoDe(page);
  for (const d of '1357') await page.click(`.pin-teclas [data-tecla="${d}"]`);
  await espera(900);
  const depois = await textoDe(page);
  await ctx.close();
  return { ok: pedeu === 10 && !/RM JOELHO|Ressonância/i.test(antes) && /PIN incorreto/.test(errado) && /Acompanhe seus pedidos/.test(depois) && (estado.corpos.app_desbloquear || []).length === 2, detalhe: `${pedeu} ${errado.slice(0, 80).replace(/\n/g, '|')}` };
});
await caso('atualiza sozinho: um pedido que muda no banco aparece na tela sem recarregar, e a recarga NÃO estende o PIN (p_renova = false)', async () => {
  const { page, ctx, estado } = await abrirPortal();
  estado.dados = JSON.parse(JSON.stringify(estado.dados)); estado.dados.pedidos[0].exames[0].ok = 3; estado.dados.pedidos[0].novo = true; estado.dados.novidades = 2;
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await espera(900);
  const t = await textoDe(page);
  const recargas = (estado.corpos.app_pedidos || []).slice(1);
  await ctx.close();
  return { ok: (t.match(/Falta só você chegar/g) || []).length === 2 && recargas.length >= 1 && recargas.every((x) => x.p_renova === false), detalhe: `${(t.match(/Falta só você chegar/g) || []).length} ${JSON.stringify(recargas.map((x) => x.p_renova))}` };
});
await caso('sem acesso rápido neste aparelho: o portal mostra o check-in de sempre e um convite para criar o acesso rápido', async () => {
  const { page, ctx, estado } = await abrirPortal({ dev: false });
  const t = await textoDe(page);
  const link = await page.$eval('#conviteAcesso a', (a) => a.getAttribute('href'));
  await ctx.close();
  return { ok: /Chegou na clínica/.test(t) && /Acompanhe seus pedidos/.test(t) && /voltar=acompanhar/.test(link) && !(estado.rpcs || []).includes('app_pedidos'), detalhe: link };
});
await caso('código do aparelho desconhecido pelo servidor: some do aparelho e cai no check-in comum', async () => {
  const { page, ctx } = await abrirPortal({ dados: { ok: false, erro: 'sessao', mensagem: 'Entre de novo.' } });
  const guardado = await page.evaluate(() => localStorage.getItem('csi_acesso_v2'));
  const t = await textoDe(page);
  await ctx.close();
  return { ok: guardado === null && /Chegou na clínica/.test(t) };
});

// ======================================================= 3) pedidos encerrados pelo painel: motivo, avaliar, reabrir, apagar
const enc = (extra = {}) => ({ conversa: C1, pessoa: 'Ana Souza Teste', eu: true, aberta: false, status: 'encerrada', tipo: 'exame', exames: [{ id: 11, nome: 'RM JOELHO DIREITO', unidade: 'Centro', data: dia(6), hora: '08:40', ok: 2, excecao: null, resultado: null }],
  sig: 'a', novo: false, encerrada_em: new Date(Date.now() - 2 * 86400000).toISOString(), motivo: 'agendado', origem: 'equipe', apaga_em: new Date(Date.now() + 28 * 86400000).toISOString(), proxima: dia(6),
  pode_reabrir: true, pode_avaliar: true, avaliou: false, pode_apagar: true, cancela_ao_apagar: false, reservado: true, ...extra });
const aberto = (extra = {}) => ({ ...enc({ conversa: C2, pessoa: 'Leo Souza Teste', eu: false, aberta: true, status: 'em_atendimento', encerrada_em: null, motivo: null, origem: null, apaga_em: null, pode_reabrir: false, pode_avaliar: false, pode_apagar: false, reservado: true }), ...extra });
const dadosEnc = (pedidos) => ({ ...dadosPadrao(), pedidos, novidades: 0, resultados: [] });

await caso('encerrada no painel: o cartão mostra "Encerrado", o MOTIVO, o dia e quando some sozinha; avisos e botões à vista (avaliar, reabrir, apagar)', async () => {
  const { page, ctx, erros } = await abrirPortal({ dados: dadosEnc([enc()]) });
  const t = await page.locator('.cartao.pedido').innerText();
  const botoes = await page.$$eval('.cartao.pedido .enc-acoes button', (bs) => bs.map((b) => b.textContent.trim()));
  await ctx.close();
  return { ok: /Encerrado/.test(t) && /Atendimento encerrado em \d\d\/\d\d\./.test(t) && /Motivo: Seu horário foi agendado\./.test(t) && /some da sua lista em \d\d\/\d\d/.test(t)
    && botoes.length === 3 && /Avaliar/.test(botoes[0]) && /Reabrir/.test(botoes[1]) && /Apagar/.test(botoes[2]) && erros.length === 0, detalhe: JSON.stringify({ botoes, t: t.slice(0, 260).replace(/\n+/g, ' | ') }) };
});
await caso('cada motivo vira uma frase simples; encerrado automaticamente avisa; "já avaliou" some o botão Avaliar', async () => {
  const motivos = { apenas_informacoes: /Você pediu só informações/, desistiu: /Pedido cancelado/, nao_respondido: /Ficamos sem resposta \(encerrado automaticamente\)/, outro: /Atendimento concluído/ };
  const lista = [enc({ motivo: 'apenas_informacoes' }), enc({ conversa: C2, motivo: 'desistiu' }), enc({ conversa: C3, motivo: 'nao_respondido', origem: 'inatividade' }), enc({ conversa: C9, motivo: 'outro', pode_avaliar: false, avaliou: true })];
  const { page, ctx } = await abrirPortal({ dados: dadosEnc(lista) });
  const ts = await page.$$eval('.cartao.pedido', (ns) => ns.map((n) => n.innerText));
  await ctx.close();
  const ok = Object.values(motivos).every((re, i) => re.test(ts[i])) && /Você já avaliou/.test(ts[3]) && !/Avaliar o atendimento/.test(ts[3]);
  return { ok, detalhe: ts.map((x) => x.replace(/\n+/g, ' ').slice(40, 130)).join(' || ') };
});
await caso('conversa encerrada sem horário marcado não diz "estamos organizando o horário"', async () => {
  const lista = [enc({ exames: [{ id: null, nome: 'RM COLUNA', unidade: null, data: null, hora: null, ok: 1, excecao: null, resultado: null }], pode_apagar: true, reservado: false })];
  const { page, ctx } = await abrirPortal({ dados: dadosEnc(lista) });
  const t = await page.locator('.cartao.pedido').innerText();
  await ctx.close();
  return { ok: /Sem horário marcado/.test(t) && !/organizando o horário/.test(t) && !/em andamento/.test(t), detalhe: t.slice(0, 160).replace(/\n+/g, ' | ') };
});
await caso('conversa aberta (equipe atendendo) não mostra encerramento, avaliar nem reabrir', async () => {
  const { page, ctx } = await abrirPortal({ dados: dadosEnc([aberto()]) });
  const t = await page.locator('.cartao.pedido').innerText();
  await ctx.close();
  return { ok: !/Encerrado|encerrado|Avaliar|Reabrir|Apagar/.test(t) && /Exame marcado/.test(t), detalhe: t.replace(/\n+/g, ' | ').slice(0, 200) };
});
await caso('conversa sem exame, aberta com a equipe: aparece como "Conversa com a clínica"', async () => {
  const { page, ctx } = await abrirPortal({ dados: dadosEnc([aberto({ exames: [], tipo: null })]) });
  const t = await page.locator('.cartao.pedido').innerText();
  await ctx.close();
  return { ok: /Conversa com a clínica|Leo/.test(t) && /A equipe está atendendo você/.test(t), detalhe: t.replace(/\n+/g, ' | ').slice(0, 200) };
});
await caso('Avaliar: abre o formulário (duas notas de 0 a 10 e o canal), exige tudo, envia ao banco e agradece; o botão some depois', async () => {
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([enc()]) });
  await page.click('.cartao.pedido [data-acao="avaliar"]');
  const abriu = await page.$$eval('.folha .aval-nota', (ns) => ns.length);
  const abriuFolhaDoPedido = await page.$$eval('#acaoConversa', (ns) => ns.length);   // o clique do botão não abre também a folha do pedido
  await page.click('.folha button[type="submit"]');
  const faltou = await page.$eval('.folha .erro', (n) => n.textContent);
  await page.locator('.folha fieldset', { hasText: 'seu atendimento' }).locator('label', { hasText: /^9$/ }).click();
  await page.locator('.folha fieldset', { hasText: 'nosso site' }).locator('label', { hasText: /^10$/ }).click();
  await page.locator('.folha label', { hasText: 'Instagram' }).click();
  estado.dados = dadosEnc([enc({ pode_avaliar: false, avaliou: true })]);   // o banco passa a dizer que já avaliou
  await page.click('.folha button[type="submit"]');
  await espera(900);
  const msg = await page.$eval('#avisoTela', (n) => n.textContent).catch(() => '');
  const t = await page.locator('.cartao.pedido').innerText();
  const c = (estado.corpos.app_pedido_avaliar || [])[0];
  await ctx.close();
  return { ok: abriu === 22 && abriuFolhaDoPedido === 0 && /Escolha uma nota/.test(faltou) && c.p_conversa === C1 && c.p_nota_atendimento === 9 && c.p_nota_site === 10 && c.p_canal === 'Instagram' && c.p_token === DEV
    && /Obrigado pela sua avaliação/.test(msg) && /Você já avaliou/.test(t) && !/Avaliar o atendimento/.test(t), detalhe: JSON.stringify({ abriu, faltou, c, msg }) };
});
await caso('Avaliar: se o banco recusar, a mensagem aparece e as notas continuam na tela', async () => {
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([enc()]) });
  estado.avaliar = () => ({ ok: false, erro: 'avaliar', mensagem: 'Só é possível avaliar depois do encerramento do atendimento.' });
  await page.click('.cartao.pedido [data-acao="avaliar"]');
  await page.locator('.folha fieldset', { hasText: 'seu atendimento' }).locator('label', { hasText: /^7$/ }).click();
  await page.locator('.folha fieldset', { hasText: 'nosso site' }).locator('label', { hasText: /^8$/ }).click();
  await page.locator('.folha label', { hasText: 'Google' }).click();
  await page.click('.folha button[type="submit"]');
  await espera(600);
  const msg = await page.$eval('.folha .erro', (n) => n.textContent);
  const marcada = await page.$$eval('.folha input:checked', (ns) => ns.length);
  await ctx.close();
  return { ok: /depois do encerramento/.test(msg) && marcada === 3, detalhe: `${msg} ${marcada}` };
});
await caso('Reabrir: chama o banco, grava o código da conversa no aparelho e abre o chat nela', async () => {
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([enc()]) });
  await page.click('.cartao.pedido [data-acao="reabrir"]');
  await page.waitForURL(`${base}/`, { timeout: 8000 }).catch(() => {});
  const conv = await page.evaluate(() => JSON.parse(localStorage.getItem('webchat.conversa.v1') || 'null'));
  const c = (estado.corpos.app_pedido_reabrir || [])[0];
  await ctx.close();
  return { ok: c && c.p_conversa === C1 && c.p_token === DEV && conv && conv.id === C1 && conv.token === 'tok-reaberto', detalhe: JSON.stringify({ c, conv }) };
});
await caso('Reabrir recusado (prazo): fica na tela, mostra o motivo e não troca de página', async () => {
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([enc()]) });
  estado.reabrir = () => ({ ok: false, erro: 'prazo', mensagem: 'Já passou o prazo para reabrir. Abra uma conversa nova pelo chat.' });
  await page.click('.cartao.pedido [data-acao="reabrir"]');
  await espera(600);
  const msg = await page.$eval('#avisoTela', (n) => n.textContent).catch(() => '');
  const url = page.url();
  await ctx.close();
  return { ok: /prazo/.test(msg) && /minha-vez/.test(url), detalhe: `${msg} ${url}` };
});
await caso('Apagar (encerrada): confirma, chama o banco, a lista recarrega sem o pedido e a conversa sai da memória do chat neste aparelho', async () => {
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([enc(), enc({ conversa: C3, motivo: 'outro', pode_avaliar: false })]) });
  await page.evaluate((c) => { localStorage.setItem('webchat.historico.v1', JSON.stringify([{ id: c, token: 'x', tipo: 'proprio' }, { id: 'outra', token: 'y', tipo: 'proprio' }])); localStorage.setItem('webchat.conversa.v1', JSON.stringify({ id: c, token: 'x', tipo: 'proprio' })); }, C1);
  let pergunta = ''; page.removeAllListeners('dialog'); page.on('dialog', (d) => { pergunta = d.message(); d.accept(); });
  estado.apagar = () => { estado.dados = dadosEnc([enc({ conversa: C3, motivo: 'outro', pode_avaliar: false })]); return { ok: true, cancelado: false }; };
  await page.locator('.cartao.pedido').first().locator('[data-acao="apagar"]').click();
  await espera(900);
  const n = await page.$$eval('.cartao.pedido', (ns) => ns.length);
  const msg = await page.$eval('#avisoTela', (x) => x.textContent).catch(() => '');
  const mem = await page.evaluate(() => ({ h: JSON.parse(localStorage.getItem('webchat.historico.v1') || '[]').map((x) => x.id), c: localStorage.getItem('webchat.conversa.v1') }));
  const c = (estado.corpos.app_pedido_apagar || [])[0];
  await ctx.close();
  return { ok: /ainda tem exame marcado|continua marcado/.test(pergunta) && c.p_conversa === C1 && n === 1 && /apagado da sua lista/i.test(msg) && mem.h.join() === 'outra' && mem.c === null, detalhe: JSON.stringify({ pergunta, n, msg, mem }) };
});
await caso('Apagar: "Não" na confirmação não chama o banco', async () => {
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([enc()]) });
  page.removeAllListeners('dialog'); page.on('dialog', (d) => d.dismiss());
  await page.click('.cartao.pedido [data-acao="apagar"]');
  await espera(400);
  await ctx.close();
  return { ok: !(estado.corpos.app_pedido_apagar || []).length };
});
await caso('Pedido aberto SEM exame marcado: pela folha, "Cancelar e apagar este pedido" avisa que a clínica será avisada; com exame marcado a opção não existe e o texto explica', async () => {
  const semExame = aberto({ conversa: C2, exames: [{ id: null, nome: 'RM COLUNA', unidade: null, data: null, hora: null, ok: 1, excecao: null, resultado: null }], pode_apagar: true, cancela_ao_apagar: true, reservado: false });
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([semExame, aberto({ conversa: C3 })]) });
  await page.locator('.cartao.pedido').first().click();
  const textoBotao = await page.$eval('#acaoApagar', (b) => b.textContent.trim());
  let pergunta = ''; page.removeAllListeners('dialog'); page.on('dialog', (d) => { pergunta = d.message(); d.accept(); });
  estado.apagar = () => { estado.dados = dadosEnc([aberto({ conversa: C3 })]); return { ok: true, cancelado: true }; };
  await page.click('#acaoApagar');
  await espera(900);
  const msg = await page.$eval('#avisoTela', (x) => x.textContent).catch(() => '');
  await page.locator('.cartao.pedido').first().click();
  const sem = await page.$$eval('#acaoApagar', (ns) => ns.length);
  const dica = await page.$eval('.folha', (n) => n.innerText);
  await ctx.close();
  return { ok: /Cancelar e apagar/.test(textoBotao) && /A clínica será avisada/.test(pergunta) && /cancelado e apagado/i.test(msg) && sem === 0 && /cancele primeiro o exame marcado/i.test(dica), detalhe: JSON.stringify({ textoBotao, pergunta, msg, sem }) };
});
await caso('Apagar recusado pelo banco (exame marcado): mostra a explicação do banco e o pedido continua na lista', async () => {
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([enc()]) });
  estado.apagar = () => ({ ok: false, erro: 'ativo', mensagem: 'Este pedido tem exame marcado. Cancele o exame primeiro.' });
  await page.click('.cartao.pedido [data-acao="apagar"]');
  await espera(600);
  const msg = await page.$eval('#avisoTela', (x) => x.textContent).catch(() => '');
  const n = await page.$$eval('.cartao.pedido', (ns) => ns.length);
  await ctx.close();
  return { ok: /Cancele o exame primeiro/.test(msg) && n === 1, detalhe: `${msg} ${n}` };
});
await caso('PIN vencido durante apagar/reabrir/avaliar: volta para a tela do PIN, sem mostrar dados', async () => {
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([enc()]) });
  estado.apagar = () => ({ ok: false, erro: 'bloqueado' });
  await page.click('.cartao.pedido [data-acao="apagar"]');
  await espera(700);
  const pedeu = await page.$$eval('.pin-teclas button[data-tecla]', (bs) => bs.length);
  await ctx.close();
  return { ok: pedeu === 10 };
});
await caso('a ordem que o banco manda é a que a tela mostra (o dia mais perto primeiro, encerradas no fim)', async () => {
  const lista = [aberto({ conversa: C2, exames: [{ id: 1, nome: 'EX PERTO', unidade: 'Centro', data: dia(1), hora: '08:00', ok: 2, excecao: null, resultado: null }] }),
                 aberto({ conversa: C3, exames: [{ id: 2, nome: 'EX LONGE', unidade: 'Centro', data: dia(9), hora: '08:00', ok: 2, excecao: null, resultado: null }] }),
                 enc({ exames: [{ id: 3, nome: 'EX ENCERRADO', unidade: 'Centro', data: dia(4), hora: '08:00', ok: 2, excecao: null, resultado: null }] })];
  const { page, ctx } = await abrirPortal({ dados: dadosEnc(lista) });
  const ts = await page.$$eval('.cartao.pedido', (ns) => ns.map((n) => /EX (PERTO|LONGE|ENCERRADO)/i.exec(n.innerText)?.[0].toUpperCase()));
  await ctx.close();
  return { ok: ts.join() === 'EX PERTO,EX LONGE,EX ENCERRADO', detalhe: ts.join() };
});
await caso('o painel encerra enquanto a tela está aberta: na próxima atualização o cartão passa a "Encerrado" com o motivo', async () => {
  const { page, ctx, estado } = await abrirPortal({ dados: dadosEnc([aberto({ conversa: C1 })]) });
  const antes = await page.locator('.cartao.pedido').innerText();
  estado.dados = dadosEnc([enc({ motivo: 'apenas_informacoes', novo: true })]);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await espera(900);
  const depois = await page.locator('.cartao.pedido').innerText();
  await ctx.close();
  return { ok: !/Encerrado/.test(antes) && /Encerrado/.test(depois) && /Você pediu só informações/.test(depois) && /Novidade/.test(depois) && /Avaliar/.test(depois), detalhe: depois.replace(/\n+/g, ' | ').slice(0, 200) };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} casos passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
