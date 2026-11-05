// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado: médicos e avisos) -> validação (só administrador vê a aba Médicos) -> lógica (lista pré-preenchida, salvar particularidade, aviso aceitar/manter, bloquear no chat) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 05/11/2026 / Mudança: Implementação inicial
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
const EU = { id: '11111111-1111-4111-8111-111111111111', nome: 'Atendente de Teste', email: 'a@teste.local', papel: 'admin', ativo: true };
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

const op = (operadora, ativo, u30, extra = {}) => ({ operadora, chave: operadora.toUpperCase(), ativo, mensagem_inativo: null, aviso: null, um_por_vez: false, msg_varios: null, motivo: null, planos: 2,
  precos: { procedimentos: 20, alta: 18, media: 2, baixa: 0 }, ultimo_exame: { procedimento: 'USG ABDOME', quando: agora }, ultimo_valor: { procedimento: 'USG ABDOME', valor: 120, amostras: 4 },
  demanda: { semanas: [10, 12, 9, 11], total: 42, ult_30d: u30, ant_30d: 40, previsao_30d: 44, tendencia_pct: 5, confiavel: true, participacao_pct: 30 }, chat_30d: 3, chat_abandonados: 1, em_andamento: 2, avisos_novos: 1, avisos_relevantes: 0, ...extra });
const PAINEL = { avisos_novos: 2, convenios: [op('HAPVIDA', true, 42), op('AMIL', false, 0, { demanda: { semanas: [], total: 0, ult_30d: 0, ant_30d: 0, previsao_30d: 0, confiavel: false, participacao_pct: 0 } })],
  particular: { precos: { procedimentos: 100, alta: 80, media: 10, baixa: 10 }, mudancas_30d: 5, avisos_novos: 0 }, padroes: { mensagem_inativo: 'Padrão inativo', msg_varios: 'Padrão vários' } };
const EVENTOS = [{ id: 1, criado_em: agora, operadora: 'PARTICULAR', tipo: 'preco_particular', descricao: 'PARTICULAR · CONSULTA', antes: '380', depois: '220', variacao_pct: -42.1, relevante: true, origem: 'catalogo', novo: true }];

const MEDICOS = [
  { profissional: 'ALEXANDRE MAGNO TEIXEIRA MEDEIROS', unidade: 'DESENVOAR', especialidade: 'Pediatria', consulta: true, sala: false, dias: [2, 3, 4], hora_ini: '08:20', hora_fim: '17:00', regra: null, bloqueado: false, aviso_id: null },
  { profissional: 'DANIELA LADEIA', unidade: 'CLÍNICA DE SAÚDE E IMAGEM - CSI', especialidade: 'Ortopedia', consulta: true, sala: false, dias: [1, 5], hora_ini: '08:00', hora_fim: '17:15', regra: { dias: [1], hora_ini: null, hora_fim: '12:00', nota: null }, bloqueado: false, aviso_id: 7 },
  { profissional: 'RM', unidade: 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC', especialidade: null, consulta: false, sala: true, dias: [1, 2, 3, 4, 5, 6], hora_ini: '07:00', hora_fim: '18:50', regra: null, bloqueado: false, aviso_id: null }];
const AVISOS = [{ id: 7, criado_em: agora, profissional: 'DANIELA LADEIA', unidade: 'CLÍNICA DE SAÚDE E IMAGEM - CSI', tipo: 'alterado', antes: { dias: [1], hora_ini: '08:00', hora_fim: '17:15' }, depois: { dias: [1, 5], hora_ini: '08:00', hora_fim: '17:15' }, status: 'pendente', tem_regra: true }];
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

async function pagina(browser, { papel = 'admin' } = {}) {
  EU.papel = papel;
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
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = COLUNAS;
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = TRANS;
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) { if (false) { status = 404; corpo = { message: 'relation "v_jornada_quadro" does not exist' }; } else corpo = CARTOES; }
    else if (p.endsWith('/rpc/medicos_painel')) corpo = { medicos: MEDICOS, avisos: AVISOS };
    else if (p.endsWith('/rpc/medico_aviso_contagem')) corpo = { novos: AVISOS.length };
    else if (p.endsWith('/rpc/medico_aviso_resolver')) { reg.rpcs.push({ rpc: 'resolver', ...JSON.parse(req.postData() || '{}') }); corpo = { ok: true }; }
    else if (p.endsWith('/rpc/medico_salvar')) { reg.rpcs.push({ rpc: 'salvar', ...JSON.parse(req.postData() || '{}') }); corpo = { regra: true }; }
    else if (p.endsWith('/rpc/profissional_bloquear')) { reg.rpcs.push({ rpc: 'bloquear', ...JSON.parse(req.postData() || '{}') }); corpo = { ok: true, conversas: 2 }; }
    else if (p.endsWith('/rpc/jornada_mover_card')) corpo = { ok: true };
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

await caso('administrador vê a aba Médicos com selo 1, aviso e médicos pré-preenchidos (sala escondida)', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('.nav button[data-aba=medicos]');
  await page.waitForFunction(() => { const e = document.getElementById('seloMedicos'); return e && !e.hidden && e.textContent === '1'; }, null, { timeout: 5000 }).catch(() => {});
  const selo = await page.locator('#seloMedicos').innerText().catch(() => '');
  await page.click('.nav button[data-aba=medicos]');
  await page.waitForSelector('.pagina table');
  const tab = await page.locator('.pagina table').innerText();
  const aviso = await page.locator('.cv-ev').innerText();
  await ctx.close();
  return { ok: reg.excecoes.length === 0 && selo === '1' && /Alexandre Magno Teixeira Medeiros/.test(tab) && /Ter, Qua, Qui · 08:20–17:00/.test(tab) && /Seg · 08:00–12:00/.test(tab) && !/\bRM\b/.test(tab) && /Antes: Seg/.test(aviso), detalhe: `${selo} | ${reg.excecoes.join(';')} | ${tab.replace(/\s+/g, ' ').slice(0, 220)}` };
});

await caso('atendente não vê a aba Médicos', async () => {
  const { page, ctx } = await pagina(browser, { papel: 'atendente' });
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('.nav button');
  const tem = await page.locator('.nav button[data-aba=medicos]').count();
  await ctx.close();
  return { ok: tem === 0, detalhe: String(tem) };
});

await caso('particularidades: abre já preenchido, só dias da grade, salva dias e horas', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=medicos]');
  await page.waitForSelector('.pagina table');
  await page.locator('tr:has-text("Alexandre") button:text-is("Particularidades")').click();
  const marcados = await page.locator('input[data-dia]:checked').evaluateAll((l) => l.map((i) => i.dataset.dia).join());
  const desab = await page.locator('input[data-dia]:disabled').count();
  const ini = await page.locator('input[type=time]').first().inputValue();
  await page.locator('input[data-dia="3"]').uncheck();
  await page.locator('input[data-dia="4"]').uncheck();
  await page.locator('input[type=time]').nth(1).fill('12:00');
  await page.locator('button:text-is("Salvar")').click();
  await page.waitForTimeout(400);
  const s = reg.rpcs.find((r) => r.rpc === 'salvar');
  await ctx.close();
  return { ok: marcados === '2,3,4' && desab === 4 && ini === '08:20' && s && s.p_dados.dias.join() === '2' && s.p_dados.hora_fim === '12:00' && s.p_dados.hora_ini === '08:20', detalhe: `${marcados} | ${desab} | ${ini} | ${JSON.stringify(s)}` };
});

await caso('aceitar e manter chamam o banco com a ação certa', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=medicos]');
  await page.waitForSelector('.cv-ev');
  await page.locator('.cv-ev button:text-is("Manter como estava")').click();
  await page.waitForTimeout(300);
  await page.locator('.cv-ev button:text-is("Aceitar e atualizar a agenda")').click();
  await page.waitForTimeout(300);
  const r = reg.rpcs.filter((x) => x.rpc === 'resolver').map((x) => `${x.p_id}:${x.p_acao}`).join();
  await ctx.close();
  return { ok: r === '7:manter,7:aceitar', detalhe: r };
});

await caso('bloquear no chat pede confirmação e chama profissional_bloquear', async () => {
  const { page, ctx, reg } = await pagina(browser);
  let texto = '';
  page.on('dialog', async (d) => { texto = d.message(); await d.accept(); });
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=medicos]');
  await page.waitForSelector('.pagina table');
  await page.locator('tr:has-text("Daniela") input[type=checkbox]').first().uncheck();
  await page.waitForTimeout(400);
  const b = reg.rpcs.find((x) => x.rpc === 'bloquear');
  await ctx.close();
  return { ok: /Bloquear Daniela Ladeia/.test(texto) && b && b.p_nome === 'DANIELA LADEIA', detalhe: `${texto} | ${JSON.stringify(b)}` };
});

await browser.close(); srv.close();
const falhas = resultados.filter((x) => !x).length;
console.log(falhas ? `\n${falhas} FALHA(S)` : `\nTudo certo (${resultados.length})`);
process.exit(falhas ? 1 : 0);
