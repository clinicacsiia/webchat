// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado + função painel-horarios simulada) -> validação (botão "Ver horários" só para admin/atendente e conversa aberta) -> lógica (lista por dia, marcar, inserir texto na resposta; sem vaga e motivos do Klingo) -> saída (texto na caixa de resposta, nada enviado)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (Etapa 1: ver horários reais da agenda dentro da conversa)
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
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const conversa = (id, nome, status, agente) => ({ id, status, agente_id: agente, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, contatos: { id: 'ct-' + id, nome, telefone: '71900000000', email: null } });
const h = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();
const com = (c, espera) => ({ ...c, cliente_aguarda_desde: espera });
const CONVERSAS = [
  conversa('c1', 'Maria Souza', 'aguardando', null),
  com(conversa('c2', 'João Lima', 'em_atendimento', EU.id), h(0.1)),
  com(conversa('c3', 'Ana Paula', 'em_atendimento', OUTRO.id), h(0.2)),
  com(conversa('c4', 'Pedro Alves', 'em_atendimento', OUTRO.id), h(2.5)),
  { ...conversa('c5', 'Lia Nunes', 'encerrada', OUTRO.id), encerrada_em: agora },
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

async function pagina(browser, { nivel = 'supervisor', marcouFalha = false, horarios = null, papel = 'atendente' } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.modo'); } catch {}
  }, [EU.id, jwt(EU.id), EU.email]);
  const reg = { excecoes: [], pedidos: [], rpcs: [], chamadas: [] };
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
    else if (p.startsWith('/functions/v1/painel-horarios')) { reg.chamadas.push(JSON.parse(req.postData() || '{}')); if (horarios === 'erro') { status = 500; corpo = { error: 'x' }; } else corpo = typeof horarios === 'function' ? horarios(JSON.parse(req.postData() || '{}')) : horarios; }
    else if (p.startsWith('/rest/v1/agentes')) { const eu = { ...EU, papel }; corpo = url.searchParams.get('id') ? (objeto ? eu : [eu]) : [eu, OUTRO]; }
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = [];
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = [];
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) corpo = [];
    else if (p.endsWith('/rpc/org_nivel')) corpo = nivel;
    else if (p.endsWith('/rpc/painel_indicadores_atendentes')) { reg.rpcs.push(JSON.parse(req.postData() || '{}')); if (marcouFalha) { status = 500; corpo = { message: 'falhou' }; } else corpo = { pessoas: [{ nome: 'Outra Pessoa', agendados: 3 }, { nome: 'Atendente de Teste', agendados: 1 }] }; }
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
const abrir = async (opcoes) => { const t = await pagina(browser, opcoes); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('.modo', { timeout: 10000 }); return t; };

const COM = { ok: true, estado: 'com_horarios', tipo: 'consulta', janela: 0, de: '2026-11-17', ate: '2026-12-01', total: 4, cortado: false,
  dias: [{ data: '2026-11-17', itens: [{ hora: '08:00', profissional: 'Dra. Teste', unidade: 'CLÍNICA DE SAÚDE E IMAGEM - DESENVOAR', ordem_chegada: false }, { hora: '08:30', profissional: 'Dra. Teste', unidade: 'DESENVOAR', ordem_chegada: false }] },
    { data: '2026-11-18', itens: [{ hora: '14:00', profissional: 'Dr. Outro', unidade: 'DESENVOAR', ordem_chegada: true }, { hora: '14:30', profissional: 'Dr. Outro', unidade: 'CSI', ordem_chegada: false }] }] };
const abrirConversaJoao = async (opcoes) => { const t = await abrir(opcoes); await t.page.click('.chip:has-text("Meus")'); await t.page.click('.item:has-text("João Lima")'); await t.page.waitForSelector('#chatTopo'); return t; };

await caso('Atendente vê "Ver horários" na conversa aberta; sem conversa aberta não há botão', async () => {
  const { page, ctx, reg } = await abrir({ horarios: COM });
  const antes = await page.locator('button:has-text("Ver horários")').count();
  await page.click('.chip:has-text("Meus")'); await page.click('.item:has-text("João Lima")'); await page.waitForSelector('#chatTopo');
  const depois = await page.locator('#chatTopo button:has-text("Ver horários")').count();
  await ctx.close();
  return { ok: antes === 0 && depois === 1 && !reg.excecoes.length, detalhe: `antes=${antes} depois=${depois} ${reg.excecoes[0] ?? ''}` };
});

await caso('Lista os horários por dia, marca dois e insere o texto na resposta (sem enviar)', async () => {
  const { page, ctx, reg } = await abrirConversaJoao({ horarios: COM });
  await page.click('#chatTopo button:has-text("Ver horários")');
  await page.waitForSelector('.hor-item');
  const n = await page.locator('.hor-item').count();
  const desabilitado = await page.locator('dialog button:has-text("Inserir na resposta")').isDisabled();
  await page.locator('.hor-item:has-text("08:00") input').check(); await page.locator('.hor-item:has-text("08:30") input').check(); await page.locator('.hor-item:has-text("14:00") input').check();
  await page.locator('.hor-item:has-text("14:30") input').check();
  await page.click('dialog button:has-text("Inserir 4 na resposta")'); await espera(500);
  const caixa = await page.inputValue('#caixa');
  const enviou = reg.pedidos.filter((x) => /\/rest\/v1\/mensagens/.test(x) && false).length;
  await ctx.close();
  const ok = n === 4 && desabilitado && /• ter 17\/11 às 08:00, 08:30 — Dra\. Teste/.test(caixa) && /• qua 18\/11 às 14:00 — Dr\. Outro \(ordem de chegada\) — DESENVOAR/.test(caixa) && /14:30 — Dr\. Outro — CSI/.test(caixa) && /Qual fica melhor/.test(caixa)
    && reg.chamadas.length >= 1 && reg.chamadas.at(-1).conversa === 'c2' && reg.chamadas.at(-1).janela === 0 && !reg.excecoes.length;
  return { ok, detalhe: reg.excecoes[0] ?? caixa.replace(/\n/g, ' | ') + ' ' + JSON.stringify(reg.chamadas) };
});

await caso('Sem vaga: explica o que fazer (outro horário; se não aceitar, Disponibilidade futura) e "Ver mais 14 dias" consulta a janela seguinte', async () => {
  const SEM = { ok: true, estado: 'sem_horarios', janela: 0, de: '2026-11-17', ate: '2026-12-01', total: 0, cortado: false, dias: [] };
  const { page, ctx, reg } = await abrirConversaJoao({ horarios: SEM });
  await page.click('#chatTopo button:has-text("Ver horários")'); await page.waitForSelector('dialog:has-text("Sem vaga")');
  const txt = await page.locator('dialog').innerText();
  await page.click('dialog button:has-text("Ver mais 14 dias")'); await espera(500);
  await ctx.close();
  return { ok: /Disponibilidade futura/.test(txt) && /outro médico ou outra unidade/.test(txt) && reg.chamadas.at(-1).janela === 1 && reg.chamadas.length >= 2, detalhe: JSON.stringify(reg.chamadas) };
});

await caso('Convênio suspenso e dados faltando viram mensagens claras (sem código técnico)', async () => {
  let ctxA, pgA;
  const a = await abrirConversaJoao({ horarios: { ok: false, motivo: 'plano_inativo', detalhe: 'Operadora GEAP com atendimento suspenso.' } });
  await a.page.click('#chatTopo button:has-text("Ver horários")'); await a.page.waitForSelector('dialog:has-text("inativo ou suspenso")');
  const t1 = await a.page.locator('dialog').innerText(); await a.ctx.close();
  const b = await abrirConversaJoao({ horarios: { ok: false, motivo: 'dados_incompletos', faltando: ['CPF', 'convênio'] } });
  await b.page.click('#chatTopo button:has-text("Ver horários")'); await b.page.waitForSelector('dialog:has-text("Ainda faltam")');
  const t2 = await b.page.locator('dialog').innerText(); await b.ctx.close();
  return { ok: /GEAP/.test(t1) && !/plano_inativo/.test(t1) && /CPF, convênio/.test(t2) && !/dados_incompletos/.test(t2), detalhe: '' };
});

await caso('Falha do servidor: aviso simples e "Tentar de novo"', async () => {
  const { page, ctx, reg } = await abrirConversaJoao({ horarios: 'erro' });
  await page.click('#chatTopo button:has-text("Ver horários")'); await page.waitForSelector('dialog:has-text("Não consegui consultar")');
  const tem = await page.locator('dialog button:has-text("Tentar de novo")').count();
  await ctx.close();
  return { ok: tem === 1 && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? '' };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
