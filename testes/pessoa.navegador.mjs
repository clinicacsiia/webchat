// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com conversas da mesma pessoa, exame em aberto, falta e cartões da Jornada) -> validação (sem o SQL novo no banco, o painel funciona como antes) -> lógica (uma linha por pessoa; mensagens juntas; resposta vai para a conversa mais recente; sugestão pede confirmação; exame em aberto trava o Encerrar e pode ser fechado ou perguntado ao paciente; falta pede remarcação pelo chat; Jornada mostra um cartão por paciente) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
//
// Não substitui o teste com o Supabase real: as funções do banco são simuladas aqui (o banco tem teste próprio: sql-pessoa.test.mjs).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const EU = { id: '11111111-1111-4111-8111-111111111111', nome: 'Atendente de Teste', email: 'a@teste.local', papel: 'atendente', ativo: true };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const iso = (minAtras) => new Date(Date.now() - minAtras * 60000).toISOString();

const conversa = (id, nome, status, min, extra = {}) => ({ id, status, agente_id: status === 'em_atendimento' ? EU.id : null, ultima_mensagem: 'oi ' + id, nao_lidas_agente: 0, criado_em: iso(min + 5), atualizado_em: iso(min), contato_id: 'ct-' + id,
  ia_ativa: false, motor: 'fluxo', triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null,
  contatos: { id: 'ct-' + id, nome, telefone: '71900000000', email: null }, ...extra });
// Maria tem 2 conversas (uma antiga com exame em aberto e uma de agora); Carlos tem 2 conversas só com 2 informações (sugestão); Davi é outra pessoa.
const CONVERSAS = [conversa('m2', 'Maria Souza', 'aguardando', 1, { nao_lidas_agente: 1 }), conversa('m1', 'Maria Souza', 'em_atendimento', 300), conversa('k1', 'Carlos Lima', 'aguardando', 10),
  conversa('k2', 'Carlos Lima', 'aguardando', 20), conversa('d1', 'Davi Prado', 'aguardando', 30), conversa('f1', 'Fátima Reis', 'em_atendimento', 40)];
const GRUPOS = [{ conversa_id: 'm1', grupo_id: 'G1', sinais: ['nome', 'telefone', 'email'], origem: 'auto', confirmado_por: null }, { conversa_id: 'm2', grupo_id: 'G1', sinais: ['nome', 'telefone', 'email'], origem: 'auto', confirmado_por: null }];
const SUGESTOES = [{ a: 'k1', b: 'k2', nome_a: 'Carlos Lima', nome_b: 'Carlos Lima', sinais: ['nome', 'telefone'], total: 2 }];
const ABERTOS = [{ pre_id: 'p1', conversa_id: 'm1', chave: 'p1|2026-10-30T09:00', quando: '2026-10-30T09:00:00', exames: 'RESSONANCIA DO JOELHO', passou: true }];
const REMARCAR = [{ fechamento_id: 7, conversa_id: 'f1', exames: 'ULTRASSOM ABDOME', quando: '2026-10-29T08:00:00', desfecho: 'faltou', remarcacao: 'pendente' }];
const MENSAGENS = {
  m1: [{ id: 1, conversa_id: 'm1', autor: 'cliente', agente_id: null, texto: 'mensagem antiga da Maria', criado_em: iso(300), opcoes: null }],
  m2: [{ id: 2, conversa_id: 'm2', autor: 'cliente', agente_id: null, texto: 'mensagem nova da Maria', criado_em: iso(1), opcoes: null }],
};
const COLUNAS = [['contato', 'Em conversa no chat', 1, 'manual', 'antes'], ['agendado', 'Agendado (veio do chat)', 4, 'klingo', 'antes'], ['a_confirmar', 'A confirmar', 5, 'klingo', 'agendamento'], ['faltou', 'Faltou', 22, 'klingo', 'excecao']]
  .map(([id, nome, ordem, origem, etapa]) => ({ id, nome, ordem, origem, etapa, sla_min: null }));
const card = (id, conv, nome, coluna, extra = {}) => ({ id, paciente_nome: nome, paciente_chave: 'conv:' + id, coluna, coluna_nome: COLUNAS.find((c) => c.id === coluna).nome, etapa: 'antes', origem: 'manual', ordem: 1, data_ref: '2026-11-01', unidade: 'CSI 1', coluna_desde: iso(30),
  responsavel: null, prioridade: 0, versao: 1, conversa_id: conv, primeiro_exame: 'Ressonância de joelho', n_ativos: 1, atrasado: false, n_tarefas_abertas: 0, n_tarefas_vencidas: 0, proxima_hora: null, ...extra });
const CARTOES_CHAT = [card(1, 'm1', 'Maria Souza', 'agendado'), card(2, 'm2', 'Maria Souza', 'contato'), card(3, 'd1', 'Davi Prado', 'contato')];
const CARTOES_J = [card(10, null, 'Olga Ramos', 'faltou', { paciente_chave: 'P104', data_ref: '2026-10-30', primeiro_exame: 'Ultrassom abdome', origem: 'klingo' }),
  card(11, null, 'Olga Ramos', 'a_confirmar', { paciente_chave: 'P104', data_ref: '2026-11-03', primeiro_exame: 'Ressonância de joelho', origem: 'klingo' }),
  card(12, null, 'Nara Costa', 'a_confirmar', { paciente_chave: 'P103', data_ref: '2026-11-01', origem: 'klingo' }),
  card(13, null, 'Sem Chat', 'faltou', { paciente_chave: 'P105', data_ref: '2026-10-30', origem: 'klingo' })];
const PESSOAS_J = [{ card_id: 10, pessoa: 'g:G9', conversa_id: 'f1', sugestao: null }, { card_id: 11, pessoa: 'g:G9', conversa_id: 'f1', sugestao: null },
  { card_id: 12, pessoa: 'k:P103', conversa_id: null, sugestao: 'k1' }, { card_id: 13, pessoa: 'k:P105', conversa_id: null, sugestao: null }];

const jwt = (sub) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.x`; };

function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      let c = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let a = join(RAIZ, c); if (existsSync(a) && !extname(a)) a = join(a, 'index.html');
      if (!existsSync(a)) { res.writeHead(404); res.end('x'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(a)] ?? 'application/octet-stream' }); res.end(await readFile(a));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}

// semSql = o banco ainda não recebeu supabase/pessoa-unica.sql (tabela, views e funções novas respondem 404).
async function pagina(browser, { semSql = false, perguntaCanal = 'botoes' } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.modo'); localStorage.removeItem('painel.jagrupar'); } catch {}
  }, [EU.id, jwt(EU.id), EU.email]);
  const reg = { excecoes: [], pedidos: [], rpcs: [], posts: [], patches: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => reg.excecoes.push(e.message));
  page.on('dialog', (d) => d.accept());
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: require('node:fs').readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url()); const p = url.pathname;
    const objeto = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    reg.pedidos.push(req.method() + ' ' + p + url.search);
    let corpo; let status = 200;
    const nao = () => { status = 404; corpo = { message: 'relation does not exist' }; };
    if (p.startsWith('/auth/v1/user')) corpo = { id: EU.id, aud: 'authenticated', role: 'authenticated', email: EU.email };
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? EU : [EU]) : [EU];
    else if (p.startsWith('/rest/v1/conversas')) {
      if (req.method() === 'PATCH') { reg.patches.push({ url: p + url.search, corpo: JSON.parse(req.postData() || '{}') }); corpo = []; } else corpo = CONVERSAS;
    }
    else if (p.startsWith('/rest/v1/mensagens')) {
      if (req.method() === 'POST') { const b = JSON.parse(req.postData() || '{}'); reg.posts.push(b); corpo = { id: 99, criado_em: new Date().toISOString(), agente_id: EU.id, opcoes: null, ...b }; }
      else { const m = /conversa_id=(?:eq\.|in\.\()([^&]+)/.exec(decodeURIComponent(url.search)); const ids = m ? m[1].replace(/\)$/, '').split(',') : []; corpo = ids.flatMap((i) => MENSAGENS[i] || []); }
    }
    else if (p.startsWith('/rest/v1/conversa_grupo')) { if (semSql) nao(); else corpo = GRUPOS; }
    else if (p.startsWith('/rest/v1/v_agendamento_aberto')) { if (semSql) nao(); else corpo = ABERTOS; }
    else if (p.startsWith('/rest/v1/v_remarcacao_pendente')) { if (semSql) nao(); else corpo = REMARCAR; }
    else if (p.endsWith('/rpc/pessoa_sugestoes')) { if (semSql) nao(); else corpo = SUGESTOES; }
    else if (p.endsWith('/rpc/pessoa_avisos_data')) { if (semSql) nao(); else corpo = [{ nome: 'Rita Alves', nasc_a: '1997-05-11', nasc_b: '1996-05-11', parecida: true, ids_a: ['r1'], ids_b: ['r2'] }]; }
    else if (p.endsWith('/rpc/paciente_avisos')) { if (semSql) nao(); else corpo = [{ id: 5, conversa_id: 'r1', tipo: 'klingo_ligado', detalhe: { prontuario: 'P9' }, nome: 'Rita Alves' }, { id: 6, conversa_id: 'r1', tipo: 'dado_diferente', detalhe: { paciente_id: 'x', campos: { email: { cadastro: 'a@a.com', novo: 'b@b.com' } } }, nome: 'Rita Alves' }]; }
    else if (p.endsWith('/rpc/pessoa_corrigir_data') || p.endsWith('/rpc/pessoa_manter_separado') || p.endsWith('/rpc/paciente_aviso_resolver')) { reg.rpcs.push({ rpc: p.split('/').pop(), ...JSON.parse(req.postData() || '{}') }); corpo = { ok: true }; }
    else if (p.endsWith('/rpc/paciente_linha_do_tempo')) { if (semSql) nao(); else corpo = [{ conversa_id: 'm1', exames: 'Ressonância de joelho', status: 'faltou', quando: '2026-11-01T10:00:00', passo: 'Faltou' }, { conversa_id: 'm2', exames: 'Ultrassom de abdome', status: 'pronto', quando: null, passo: 'Pronto' }]; }
    else if (p.endsWith('/rpc/paciente_klingo')) { if (semSql) nao(); else corpo = { pacientes: [{ prontuario: 'P77', nome: 'MARIA SOUZA' }], exames: [{ exame: 'TOMOGRAFIA DE CRÂNIO', status: 'atendido', quando: '2026-10-31T09:00:00', unidade: 'Brotas' }, { exame: 'RM DE JOELHO', status: 'confirmado', quando: '2026-11-04T08:00:00', unidade: 'Brotas' }] }; }
    else if (p.endsWith('/rpc/jornada_pessoas')) { if (semSql) nao(); else corpo = PESSOAS_J; }
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = COLUNAS;
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = [];
    else if (p.startsWith('/rest/v1/jornada_sync_estado')) corpo = objeto ? { klingo_em: new Date().toISOString(), vigia_em: new Date().toISOString(), klingo_erro: null, klingo_falhas: 0, vigia_erro: null } : [];
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) {
      const conversaSo = /conversa_id=not\.is\.null/.test(decodeURIComponent(url.search));
      corpo = conversaSo ? CARTOES_CHAT : [...CARTOES_CHAT, ...CARTOES_J];
    }
    else if (/\/rpc\/(pessoa_confirmar|pessoa_recusar|pessoa_separar|agendamento_fechar|agendamento_remarcacao_resolver|pessoa_klingo_confirmar|pessoa_klingo_desfazer|jornada_remarcar_pelo_chat)$/.test(p)) {
      reg.rpcs.push({ rpc: p.split('/').pop(), ...JSON.parse(req.postData() || '{}') }); corpo = { ok: true, canal: perguntaCanal };
    }
    else if (p.endsWith('/rpc/agendamento_perguntar')) { reg.rpcs.push({ rpc: 'agendamento_perguntar', ...JSON.parse(req.postData() || '{}') }); corpo = { ok: true, canal: perguntaCanal }; }
    else if (p.startsWith('/rest/v1/rpc/')) corpo = {};
    else if (p.startsWith('/rest/v1/')) corpo = objeto ? null : [];
    else corpo = {};
    return rota.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());
  return { page, ctx, reg };
}

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const abrir = async (opcoes) => { const t = await pagina(browser, opcoes); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('.modo', { timeout: 10000 }); await t.page.waitForTimeout(300); return t; };
const itens = (page) => page.locator('.itens .item .l1 span:first-child').allInnerTexts();
const filtro = async (page, rot) => { await page.click(`#filtros .chip:has-text("${rot}")`); await page.waitForTimeout(100); };

// ----------------------------------------------------------------- Atendimento
await caso('duas conversas da mesma pessoa viram UMA linha na lista, com o aviso de conversas unidas', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  const nomes = await itens(page);
  const maria = await page.locator('.itens .item:has-text("Maria Souza")').innerText();
  await ctx.close();
  return { ok: nomes.filter((n) => n === 'Maria Souza').length === 1 && nomes.length === 5 && /2 conversas unidas/.test(maria) && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? `${nomes.join('|')}` };
});

await caso('a linha mostra "Exame em aberto" e "Remarcar" para quem tem pendência', async () => {
  const { page, ctx } = await abrir();
  await filtro(page, 'Abertas');
  const maria = await page.locator('.itens .item:has-text("Maria Souza")').innerText();
  const fatima = await page.locator('.itens .item:has-text("Fátima Reis")').innerText();
  await ctx.close();
  return { ok: /Exame em aberto/.test(maria) && !/Remarcar/.test(maria) && /Remarcar/.test(fatima), detalhe: '' };
});

await caso('os contadores contam PESSOAS (Aguardando = Maria, as duas conversas de Carlos que ainda não foram unidas e Davi = 4), não conversas', async () => {
  const { page, ctx } = await abrir();
  const rot = await page.locator('#filtros .chip').allInnerTexts();
  await ctx.close();
  return { ok: rot.some((r) => /Aguardando \(4\)/.test(r)) && rot.some((r) => /Abertas \(5\)/.test(r)), detalhe: rot.join('|') };
});

await caso('abrir mostra as mensagens das DUAS conversas, em ordem, com o aviso de "Outra conversa"', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  await page.click('.itens .item:has-text("Maria Souza")');
  await page.waitForSelector('.msg.cliente');
  const textos = await page.locator('#msgs .msg.cliente > span:not(.quem):not(.hora)').allInnerTexts();
  const sep = await page.locator('.msg-outra').count();
  const faixa = await page.locator('#pessoa summary').innerText();
  const pedido = reg.pedidos.find((p) => p.includes('/mensagens') && p.startsWith('GET')) ?? '';
  await ctx.close();
  return { ok: textos.join('|') === 'mensagem antiga da Maria|mensagem nova da Maria' && sep === 1 && /2 conversas da mesma pessoa, unidas/.test(faixa) && /in\./.test(decodeURIComponent(pedido)), detalhe: `${textos}|sep=${sep}|${faixa}` };
});

await caso('a resposta da equipe vai para a conversa onde o paciente escreveu por último (m2), não para a antiga', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  await page.click('.itens .item:has-text("Maria Souza")'); await page.waitForSelector('.msg.cliente');
  await page.fill('#caixa', 'Bom dia, Maria!'); await page.click('#btnEnviar');
  await page.waitForTimeout(600);
  await ctx.close();
  return { ok: reg.posts.length === 1 && reg.posts[0].conversa_id === 'm2' && reg.posts[0].texto === 'Bom dia, Maria!', detalhe: JSON.stringify(reg.posts) };
});

await caso('assumir muda TODAS as conversas da pessoa de uma vez', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  await page.click('.itens .item:has-text("Maria Souza")'); await page.waitForSelector('#chatTopo');
  await page.click('#chatTopo button:has-text("Assumir")'); await page.waitForTimeout(500);
  await ctx.close();
  const p = reg.patches[0];
  return { ok: !!p && /id=in\./.test(decodeURIComponent(p.url)) && /m1/.test(p.url) && /m2/.test(p.url) && p.corpo.status === 'em_atendimento', detalhe: JSON.stringify(reg.patches) };
});

await caso('exame em aberto: aparece na conversa com os 4 desfechos e a pergunta ao paciente; o Encerrar NÃO é barrado (abre a janela do motivo e não grava nada até escolher)', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  await page.click('.itens .item:has-text("Maria Souza")'); await page.waitForSelector('.ex-caixa');
  const caixa = await page.locator('.ex-caixa').first().innerText();
  const botoes = await page.locator('.ex-caixa').first().locator('.ex-acoes button').allInnerTexts();
  await page.waitForTimeout(600);
  const antes = reg.patches.length;
  await page.click('#chatTopo button:has-text("Encerrar")'); await page.waitForTimeout(400);
  const janela = await page.evaluate(() => !!document.getElementById('motivoEnc') && document.getElementById('dlg').open);
  const toast = await page.locator('#toast, .toast').allInnerTexts().catch(() => []);
  await ctx.close();
  return { ok: /Exame em aberto/.test(caixa) && /RESSONANCIA DO JOELHO/.test(caixa) && /30\/10 às 09:00/.test(caixa) && /o horário já passou/.test(caixa)
           && botoes.join('|') === 'Compareceu|Faltou|Cancelou|Remarcou|Perguntar ao paciente pelo chat' && reg.patches.length === antes && !reg.patches.some((x) => x.corpo.status === 'encerrada') && janela && !toast.join(' ').includes('sem desfecho'),
           detalhe: `${botoes.join('|')} patches=${reg.patches.length - antes} toast=${toast.join('|')}` };
});

await caso('fechar o exame chama agendamento_fechar com a conversa e o desfecho', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  await page.click('.itens .item:has-text("Maria Souza")'); await page.waitForSelector('.ex-caixa');
  await page.click('.ex-caixa >> text=Faltou'); await page.waitForTimeout(500);
  await ctx.close();
  const r = reg.rpcs.find((x) => x.rpc === 'agendamento_fechar');
  return { ok: !!r && r.p_conversa === 'm1' && r.p_desfecho === 'faltou', detalhe: JSON.stringify(reg.rpcs) };
});

await caso('"Perguntar ao paciente pelo chat" chama agendamento_perguntar no modo fechar', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  await page.click('.itens .item:has-text("Maria Souza")'); await page.waitForSelector('.ex-caixa');
  await page.click('.ex-caixa >> text=Perguntar ao paciente pelo chat'); await page.waitForTimeout(500);
  await ctx.close();
  const r = reg.rpcs.find((x) => x.rpc === 'agendamento_perguntar');
  return { ok: !!r && r.p_conversa === 'm1' && r.p_modo === 'fechar', detalhe: JSON.stringify(reg.rpcs) };
});

await caso('falta: aparece "Faltou" com o pedido de remarcação pelo chat, "Já remarcado" e "Paciente desistiu"', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  await page.click('.itens .item:has-text("Fátima Reis")'); await page.waitForSelector('.ex-caixa.falta');
  const botoes = await page.locator('.ex-caixa.falta .ex-acoes button').allInnerTexts();
  await page.click('.ex-caixa.falta >> text=Pedir ao paciente que remarque pelo chat'); await page.waitForTimeout(400);
  await page.click('.ex-caixa.falta >> text=Já remarcado'); await page.waitForTimeout(400);
  await ctx.close();
  const a = reg.rpcs.find((x) => x.rpc === 'agendamento_perguntar'), b = reg.rpcs.find((x) => x.rpc === 'agendamento_remarcacao_resolver');
  return { ok: botoes.join('|') === 'Pedir ao paciente que remarque pelo chat|Já remarcado|Paciente desistiu' && a.p_modo === 'remarcar' && a.p_conversa === 'f1' && b.p_fechamento === 7 && b.p_resultado === 'feita', detalhe: JSON.stringify(reg.rpcs) };
});

await caso('sugestão (2 de 3): mostra "Parece a mesma pessoa"; "É a mesma pessoa" chama pessoa_confirmar; "Não é" chama pessoa_recusar', async () => {
  const { page, ctx, reg } = await abrir();
  const barra = await page.locator('#barraAvisos').innerText();           // na lista só fica uma barra curta
  const antes = (await itens(page)).filter((n) => n === 'Carlos Lima').length;
  await page.click('#barraAvisos >> text=Ver avisos'); await page.waitForSelector('#paginaAvisos .sug');   // os avisos ficam na aba Avisos
  const sug = barra + ' ' + await page.locator('#paginaAvisos .sug').first().innerText();
  await page.click('#paginaAvisos .sug >> text=É a mesma pessoa'); await page.waitForTimeout(400);
  await page.click('#paginaAvisos .sug >> text=Não é'); await page.waitForTimeout(400);
  await ctx.close();
  const a = reg.rpcs.find((x) => x.rpc === 'pessoa_confirmar'), b = reg.rpcs.find((x) => x.rpc === 'pessoa_recusar');
  return { ok: /\d+ avisos? pendentes?/.test(sug) && /Parece a mesma pessoa/.test(sug) && /nome e telefone/.test(sug) && antes === 2 && a.p_a === 'k1' && a.p_b === 'k2' && b.p_a === 'k1', detalhe: `${sug.replace(/\n/g, ' ')} | ${JSON.stringify(reg.rpcs)}` };
});

await caso('histórico do paciente: pedidos do chat e exames do Klingo com o passo e o que fazer a seguir (paciente-status.js)', async () => {
  const { page, ctx } = await abrir();
  await filtro(page, 'Abertas'); await page.click('.item >> text=Maria Souza'); await page.waitForSelector('#historicoPaciente details');
  const txt = (await page.locator('#historicoPaciente').innerText()).replace(/\n/g, ' ');
  await ctx.close();
  return { ok: /Histórico do paciente: 2 pedido\(s\) no chat · 2 no Klingo/.test(txt) && /Faltou: Ressonância de joelho/.test(txt) && /Oferecer um novo horário ou registrar que o paciente recusou/.test(txt)
    && /Pedido pronto: Ultrassom de abdome/.test(txt) && /prontuário P77/.test(txt) && /Exame feito: tomografia de crânio/.test(txt) && /Entregar o resultado ao paciente/.test(txt) && /Confirmado: rm de joelho/.test(txt), detalhe: txt.slice(0, 500) };
});

await caso('aba Avisos: data diferente (corrigir e unir / manter separado) e avisos do paciente (Klingo, dado diferente com CPF conferido)', async () => {
  const { page, ctx, reg } = await abrir();
  const selo = await page.locator('#seloAvisos').innerText();
  await page.click('nav.nav button[data-aba="avisos"]'); await page.waitForSelector('#paginaAvisos .sug >> text=Data de nascimento diferente');
  const txt = await page.locator('#paginaAvisos').innerText();
  await page.click('#avisosData button:has-text("11/05/1997")'); await page.waitForTimeout(300);
  await page.click('#avisosData >> text=Manter separado'); await page.waitForTimeout(300);
  await page.click('#avisosPaciente >> text=Atualizar cadastro'); await page.waitForTimeout(300);
  await ctx.close();
  const c = reg.rpcs.find((x) => x.rpc === 'pessoa_corrigir_data'), m = reg.rpcs.find((x) => x.rpc === 'pessoa_manter_separado'), r = reg.rpcs.find((x) => x.rpc === 'paciente_aviso_resolver');
  return { ok: Number(selo) >= 3 && /11\/05\/1997/.test(txt) && /11\/05\/1996/.test(txt) && /Parece erro de digitação/.test(txt) && /ligado ao cadastro do Klingo/.test(txt) && /e-mail: a@a.com → b@b.com/.test(txt)
    && c && c.p_data === '1997-05-11' && JSON.stringify(c.p_ids) === JSON.stringify(['r2']) && m && r && r.p_id === 5 + 1 && r.p_aplicar === true, detalhe: `selo=${selo} ${txt.replace(/\n/g, ' ').slice(0, 300)} | ${JSON.stringify(reg.rpcs)}` };
});

await caso('"Não é a mesma pessoa" na faixa das conversas unidas chama pessoa_separar', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  await page.click('.itens .item:has-text("Maria Souza")'); await page.waitForSelector('.pessoa');
  await page.click('#pessoa summary');
  await page.locator('.pessoa li').first().locator('button').click(); await page.waitForTimeout(400);
  await ctx.close();
  const r = reg.rpcs.find((x) => x.rpc === 'pessoa_separar');
  return { ok: !!r && ['m1', 'm2'].includes(r.p_conversa), detalhe: JSON.stringify(reg.rpcs) };
});

await caso('quadro das conversas: um cartão por pessoa ("+1 da mesma pessoa")', async () => {
  const { page, ctx } = await abrir();
  await page.click('.modo button:has-text("Quadro")'); await page.waitForSelector('.q-col');
  const nomes = await page.locator('.q-card b').allInnerTexts();
  const chip = await page.locator('.q-card:has-text("Maria Souza")').innerText();
  await ctx.close();
  return { ok: nomes.filter((n) => n === 'Maria Souza').length === 1 && /\+1 da mesma pessoa/.test(chip) && /Exame em aberto/.test(chip), detalhe: `${nomes}|${chip.replace(/\n/g, ' ')}` };
});

await caso('próximo passo: a conversa com exame em aberto mostra UMA decisão no alto, e em tela baixa as mensagens ainda têm espaço', async () => {
  const { page, ctx, reg } = await abrir();
  await filtro(page, 'Abertas');
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.click('.itens .item:has-text("Maria Souza")'); await page.waitForSelector('.ex-caixa'); await page.waitForSelector('.proximo');
  const texto = await page.locator('#proximo').innerText();
  const botao = await page.locator('#proximo button').allInnerTexts();
  const alturas = await page.evaluate(() => ({ msgs: document.getElementById('msgs').clientHeight, ctxMax: document.getElementById('contexto').clientHeight, janela: innerHeight }));
  await ctx.close();
  return { ok: botao.length === 1 && texto.length > 10 && alturas.msgs >= 90 && alturas.ctxMax <= alturas.janela * 0.2 && !reg.excecoes.length,
           detalhe: reg.excecoes[0] ?? `${texto.replace(/\n/g, ' / ')} | botão=${botao} | ${JSON.stringify(alturas)}` };
});

await caso('banco SEM o SQL novo: cada conversa continua em sua linha e nada quebra', async () => {
  const { page, ctx, reg } = await abrir({ semSql: true });
  await filtro(page, 'Abertas');
  const nomes = await itens(page);
  await page.click('.itens .item:has-text("Fátima Reis")'); await page.waitForSelector('#chatTopo');
  const semFaixa = (await page.locator('.ex-caixa, .pessoa, .sug').count()) === 0;
  await ctx.close();
  return { ok: nomes.length === 6 && semFaixa && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? nomes.join('|') };
});

// ----------------------------------------------------------------- Jornada
const abrirJornada = async (opcoes) => { const t = await abrir(opcoes); await t.page.click('nav.nav button[data-aba="jornada"]'); await t.page.waitForSelector('.j-status'); await t.page.waitForSelector('.q-col'); await t.page.waitForTimeout(300); return t; };
const cartoesDe = (page) => page.locator('.q-card').evaluateAll((b) => b.map((x) => x.innerText.replace(/\n/g, ' ')));

await caso('Jornada: os cartões da mesma pessoa viram UM (o que pede ação agora) com "+1 da mesma pessoa"', async () => {
  const { page, ctx, reg } = await abrirJornada();
  const lista = await cartoesDe(page);
  const olga = lista.filter((x) => x.startsWith('Olga Ramos'));
  const naColunaFaltou = await page.locator('.q-col[data-coluna="faltou"] .q-card:has-text("Olga Ramos")').count();
  await ctx.close();
  return { ok: olga.length === 1 && /\+1 da mesma pessoa/.test(olga[0]) && naColunaFaltou === 1 && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? olga.join('|') };
});

await caso('Jornada: "Um cartão por paciente" desligado mostra os dois cartões de novo, e a escolha fica guardada', async () => {
  const { page, ctx } = await abrirJornada();
  await page.click('.q-topo .chip:has-text("Um cartão por paciente")'); await page.waitForTimeout(200);
  const lista = await cartoesDe(page);
  const salvo = await page.evaluate(() => localStorage.getItem('painel.jagrupar'));
  await ctx.close();
  return { ok: lista.filter((x) => x.startsWith('Olga Ramos')).length === 2 && salvo === '0', detalhe: `${lista.filter((x) => x.startsWith('Olga')).length} cartões; salvo=${salvo}` };
});

await caso('Jornada: abrir o cartão lista os outros cartões da pessoa e deixa abrir cada um', async () => {
  const { page, ctx } = await abrirJornada();
  await page.click('.q-card:has-text("Olga Ramos")'); await page.waitForSelector('dialog[open] .j-sec');
  const sec = await page.locator('dialog[open] .j-sec:has-text("mais 1 cartão")').innerText();
  await page.click('dialog[open] .j-sec:has-text("mais 1 cartão") button:has-text("Abrir")'); await page.waitForTimeout(500);
  const titulo = await page.locator('dialog[open] h3').innerText();
  const col = await page.locator('dialog[open]').innerText();
  await ctx.close();
  return { ok: /A confirmar/.test(sec) && /Ressonância de joelho/.test(sec) && titulo === 'Olga Ramos' && /A confirmar/.test(col), detalhe: sec.replace(/\n/g, ' ') };
});

await caso('Jornada: falta de quem tem conversa no chat oferece "Pedir ao paciente que remarque pelo chat" e chama jornada_remarcar_pelo_chat', async () => {
  const { page, ctx, reg } = await abrirJornada();
  await page.click('.q-col[data-coluna="faltou"] .q-card:has-text("Olga Ramos")'); await page.waitForSelector('dialog[open] .j-sec:has-text("Faltou: remarcar")');
  await page.click('dialog[open] button:has-text("Pedir ao paciente que remarque pelo chat")'); await page.waitForTimeout(500);
  const botaoConversa = await page.locator('dialog[open] button:has-text("Abrir conversa")').count();
  await ctx.close();
  const r = reg.rpcs.find((x) => x.rpc === 'jornada_remarcar_pelo_chat');
  return { ok: !!r && r.p_card === 10 && botaoConversa === 1, detalhe: JSON.stringify(reg.rpcs) };
});

await caso('Jornada: falta de quem NÃO tem chat manda ligar (não oferece o botão do chat)', async () => {
  const { page, ctx } = await abrirJornada();
  await page.click('.q-col[data-coluna="faltou"] .q-card:has-text("Sem Chat")'); await page.waitForSelector('dialog[open] .j-sec:has-text("Faltou: remarcar")');
  const txt = await page.locator('dialog[open] .j-sec:has-text("Faltou: remarcar")').innerText();
  const tem = await page.locator('dialog[open] button:has-text("Pedir ao paciente que remarque pelo chat")').count();
  await ctx.close();
  return { ok: /Ligue para oferecer a nova data/.test(txt) && tem === 0, detalhe: txt.replace(/\n/g, ' ') };
});

await caso('Jornada: cartão do Klingo com nome + telefone iguais a uma conversa mostra a sugestão e a confirmação chama pessoa_klingo_confirmar', async () => {
  const { page, ctx, reg } = await abrirJornada();
  const chip = await page.locator('.q-card:has-text("Nara Costa")').innerText();
  await page.click('.q-card:has-text("Nara Costa")'); await page.waitForSelector('dialog[open] .j-sec:has-text("Parece a mesma pessoa do chat")');
  await page.click('dialog[open] button:has-text("É a mesma pessoa")'); await page.waitForTimeout(500);
  await ctx.close();
  const r = reg.rpcs.find((x) => x.rpc === 'pessoa_klingo_confirmar');
  return { ok: /Mesma pessoa do chat\?/.test(chip) && !!r && r.p_prontuario === 'P103' && r.p_conversa === 'k1', detalhe: JSON.stringify(reg.rpcs) };
});

await caso('Jornada SEM o SQL novo: um cartão por paciente do jeito antigo, sem o alternador e sem erro', async () => {
  const { page, ctx, reg } = await abrirJornada({ semSql: true });
  const lista = await cartoesDe(page);
  const alternador = await page.locator('.q-topo .chip:has-text("Um cartão por paciente")').count();
  await ctx.close();
  return { ok: lista.filter((x) => x.startsWith('Olga Ramos')).length === 2 && alternador === 0 && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? `${lista.length} cartões` };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
