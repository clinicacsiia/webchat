// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado; conversa com nome e e-mail muito longos) -> validação (mede a altura do topo da conversa em 1280×720, 1366×768 e celular, e o foco e a rolagem) -> lógica (topo compacto sem esconder Assumir/Reabrir/Transferir/Encerrar; informação completa continua acessível) -> saída (PASS/FAIL e altura em px).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-07)
//
// Não substitui o teste com o Supabase real: as funções do banco são simuladas aqui (o banco tem teste próprio).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = process.env.RAIZ_TESTE || resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const EU0 = { id: '11111111-1111-4111-8111-111111111111', nome: 'Atendente de Teste', email: 'a@teste.local', papel: 'atendente', ativo: true };
const OUTRO = { id: '22222222-2222-4222-8222-222222222222', nome: 'Outra Pessoa', email: 'o@teste.local', papel: 'atendente', ativo: true };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const agora = new Date().toISOString();

const conversa = (id, nome, status, agente) => ({ id, status, agente_id: agente, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, contatos: { id: 'ct-' + id, nome, telefone: '71900000000', email: null } });
const LONGO = { nome: 'Maria Aparecida dos Santos Albuquerque de Oliveira Pereira Júnior', email: 'maria.aparecida.albuquerque.oliveira.pereira.junior.com.nome.muito.longo@exemplo-de-dominio-bem-comprido.com.br' };
const CONVERSAS = [conversa('c1', 'Maria Souza', 'aguardando', null), conversa('c2', LONGO.nome, 'em_atendimento', EU0.id), conversa('c3', 'Ana Paula', 'em_atendimento', OUTRO.id)];
const COLUNAS = [['contato', 'Em conversa no chat', 1, 'manual'], ['orcamento', 'Pedido pronto', 2, 'manual'], ['autorizacao', 'Aguardando autorização', 3, 'manual'], ['agendado', 'Agendado (veio do chat)', 4, 'klingo'], ['perdido', 'Perdido', 23, 'manual']]
  .map(([id, nome, ordem, origem]) => ({ id, nome, ordem, origem }));
const TRANS = [['contato', 'orcamento'], ['contato', 'autorizacao'], ['contato', 'perdido'], ['orcamento', 'autorizacao'], ['orcamento', 'perdido'], ['perdido', 'contato']].map(([de, para]) => ({ de, para }));
const card = (id, conv, nome, coluna, extra = {}) => ({ id, paciente_nome: nome, coluna, data_ref: '2026-11-01', unidade: 'CSI 1', coluna_desde: agora, responsavel: null, prioridade: 0, versao: 1, conversa_id: conv,
  primeiro_exame: 'Ressonância de joelho', n_ativos: 1, atrasado: false, n_tarefas_abertas: 0, n_tarefas_vencidas: 0, proxima_hora: null, ...extra });
const CARTOES = [card(1, 'c1', 'Maria Souza', 'contato', { atrasado: true }), card(2, 'c2', 'João Lima', 'orcamento', { responsavel: EU0.id, n_ativos: 2 }), card(3, 'c3', 'Ana Paula', 'agendado')];

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

async function pagina(browser, { quadroIndisponivel = false, patchModo = 'ok', abertos = [], admin = false, despedida = 'ok' } = {}) {
  const EU = admin ? { ...EU0, papel: 'admin' } : EU0;
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.modo'); } catch {}
  }, [EU0.id, jwt(EU0.id), EU0.email]);
  const reg = { excecoes: [], pedidos: [], rpcs: [], patches: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => reg.excecoes.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: require('node:fs').readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url()); const p = url.pathname;
    const objeto = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    reg.pedidos.push(p + url.search);
    let corpo; let status = 200;
    if (p.startsWith('/auth/v1/user')) corpo = { id: EU.id, aud: 'authenticated', role: 'authenticated', email: EU.email };
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? EU : [EU]) : [EU, OUTRO];
    else if (p.startsWith('/rest/v1/conversas') && req.method() === 'PATCH') {
      const b = JSON.parse(req.postData() || '{}'); reg.patches.push(b);
      if (patchModo === 'sem_coluna' && 'motivo_encerramento' in b) { status = 400; corpo = { code: '42703', message: 'column "motivo_encerramento" of relation "conversas" does not exist' }; }
      else if (patchModo === 'agendado_recusado' && b.motivo_encerramento === 'agendado') { status = 400; corpo = { code: 'P0001', message: 'AGENDADO_SEM_AGENDAMENTO: Não encontrei agendamento vigente para este paciente. Confira o horário no Klingo ou escolha outro motivo.' }; }
      else if (patchModo === 'obrigatorio' && b.status === 'encerrada') { status = 400; corpo = { code: 'P0001', message: 'MOTIVO_OBRIGATORIO: escolha o motivo do encerramento.' }; }
      else { return rota.fulfill({ status: 204, headers: CORS }); }
    }
    else if (p.startsWith('/rest/v1/v_agendamento_aberto')) corpo = abertos;
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = COLUNAS;
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = TRANS;
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) { if (quadroIndisponivel) { status = 404; corpo = { message: 'relation "v_jornada_quadro" does not exist' }; } else corpo = CARTOES; }
    else if (p.endsWith('/rpc/jornada_mover_card')) { reg.rpcs.push(JSON.parse(req.postData() || '{}')); corpo = { ok: true, versao: 2 }; }
    else if (p.endsWith('/rpc/despedida_atual')) { if (despedida === 'sem_sql') { status = 404; corpo = { code: 'PGRST202', message: 'function despedida_atual does not exist' }; } else corpo = { ativa: true, versao: 5, texto: 'Obrigado pelo contato!', tem_imagem: false }; }
    else if (p.endsWith('/rpc/autoencerrar_resumo')) { if (despedida === 'sem_sql') { status = 404; corpo = { code: 'PGRST202', message: 'function autoencerrar_resumo does not exist' }; } else corpo = { modo: 'simulacao', horas: 24, elegiveis_agora: 3, aguardando_paciente: 11, ultimas: [{ em: '2026-11-09T10:00:00Z', modo: 'simulacao', elegiveis: 3, fechadas: 0 }] }; }
    else if (p.endsWith('/rpc/encerramentos_resumo')) corpo = { dias: 30, total: 9, automaticos: 2, por_motivo: { agendado: 4, apenas_informacoes: 2, nao_respondido: 2, desistiu: 1, sem_motivo: 0 } };
    else if (p.endsWith('/rpc/avaliacoes_resumo')) corpo = { dias: 30, total: 5, media_atendimento: 8.4, media_site: 7.2, por_canal: { WhatsApp: 3, Instagram: 1, Google: 1 } };
    else if (p.endsWith('/rpc/despedida_salvar')) { reg.rpcs.push({ rpc: 'despedida_salvar', ...JSON.parse(req.postData() || '{}') }); corpo = { ok: true, versao: 6 }; }
    else if (p.startsWith('/rest/v1/rpc/')) corpo = {};
    else if (p.startsWith('/rest/v1/')) corpo = objeto ? null : [];
    else corpo = {};
    return rota.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());
  return { page, ctx, reg };
}




CONVERSAS[1].contatos.email = LONGO.email;
const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const abrir = async (tela, opcoes = {}) => {
  const t = await pagina(browser, { quadroIndisponivel: true, ...opcoes }); await t.page.setViewportSize(tela);
  await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('#filtros .chip', { timeout: 10000 });
  await t.page.click('#filtros .chip:has-text("Abertas")'); await t.page.waitForTimeout(150);
  await t.page.click('.itens .item:has-text("Maria Aparecida")'); await t.page.waitForSelector('#chatTopo button:has-text("Encerrar")'); await t.page.waitForTimeout(400);
  return t;
};
const medir = (page) => page.evaluate(() => {
  const h = (id) => { const e = document.querySelector(id); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
  const msgs = document.getElementById('msgs'), topo = document.getElementById('chatTopo');
  const botoes = [...topo.querySelectorAll('button, select')].filter((b) => b.offsetParent !== null).map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim());
  return { topo: h('#chatTopo'), proximo: h('#proximo'), ctx: h('#ctxToggle'), msgs: Math.round(msgs.getBoundingClientRect().height), janela: window.innerHeight, largura: window.innerWidth,
    rolagemLateral: document.documentElement.scrollWidth > window.innerWidth + 1 || topo.scrollWidth > topo.clientWidth + 1, botoes };
});
const ANTES = { '1280x720': 176, '1366x768': 188, 'celular 390x780': 232, '1920x1080': 123 };   // medido no painel de 09/11/2026 (antes desta tarefa), com nome e e-mail longos
const TELAS = { '1280x720': { width: 1280, height: 720 }, '1366x768': { width: 1366, height: 768 }, 'celular 390x780': { width: 390, height: 780 }, '1920x1080': { width: 1920, height: 1080 } };

for (const [nome, tela] of Object.entries(TELAS)) {
  await caso(`topo em ${nome}: medida e ações`, async () => {
    const { page, ctx, reg } = await abrir(tela); const m = await medir(page);
    await ctx.close();
    console.log('   medida', nome, JSON.stringify({ topo: m.topo, proximo: m.proximo, ctx: m.ctx, msgs: m.msgs }));
    const total = m.topo + m.proximo + m.ctx, base0 = ANTES[nome];
    // Antes (09/11/2026, mesmo cenário com nome e e-mail longos): topo + próximo passo + botão de detalhes. Nunca pode ficar maior que antes.
    const menor = !base0 || total <= base0 - 20;
    return { ok: !m.rolagemLateral && m.botoes.some((b) => /Encerrar/.test(b)) && m.botoes.some((b) => /Transferir/.test(b)) && menor && !reg.excecoes.length, detalhe: `${total}px (antes ${base0 ?? '—'}px) ${JSON.stringify(m.botoes)}` };
  });
}

await caso('dados completos continuam acessíveis (title e aria-label) e o foco chega ao bloco e às ações', async () => {
  const { page, ctx } = await abrir(TELAS['1366x768']);
  const d = await page.evaluate(() => { const q = document.querySelector('#chatTopo .quem'); return { title: q.title, aria: q.getAttribute('aria-label'), tab: q.tabIndex }; });
  await page.focus('#chatTopo .quem'); await page.keyboard.press('Tab');
  const proximo = await page.evaluate(() => document.activeElement.textContent.trim());
  await ctx.close();
  return { ok: /muito\.longo@exemplo-de-dominio-bem-comprido\.com\.br/.test(d.title) && /Dados do paciente \(tocar para ver tudo\): Maria Aparecida/.test(d.aria) && d.tab === 0 && proximo.length > 0, detalhe: proximo };
});

await caso('a última mensagem continua alcançável por rolagem vertical e as mensagens longas quebram linha', async () => {
  const { page, ctx } = await abrir(TELAS['1280x720']);
  const r = await page.evaluate(() => { const b = document.getElementById('msgs'); b.scrollTop = b.scrollHeight; return { lateral: b.scrollWidth > b.clientWidth + 1, area: Math.round(b.getBoundingClientRect().height) }; });
  await ctx.close();
  return { ok: !r.lateral && r.area >= 300, detalhe: JSON.stringify(r) };
});

await caso('celular: o contato fica em 2 linhas e tocar no nome mostra tudo; o telefone continua sendo link', async () => {
  const { page, ctx } = await abrir(TELAS['celular 390x780']);
  const h1 = await page.evaluate(() => Math.round(document.querySelector('#chatTopo .quem').getBoundingClientRect().height));
  await page.click('#chatTopo .quem b'); await page.waitForTimeout(150);
  const aberto = await page.evaluate(() => ({ h: Math.round(document.querySelector('#chatTopo .quem').getBoundingClientRect().height), exp: document.querySelector('#chatTopo .quem').getAttribute('aria-expanded') }));
  await page.click('#chatTopo .quem b'); await page.waitForTimeout(150);
  const h3 = await page.evaluate(() => Math.round(document.querySelector('#chatTopo .quem').getBoundingClientRect().height));
  const link = await page.evaluate(() => !!document.querySelector('#chatTopo .quem a[href^="https://wa.me/"]'));
  await ctx.close();
  return { ok: aberto.h > h1 && aberto.exp === 'true' && h3 === h1 && link, detalhe: `${h1}px -> ${aberto.h}px -> ${h3}px` };
});
await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);

