// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado: convênios, avisos e fotos) -> validação (só administrador vê a aba Convênios) -> lógica (listar, desativar com confirmação, salvar regra, marcar avisos como vistos, aviso de foto anexada e pendência do Klingo) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial (convênios e fotos do pedido)
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
    else if (p.endsWith('/rpc/convenios_painel')) corpo = PAINEL;
    else if (p.endsWith('/rpc/convenio_eventos')) corpo = EVENTOS;
    else if (p.endsWith('/rpc/convenio_aviso_contagem')) corpo = { novos: EVENTOS.length, relevantes: 1 };
    else if (p.endsWith('/rpc/convenio_salvar')) { reg.rpcs.push({ rpc: 'convenio_salvar', ...JSON.parse(req.postData() || '{}') }); corpo = { ok: true, ativo: false, em_andamento: 2 }; }
    else if (p.endsWith('/rpc/convenio_eventos_visto')) { reg.rpcs.push({ rpc: 'visto' }); corpo = 3; }
    else if (p.endsWith('/rpc/convenio_detalhe')) corpo = [{ id: 1, exame: 'RM DE JOELHO', modalidade: 'RM', demanda_90d: 40, valor_convenio: 150, confianca_convenio: 'alta', valor_particular: 380, confianca_particular: 'media', amostras_particular: 3, ultimo_valor_marcacao: 150, ultimo_valor_amostras: 5, mudou_em: agora, mudou_de: '300', mudou_para: '380' }];
    else if (p.endsWith('/rpc/painel_anexos_resumo')) corpo = [{ conversa_id: 'c1', total: 2, sem_conferir: 2, ultima: agora, ids: [11, 12] }];
    else if (p.endsWith('/rpc/painel_anexo_klingo_conferido')) { reg.rpcs.push({ rpc: 'conferido', ...JSON.parse(req.postData() || '{}') }); corpo = 2; }
    else if (p.endsWith('/rpc/painel_anexo')) corpo = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', itens: [], ia: null, escolha: null, gabarito: null };
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

await caso('administrador vê a aba Convênios com selo, avisos e os dois convênios', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('.nav button[data-aba=convenios]');
  await page.waitForFunction(() => { const e = document.getElementById('seloConvenios'); return e && !e.hidden && e.textContent === '1'; }, null, { timeout: 5000 }).catch(() => {});
  const selo = await page.locator('#seloConvenios').innerText().catch(() => '');
  await page.click('.nav button[data-aba=convenios]');
  await page.waitForSelector('.cv-cartao');
  const nomes = (await page.locator('.cv-cartao h3').allInnerTexts()).join();
  const aviso = await page.locator('.cv-ev').innerText();
  await ctx.close();
  return { ok: reg.excecoes.length === 0 && nomes === 'HAPVIDA,AMIL,Particular' && /CONSULTA/.test(aviso) && selo === '1', detalhe: `${nomes} | selo=${selo} | ${reg.excecoes.join(';')}` };
});

await caso('atendente não vê a aba Convênios', async () => {
  const { page, ctx } = await pagina(browser, { papel: 'atendente' });
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('.nav button');
  const tem = await page.locator('.nav button[data-aba=convenios]').count();
  await ctx.close();
  return { ok: tem === 0, detalhe: String(tem) };
});

await caso('desativar pede confirmação (com o impacto) e salva ativo:false', async () => {
  const { page, ctx, reg } = await pagina(browser);
  let texto = '';
  page.on('dialog', async (d) => { texto = d.message(); await d.accept(); });
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=convenios]');
  await page.waitForSelector('.cv-cartao');
  await page.locator('.cv-cartao:has(h3:text-is("HAPVIDA")) button:text-is("Desativar")').click();
  await page.waitForTimeout(400);
  const salvo = reg.rpcs.find((r) => r.rpc === 'convenio_salvar');
  await ctx.close();
  return { ok: /Desativar HAPVIDA/.test(texto) && /42 agendamentos/.test(texto) && salvo && salvo.p_operadora === 'HAPVIDA' && salvo.p_dados.ativo === false, detalhe: `${texto.replace(/\n/g, ' / ')} | ${JSON.stringify(salvo)}` };
});

await caso('regra "um exame por vez" e aviso são salvos; ver preços mostra o valor e a mudança', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=convenios]');
  await page.waitForSelector('.cv-cartao');
  const c = page.locator('.cv-cartao:has(h3:text-is("HAPVIDA"))');
  await c.locator('summary').click();
  await c.locator('input[type=checkbox]').check();
  await c.locator('textarea').first().fill('Traga a carteirinha');
  await c.locator('button:text-is("Salvar regras")').click();
  await page.waitForTimeout(400);
  const salvo = reg.rpcs.filter((r) => r.rpc === 'convenio_salvar').pop();
  await page.waitForSelector('.cv-cartao');
  await page.locator('.cv-cartao:has(h3:text-is("HAPVIDA")) button:text-is("Ver preços")').click();
  await page.waitForSelector('.cv-cartao table');
  const tabela = await page.locator('.cv-cartao table').first().innerText();
  await ctx.close();
  return { ok: salvo && salvo.p_dados.um_por_vez === true && salvo.p_dados.aviso === 'Traga a carteirinha' && /RM DE JOELHO/.test(tabela) && /380/.test(tabela), detalhe: JSON.stringify(salvo) + ' | ' + tabela.replace(/\s+/g, ' ').slice(0, 120) };
});

await caso('filtro "Desativados" esconde os ativos', async () => {
  const { page, ctx } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=convenios]');
  await page.waitForSelector('.cv-cartao');
  await page.locator('.cv-busca .chip:text-is("Desativados")').click();
  const visiveis = (await page.locator('.cv-busca + div .cv-cartao:visible h3').allInnerTexts()).join();
  await ctx.close();
  return { ok: visiveis === 'AMIL', detalhe: visiveis };
});

await caso('conversa com foto: tag na lista, aviso de anexo, botão abre as fotos e a pendência do Klingo se confere', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('.nav button[data-aba=atendimento]');
  await page.click('.nav button[data-aba=atendimento]');
  await page.waitForSelector('.item');
  await page.waitForFunction(() => /Anexo: 2 fotos/.test(document.querySelector('.item')?.innerText || ''), null, { timeout: 5000 });
  await page.locator('.item:has-text("Maria Souza")').click();
  await page.waitForSelector('.anexo-aviso');
  const aviso = await page.locator('.anexo-aviso').innerText();
  await page.locator('.anexo-aviso button:has-text("Ver as 2 fotos")').click();
  await page.waitForSelector('.galeria img', { timeout: 5000 });
  const imgs = await page.locator('.galeria img').count();
  await page.locator('.anexo-aviso button:text-is("Conferi no Klingo")').click();
  await page.waitForTimeout(400);
  const conf = reg.rpcs.find((r) => r.rpc === 'conferido');
  await ctx.close();
  return { ok: /Anexo: 2 fotos/.test(aviso) && /Klingo/.test(aviso) && imgs === 2 && conf && conf.p_conversa === 'c1' && conf.p_feito === true && reg.excecoes.length === 0, detalhe: `${aviso.replace(/\n/g, ' / ').slice(0, 140)} | imgs=${imgs} | ${JSON.stringify(conf)} | ${reg.excecoes.join(';')}` };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
