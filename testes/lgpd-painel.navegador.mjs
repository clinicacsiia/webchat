// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado; administrador e atendente) -> validação (Contatos NÃO tem botão de exportar CSV; só o administrador vê "Pedido de eliminação (LGPD)")
//   -> lógica (conferir não apaga: chama a função com p_confirmar = false; apagar pede confirmação e chama com p_confirmar = true) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial (LGPD: CSV retirado e eliminação a pedido). As funções do banco são simuladas aqui; o banco real é provado em sql-lgpd.test.mjs.
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
const EU = { id: '11111111-1111-4111-8111-111111111111', nome: 'Atendente de Teste', email: 'a@teste.local', papel: 'admin', ativo: true };
const OUTRO = { id: '22222222-2222-4222-8222-222222222222', nome: 'Outra Pessoa', email: 'o@teste.local', papel: 'atendente', ativo: true };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const agora = new Date().toISOString();

const conversa = (id, nome, status, agente) => ({ id, status, agente_id: agente, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, contatos: { id: 'ct-' + id, nome, telefone: '71900000000', email: null } });
const h = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();
const com = (c, espera) => ({ ...c, cliente_aguarda_desde: espera });
const CONVERSAS = [
  conversa('c1', 'Maria Souza', 'aguardando', null),
  com(conversa('c2', 'João Lima', 'em_atendimento', EU.id), h(0.1)),
  com(conversa('c3', 'Ana Paula', 'em_atendimento', OUTRO.id), h(0.2)),
  com(conversa('c4', 'Pedro Alves', 'em_atendimento', OUTRO.id), h(2.5)),
  conversa('c5', 'Lia Nunes', 'encerrada', OUTRO.id),
  // Equipe já respondeu e o paciente demora (aguarda_paciente_desde): vão para o grupo "Aguardando resposta do paciente", da mais antiga (c8, 9 h) para a mais nova (c7, 1 h).
  { ...conversa('c6', 'Rita Dias', 'em_atendimento', OUTRO.id), cliente_aguarda_desde: null, aguarda_paciente_desde: h(5) },
  { ...conversa('c7', 'Zé Costa', 'em_atendimento', EU.id), cliente_aguarda_desde: null, aguarda_paciente_desde: h(1) },
  { ...conversa('c8', 'Bia Sol', 'em_atendimento', OUTRO.id), cliente_aguarda_desde: null, aguarda_paciente_desde: h(9) },
  // Paciente esperando a equipe há 30 min (mais antigo que a Ana Paula, 12 min): deve vir antes dela no grupo do atendente.
  com(conversa('c9', 'Caio Reis', 'em_atendimento', OUTRO.id), h(0.5)),
];
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

async function pagina(browser, { quadroIndisponivel = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.modo'); } catch {}
  }, [EU.id, jwt(EU.id), EU.email]);
  const reg = { excecoes: [], pedidos: [], rpcs: [] };
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
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/contatos')) corpo = [{ id: 'ct-1', nome: 'Maria Souza', telefone: '71900000000', email: 'm@x.invalid', origem: 'chat', tags: [], observacoes: null, aceitou_lgpd_em: agora, criado_em: agora, ultimo_contato_em: agora }];
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = COLUNAS;
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = TRANS;
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) { if (quadroIndisponivel) { status = 404; corpo = { message: 'relation "v_jornada_quadro" does not exist' }; } else corpo = CARTOES; }
    else if (p.endsWith('/rpc/jornada_mover_card')) { reg.rpcs.push(JSON.parse(req.postData() || '{}')); corpo = { ok: true, versao: 2 }; }
    else if (p.endsWith('/rpc/painel_lgpd_eliminar')) { const a = JSON.parse(req.postData() || '{}'); reg.rpcs.push(a); corpo = { ok: true, simulacao: !a.p_confirmar, apagado: { contatos: 1, conversas: 2, mensagens: 9, acesso_rapido: 1, filhos: 1 }, mantido: ['Cadastro e agendamentos no Klingo (obrigação legal)'] }; }
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
const contatos = async (papel) => {
  const t = await pagina(browser);
  if (papel !== 'admin') EU.papel = papel;
  await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('.modo', { timeout: 10000 });
  await t.page.getByRole('tab', { name: /Contatos/ }).or(t.page.getByText('Contatos', { exact: true })).first().click();
  await t.page.waitForSelector('#tabContatos', { timeout: 10000 });
  return t;
};

await caso('Contatos não tem botão "Exportar CSV" e o texto não promete campanha', async () => {
  const { page, ctx, reg } = await contatos('admin');
  const csv = await page.getByText('Exportar CSV').count(), camp = await page.getByText(/campanha/i).count();
  await ctx.close();
  return { ok: csv === 0 && camp === 0 && !reg.excecoes.length, detalhe: `csv=${csv} campanha=${camp} ${reg.excecoes[0] ?? ''}` };
});
await caso('o administrador vê "Pedido de eliminação (LGPD)"; conferir chama a função SEM apagar e mostra a lista', async () => {
  const { page, ctx, reg } = await contatos('admin');
  await page.getByRole('button', { name: /Pedido de eliminação/ }).click();
  await page.fill('#lgTel', '(71) 90000-0000');
  await page.getByRole('button', { name: 'Conferir o que existe' }).click();
  await page.getByText('Ainda NADA foi apagado').waitFor({ timeout: 5000 });
  const linhas = await page.locator('dialog table td').allInnerTexts();
  const apagarOff = await page.getByRole('button', { name: 'Apagar tudo isso' }).isDisabled();
  const ok = reg.rpcs.length === 1 && reg.rpcs[0].p_confirmar === false && reg.rpcs[0].p_telefone === '(71) 90000-0000' && linhas.includes('Conversas') && !apagarOff;
  await ctx.close();
  return { ok, detalhe: JSON.stringify(reg.rpcs) + ' ' + linhas.join('|') };
});
await caso('apagar pede confirmação (cancelar não chama nada) e confirmar chama com p_confirmar = true', async () => {
  const { page, ctx, reg } = await contatos('admin');
  await page.getByRole('button', { name: /Pedido de eliminação/ }).click();
  await page.fill('#lgMail', 'maria@x.invalid');
  await page.getByRole('button', { name: 'Conferir o que existe' }).click();
  await page.getByText('Ainda NADA foi apagado').waitFor({ timeout: 5000 });
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: 'Apagar tudo isso' }).click();
  await page.waitForTimeout(300);
  const aposCancelar = reg.rpcs.length;
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Apagar tudo isso' }).click();
  await page.getByText(/Pronto: apagado/).waitFor({ timeout: 5000 });
  const ultimo = reg.rpcs[reg.rpcs.length - 1];
  await ctx.close();
  return { ok: aposCancelar === 1 && reg.rpcs.length === 2 && ultimo.p_confirmar === true && ultimo.p_email === 'maria@x.invalid', detalhe: `chamadas=${reg.rpcs.length}` };
});
await caso('o atendente NÃO vê o botão de eliminação', async () => {
  const { page, ctx } = await contatos('atendente');
  const n = await page.getByRole('button', { name: /Pedido de eliminação/ }).count();
  await ctx.close();
  return { ok: n === 0, detalhe: `botões=${n}` };
});

await browser.close(); srv.close();
const passou = resultados.filter(Boolean).length;
console.log(`\n${passou}/${resultados.length} verificações passaram`);
process.exit(passou === resultados.length ? 0 : 1);
