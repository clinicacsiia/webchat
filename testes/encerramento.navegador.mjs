// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com uma conversa em atendimento) -> validação (o Encerrar sempre pede o motivo da lista; sem motivo não chama o banco) -> lógica (envia status e motivo_encerramento; se o SQL ainda não existe, encerra sem o motivo; erro MOTIVO_OBRIGATORIO vira aviso legível) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-03)
//
// Não substitui o teste com o Supabase real: as funções do banco são simuladas aqui (o banco tem teste próprio).
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
const OUTRO = { id: '22222222-2222-4222-8222-222222222222', nome: 'Outra Pessoa', email: 'o@teste.local', papel: 'atendente', ativo: true };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const agora = new Date().toISOString();

const conversa = (id, nome, status, agente) => ({ id, status, agente_id: agente, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, contatos: { id: 'ct-' + id, nome, telefone: '71900000000', email: null } });
const CONVERSAS = [conversa('c1', 'Maria Souza', 'aguardando', null), conversa('c2', 'João Lima', 'em_atendimento', EU.id), conversa('c3', 'Ana Paula', 'em_atendimento', OUTRO.id)];
const COLUNAS = [['contato', 'Em conversa no chat', 1, 'manual'], ['orcamento', 'Pedido pronto', 2, 'manual'], ['autorizacao', 'Aguardando autorização', 3, 'manual'], ['agendado', 'Agendado (veio do chat)', 4, 'klingo'], ['perdido', 'Perdido', 23, 'manual']]
  .map(([id, nome, ordem, origem]) => ({ id, nome, ordem, origem }));
const TRANS = [['contato', 'orcamento'], ['contato', 'autorizacao'], ['contato', 'perdido'], ['orcamento', 'autorizacao'], ['orcamento', 'perdido'], ['perdido', 'contato']].map(([de, para]) => ({ de, para }));
const card = (id, conv, nome, coluna, extra = {}) => ({ id, paciente_nome: nome, coluna, data_ref: '2026-11-01', unidade: 'CSI 1', coluna_desde: agora, responsavel: null, prioridade: 0, versao: 1, conversa_id: conv,
  primeiro_exame: 'Ressonância de joelho', n_ativos: 1, atrasado: false, n_tarefas_abertas: 0, n_tarefas_vencidas: 0, proxima_hora: null, ...extra });
const CARTOES = [card(1, 'c1', 'Maria Souza', 'contato', { atrasado: true }), card(2, 'c2', 'João Lima', 'orcamento', { responsavel: EU.id, n_ativos: 2 }), card(3, 'c3', 'Ana Paula', 'agendado')];

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

async function pagina(browser, { quadroIndisponivel = false, patchModo = 'ok', abertos = [] } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.modo'); } catch {}
  }, [EU.id, jwt(EU.id), EU.email]);
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
const abrir = async (opcoes) => { const t = await pagina(browser, opcoes); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('#filtros .chip', { timeout: 10000 }); await t.page.click('#filtros .chip:has-text("Abertas")'); await t.page.waitForTimeout(150); return t; };
const abrirConversa = async (page) => { await page.click('.itens .item:has-text("João Lima")'); await page.waitForSelector('#chatTopo button:has-text("Encerrar")'); };
const patchesStatus = (reg) => reg.patches.filter((b) => b.status === 'encerrada');
const motivosNoDialogo = (page) => page.locator('#motivoEnc option').allInnerTexts();

await caso('Encerrar abre a janela com os 5 motivos e não chama o banco sem escolher', async () => {
  const { page, ctx, reg } = await abrir({ quadroIndisponivel: true });
  await abrirConversa(page); await page.click('#chatTopo button:has-text("Encerrar")'); await page.waitForSelector('#motivoEnc');
  const ops = await motivosNoDialogo(page);
  await page.click('dialog button:has-text("Encerrar atendimento")'); await page.waitForTimeout(200);
  const aviso = await page.locator('#motivoEncAviso').isVisible();
  const aberta = await page.evaluate(() => document.getElementById('dlg').open);
  await ctx.close();
  return { ok: ops.slice(1).join('|') === 'Agendado|Apenas informações|Não respondido|Paciente desistiu|Outro motivo' && aviso && aberta && patchesStatus(reg).length === 0 && !reg.excecoes.length, detalhe: ops.join('|') };
});

await caso('escolher o motivo envia status e motivo_encerramento e mostra o motivo no topo', async () => {
  const { page, ctx, reg } = await abrir({ quadroIndisponivel: true });
  await abrirConversa(page); await page.click('#chatTopo button:has-text("Encerrar")'); await page.waitForSelector('#motivoEnc');
  await page.selectOption('#motivoEnc', 'apenas_informacoes'); await page.click('dialog button:has-text("Encerrar atendimento")'); await page.waitForTimeout(500);
  const topo = await page.locator('#chatTopo .quem').innerText();
  await ctx.close();
  const p = patchesStatus(reg);
  return { ok: p.length === 1 && p[0].motivo_encerramento === 'apenas_informacoes' && /Encerrada \(Apenas informações\)/.test(topo) && !reg.excecoes.length, detalhe: JSON.stringify(p) + ' | ' + topo.replace(/\n/g, ' ') };
});

await caso('com cartão no quadro: a mesma janela pede o motivo e as etapas; sem motivo não move o cartão', async () => {
  const { page, ctx, reg } = await abrir();
  await page.click('.modo button:has-text("Quadro")'); await page.waitForSelector('.q-col');
  await page.click('.q-card:has-text("João Lima")'); await page.waitForSelector('#chatTopo button:has-text("Encerrar")'); await page.click('#chatTopo button:has-text("Encerrar")'); await page.waitForSelector('#motivoEnc');
  const botoes = await page.locator('dialog button').allInnerTexts();
  await page.click('dialog button:has-text("Só encerrar")'); await page.waitForTimeout(200);
  const semMotivo = patchesStatus(reg).length === 0 && reg.rpcs.length === 0;
  await page.selectOption('#motivoEnc', 'agendado'); await page.click('dialog button:has-text("Só encerrar")'); await page.waitForTimeout(500);
  await ctx.close();
  const p = patchesStatus(reg);
  return { ok: semMotivo && p.length === 1 && p[0].motivo_encerramento === 'agendado' && botoes.some((b) => /Só encerrar/.test(b)) && botoes.some((b) => /tirar do quadro/.test(b)), detalhe: botoes.join('|') };
});

await caso('SQL do motivo ainda não aplicado: encerra sem o motivo, sem erro para o atendente', async () => {
  const { page, ctx, reg } = await abrir({ quadroIndisponivel: true, patchModo: 'sem_coluna' });
  await abrirConversa(page); await page.click('#chatTopo button:has-text("Encerrar")'); await page.waitForSelector('#motivoEnc');
  await page.selectOption('#motivoEnc', 'outro'); await page.click('dialog button:has-text("Encerrar atendimento")'); await page.waitForTimeout(600);
  const topo = await page.locator('#chatTopo .quem').innerText();
  const toast = await page.locator('#toast').allInnerTexts();
  await ctx.close();
  const p = patchesStatus(reg);
  return { ok: p.length === 2 && 'motivo_encerramento' in p[0] && !('motivo_encerramento' in p[1]) && /Encerrada/.test(topo) && !toast.some((t) => /motivo_encerramento/.test(t)), detalhe: p.length + ' envios; ' + toast.join('|') };
});

await caso('o banco exige o motivo (painel antigo): o aviso aparece sem o código técnico', async () => {
  const { page, ctx, reg } = await abrir({ quadroIndisponivel: true, patchModo: 'obrigatorio' });
  await abrirConversa(page); await page.click('#chatTopo button:has-text("Encerrar")'); await page.waitForSelector('#motivoEnc');
  await page.selectOption('#motivoEnc', 'outro'); await page.click('dialog button:has-text("Encerrar atendimento")'); await page.waitForTimeout(500);
  const toast = (await page.locator('#toast').allInnerTexts()).join('|');
  const topo = await page.locator('#chatTopo .quem').innerText();
  await ctx.close();
  return { ok: /escolha o motivo/i.test(toast) && !/MOTIVO_OBRIGATORIO/.test(toast) && !/Encerrada/.test(topo), detalhe: toast };
});

const aberto = (passou) => [{ pre_id: 'p1', conversa_id: 'c2', chave: 'p1|2026-11-20T10:00', quando: '2026-11-20T10:00:00', exames: 'Ressonância de joelho', passou, unidade: 'CSI' }];

await caso('exame ainda futuro: a janela só oferece Agendado e explica; o envio leva motivo agendado', async () => {
  const { page, ctx, reg } = await abrir({ quadroIndisponivel: true, abertos: aberto(false) });
  await abrirConversa(page); await page.waitForTimeout(500); await page.click('#chatTopo button:has-text("Encerrar")'); await page.waitForSelector('#motivoEnc');
  const ops = await motivosNoDialogo(page); const dica = await page.locator('dialog .dica').first().innerText();
  await page.selectOption('#motivoEnc', 'agendado'); await page.click('dialog button:has-text("Encerrar atendimento")'); await page.waitForTimeout(500);
  await ctx.close();
  const p = patchesStatus(reg);
  return { ok: ops.join('|') === 'Escolha o motivo…|Agendado' && /exame marcado ainda por vir/.test(dica) && p.length === 1 && p[0].motivo_encerramento === 'agendado', detalhe: ops.join('|') };
});

await caso('exame que já passou: o Encerrar é barrado antes da janela, sem chamar o banco', async () => {
  const { page, ctx, reg } = await abrir({ quadroIndisponivel: true, abertos: aberto(true) });
  await abrirConversa(page); await page.waitForTimeout(500); await page.click('#chatTopo button:has-text("Encerrar")'); await page.waitForTimeout(400);
  const toast = await page.locator('#toast').innerText(); const dialogo = await page.evaluate(() => document.getElementById('dlg').open);
  await ctx.close();
  return { ok: /exame marcado sem desfecho/.test(toast) && !dialogo && patchesStatus(reg).length === 0, detalhe: toast.slice(0, 60) };
});

await caso('o servidor recusa o Agendado sem agendamento: o aviso aparece sem o código técnico', async () => {
  const { page, ctx } = await abrir({ quadroIndisponivel: true, patchModo: 'agendado_recusado' });
  await abrirConversa(page); await page.click('#chatTopo button:has-text("Encerrar")'); await page.waitForSelector('#motivoEnc');
  await page.selectOption('#motivoEnc', 'agendado'); await page.click('dialog button:has-text("Encerrar atendimento")'); await page.waitForTimeout(500);
  const toast = await page.locator('#toast').innerText(); const topo = await page.locator('#chatTopo .quem').innerText();
  await ctx.close();
  return { ok: /Não encontrei agendamento vigente/.test(toast) && !/AGENDADO_/.test(toast) && !/Encerrada/.test(topo), detalhe: toast };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
