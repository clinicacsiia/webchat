// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com a memória das ofertas) -> validação (cartões só na conversa assumida por mim; sem vaga não oferece horário; recusou uma vez não oferece mais) -> lógica (oferecer, aceitou, recusou, cobrar, dispensar, cadastrar na Disponibilidade futura) -> saída (chamadas ao banco e texto na caixa de resposta; nada é enviado)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (Etapa 2: ofertas com ação na conversa)
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

async function pagina(browser, { nivel = 'supervisor', marcouFalha = false, horarios = null, papel = 'atendente', bd = { horario: null, disponibilidade: null } } = {}) {
  const ctx = await browser.newContext();
  // Notificação já concedida: com a permissão em "default" o painel refaz a tela inteira quando o navegador responde (apaga o texto da caixa de resposta no meio do teste).
  await ctx.grantPermissions(['notifications'], { origin: `http://127.0.0.1:${srv.address().port}` });
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.modo'); } catch {}
  }, [EU.id, jwt(EU.id), EU.email]);
  const reg = { excecoes: [], pedidos: [], rpcs: [], chamadas: [], regs: [], cadastros: [] };
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
    else if (p.endsWith('/rpc/painel_ofertas')) { corpo = Object.fromEntries(Object.entries(bd).filter(([, e]) => e).map(([k, e]) => [k, { estado: e, em: agora }])); }
    else if (p.endsWith('/rpc/painel_oferta_registrar')) {
      const a = JSON.parse(req.postData() || '{}'); reg.regs.push(a);
      if (a.p_estado === 'oferecido' && ['recusado', 'dispensado'].includes(bd[a.p_tipo])) corpo = { ok: false, bloqueado: true, motivo: 'ja_' + bd[a.p_tipo] };
      else { bd[a.p_tipo] = a.p_estado; corpo = { ok: true, estado: a.p_estado }; }
    }
    else if (p.endsWith('/rpc/painel_disponibilidade_registrar')) { reg.cadastros.push(JSON.parse(req.postData() || '{}')); bd.disponibilidade = 'aceito'; corpo = { ok: true, id: 'd1', data_ini: '2026-11-17', data_fim: '2026-12-16', procedimento: 'X' }; }
    else if (p.startsWith('/rest/v1/respostas_prontas')) corpo = [
      { id: 'r1', atalho: 'LISTA-DE-ESPERA', texto: 'A agenda do(a) Dr(a). {medico} está completa no momento. Podemos deixar o nome do paciente em nossa lista de espera?' },
      { id: 'r2', atalho: 'ACEITOU-LISTA-DE-ESPERA', texto: 'Prontinho! O paciente foi incluído em nossa lista de espera.' },
      { id: 'r3', atalho: 'DEMORA-DE-RESPONDER-HORARIO-OFERTADO', texto: 'Passando para saber se conseguiu verificar as opções de horários que enviamos.' }];
    else if (p === '/rest/v1/mensagens' && req.method() === 'POST') {
      const m = req.postDataJSON();
      if (m.opcoes?.oferta) {
        bd[m.opcoes.oferta] = 'oferecido';
        reg.regs.push({ p_tipo: m.opcoes.oferta, p_estado: 'oferecido' });
      }
      corpo = { ...m, id: 1, opcoes: null, criado_em: agora };
    }
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
  dias: [{ data: '2026-11-17', itens: [{ hora: '08:00', profissional: 'Dra. Teste', unidade: 'DESENVOAR', ordem_chegada: false }, { hora: '08:30', profissional: 'Dra. Teste', unidade: 'DESENVOAR', ordem_chegada: false }] },
    { data: '2026-11-18', itens: [{ hora: '14:00', profissional: 'Dr. Outro', unidade: 'DESENVOAR', ordem_chegada: false }, { hora: '14:30', profissional: 'Dr. Outro', unidade: 'DESENVOAR', ordem_chegada: false }] }] };
const SEM = { ok: true, estado: 'sem_horarios', janela: 0, de: '2026-11-17', ate: '2026-12-01', total: 0, cortado: false, dias: [] };
const abrirJoao = async (opcoes) => { const t = await abrir(opcoes); await t.page.click('.chip:has-text("Meus")'); await t.page.click('.item:has-text("João Lima")'); await t.page.waitForSelector('#chatTopo'); return t; };
const cartoes = (page) => page.$$eval('#ofertas .of-card', (l) => l.map((c) => ({ titulo: c.querySelector('b').textContent, botoes: [...c.querySelectorAll('button')].map((b) => b.textContent) })));

await caso('Com vaga e ninguém ofereceu: um cartão curto com "Oferecer" e "Dispensar" (e o próximo horário)', async () => {
  const { page, ctx, reg } = await abrirJoao({ horarios: COM });
  await page.waitForSelector('#ofertas .of-card');
  const c = await cartoes(page), txt = await page.locator('#ofertas').innerText();
  await ctx.close();
  return { ok: c.length === 1 && /4 horários livres/.test(c[0].titulo) && c[0].botoes.join('|') === 'Oferecer|Dispensar' && /ter 17\/11 às 08:00 — Dra\. Teste/.test(txt) && !reg.excecoes.length, detalhe: JSON.stringify(c) + (reg.excecoes[0] ?? '') };
});

await caso('Sem vaga: NÃO oferece horário; propõe a Disponibilidade futura e, ao oferecer, registra e põe o atalho na resposta', async () => {
  const { page, ctx, reg } = await abrirJoao({ horarios: SEM });
  await page.waitForSelector('#ofertas .of-card');
  const c = await cartoes(page);
  await page.click('#ofertas button:has-text("Oferecer Disponibilidade futura")'); await espera(600);
  const caixa = await page.inputValue('#caixa'), rascunho = reg.regs.length === 0;
  await page.click('#btnEnviar'); await page.waitForSelector('#ofertas button:has-text("Aceitou")');
  const depois = await cartoes(page);
  await ctx.close();
  return { ok: rascunho && c.length === 1 && c[0].titulo === 'Sem vaga agora' && !c[0].botoes.includes('Oferecer') && reg.regs.some((r) => r.p_tipo === 'disponibilidade' && r.p_estado === 'oferecido') && /lista de espera/.test(caixa)
    && depois[0].titulo === 'Disponibilidade futura oferecida' && depois[0].botoes.join('|') === 'Aceitou: cadastrar|Recusou', detalhe: JSON.stringify([c, depois, reg.regs]) };
});

await caso('Oferecer horários pelo diálogo registra "oferecido"; "Recusou" registra e o horário nunca mais é oferecido (só a Disponibilidade futura)', async () => {
  const { page, ctx, reg } = await abrirJoao({ horarios: COM });
  await page.waitForSelector('#ofertas .of-card'); await page.click('#ofertas button:has-text("Oferecer")'); await page.waitForSelector('.hor-item');
  await page.locator('.hor-item:has-text("08:00") input').check(); await page.click('dialog button:has-text("Inserir 1 na resposta")'); await espera(500);
  const caixa = await page.inputValue('#caixa'), rascunho = reg.regs.length === 0;
  await page.click('#btnEnviar'); await page.waitForSelector('#ofertas button:has-text("Recusou")');
  const c1 = await cartoes(page);
  await page.click('#ofertas button:has-text("Recusou")'); await espera(500);
  const c2 = await cartoes(page);
  await ctx.close();
  return { ok: rascunho && reg.regs[0]?.p_estado === 'oferecido' && /ter 17\/11 às 08:00/.test(caixa) && c1[0].titulo === 'Horários oferecidos' && c1[0].botoes.join('|') === 'Aceitou|Recusou|Cobrar resposta'
    && reg.regs[1]?.p_estado === 'recusado' && c2.length === 1 && c2[0].titulo === 'Recusou os horários' && !c2[0].botoes.includes('Oferecer') && c2[0].botoes.includes('Oferecer Disponibilidade futura'), detalhe: JSON.stringify([c1, c2, reg.regs]) };
});

await caso('Já recusou antes (memória do banco): ao abrir a conversa NÃO aparece oferta de horário e a consulta de vagas nem é feita', async () => {
  const { page, ctx, reg } = await abrirJoao({ horarios: COM, bd: { horario: 'recusado', disponibilidade: null } });
  await page.waitForSelector('#ofertas .of-card'); await espera(500);
  const c = await cartoes(page);
  await ctx.close();
  return { ok: c.length === 1 && c[0].titulo === 'Recusou os horários' && reg.chamadas.length === 0, detalhe: JSON.stringify(c) + ' consultas=' + reg.chamadas.length };
});

await caso('Recusou horários e também a Disponibilidade futura: nenhum cartão', async () => {
  const { page, ctx } = await abrirJoao({ horarios: COM, bd: { horario: 'recusado', disponibilidade: 'recusado' } });
  await page.waitForSelector('#chatTopo'); await espera(700);
  const n = await page.locator('#ofertas .of-card').count();
  await ctx.close();
  return { ok: n === 0, detalhe: 'cartões=' + n };
});

await caso('"Dispensar" some com o cartão e não volta (horário dispensado + vaga)', async () => {
  const { page, ctx, reg } = await abrirJoao({ horarios: COM });
  await page.waitForSelector('#ofertas .of-card'); await page.click('#ofertas button:has-text("Dispensar")'); await espera(600);
  const n = await page.locator('#ofertas .of-card').count();
  await ctx.close();
  return { ok: n === 0 && reg.regs[0]?.p_estado === 'dispensado' && reg.regs[0]?.p_tipo === 'horario', detalhe: JSON.stringify(reg.regs) };
});

await caso('Disponibilidade futura oferecida: "Aceitou: cadastrar" chama o cadastro da equipe e põe a mensagem de confirmação na resposta', async () => {
  const { page, ctx, reg } = await abrirJoao({ horarios: SEM, bd: { horario: 'recusado', disponibilidade: 'oferecido' } });
  await page.waitForSelector('#ofertas .of-card'); await page.click('#ofertas button:has-text("Aceitou: cadastrar")'); await espera(700);
  const caixa = await page.inputValue('#caixa'), n = await page.locator('#ofertas .of-card').count();
  await ctx.close();
  return { ok: reg.cadastros.length === 1 && reg.cadastros[0].p_conversa === 'c2' && /incluído em nossa lista de espera/.test(caixa) && n === 0, detalhe: JSON.stringify(reg.cadastros) + ' ' + caixa };
});

await caso('"Cobrar resposta" coloca o atalho de cobrança na caixa (sem enviar)', async () => {
  const { page, ctx } = await abrirJoao({ horarios: COM, bd: { horario: 'oferecido', disponibilidade: null } });
  await page.waitForSelector('#ofertas .of-card'); await page.click('#ofertas button:has-text("Cobrar resposta")'); await espera(500);
  const caixa = await page.inputValue('#caixa');
  await ctx.close();
  return { ok: /conseguiu verificar as opções de horários/.test(caixa), detalhe: caixa };
});

await caso('Conversa que não é minha ou encerrada: sem cartões de oferta', async () => {
  const { page, ctx } = await abrir({ horarios: COM });
  await page.click('.chip:has-text("Abertas")'); await page.click('.item:has-text("Ana Paula")'); await page.waitForSelector('#chatTopo'); await espera(600);
  const n = await page.locator('#ofertas .of-card').count();
  await ctx.close();
  return { ok: n === 0, detalhe: 'cartões=' + n };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
