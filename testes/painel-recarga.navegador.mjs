// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado, inclusive o canal de tempo real por WebSocket) -> validação (uma rajada de eventos "conversa mudou", como acontece quando chegam mensagens) -> lógica (conta quantas vezes o painel releu a lista e quantas vezes pediu as consultas pesadas) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (auditoria de 11/11/2026)
//
// Por que existe: na produção, pessoa_sugestoes e pessoa_avisos_data (que cruzam todas as conversas de 120 dias) eram chamadas a CADA evento,
// em cada painel aberto: 15 mil chamadas e a maior fatia do tempo do banco. E cada evento disparava a sua releitura, mesmo com outra em andamento.
// O tempo real é simulado com o protocolo do Supabase Realtime (Phoenix): o teste aceita a inscrição do painel e empurra os eventos.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const EU = { id: '11111111-1111-4111-8111-111111111111', nome: 'Admin de Teste', email: 'a@teste.local', papel: 'admin', ativo: true };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const agora = new Date().toISOString();
const conversa = (id, nome, status) => ({ id, status, agente_id: null, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, contatos: { id: 'ct-' + id, nome, telefone: '71900000000', email: null } });
const CONVERSAS = [conversa('c1', 'Maria Souza', 'aguardando'), conversa('c2', 'João Lima', 'aguardando')];
const jwt = (sub) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.x`; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      const c = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let a = join(RAIZ, c); if (existsSync(a) && !extname(a)) a = join(a, 'index.html');
      if (!existsSync(a)) { res.writeHead(404); res.end('x'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(a)] ?? 'application/octet-stream' }); res.end(await readFile(a));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}

async function pagina(browser, { atrasoConversas = 0 } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
  }, [EU.id, jwt(EU.id), EU.email]);
  const reg = { excecoes: [], n: {}, emVoo: 0, maxEmVoo: 0, canais: [], atrasoConversas };
  const conta = (k) => { reg.n[k] = (reg.n[k] || 0) + 1; };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => reg.excecoes.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url()); const p = url.pathname;
    const objeto = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    let corpo;
    if (p.startsWith('/auth/v1/user')) corpo = { id: EU.id, aud: 'authenticated', role: 'authenticated', email: EU.email };
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? EU : [EU]) : [EU];
    else if (p.startsWith('/rest/v1/conversas') && req.method() === 'GET') {
      conta('conversas'); reg.emVoo++; reg.maxEmVoo = Math.max(reg.maxEmVoo, reg.emVoo);
      if (reg.atrasoConversas) await espera(reg.atrasoConversas);
      reg.emVoo--; corpo = CONVERSAS;
    } else if (p.startsWith('/rest/v1/rpc/')) { const nome = p.split('/').pop(); conta(nome); corpo = ['pessoa_sugestoes', 'pessoa_avisos_data', 'paciente_avisos', 'equipe_pedidos', 'painel_anexos_resumo'].includes(nome) ? [] : {}; }
    else if (p.startsWith('/rest/v1/')) { conta(p.split('/').pop()); corpo = objeto ? null : []; }
    else corpo = {};
    return rota.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  // Tempo real simulado: aceita cada inscrição (devolvendo um número para cada assinatura pedida) e guarda o canal para o teste empurrar eventos.
  await page.routeWebSocket(/supabase\.co\/realtime/, (ws) => {
    ws.onMessage((txt) => {
      let m; try { m = JSON.parse(txt); } catch { return; }
      if (m.event === 'heartbeat') { ws.send(JSON.stringify({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: m.ref })); return; }
      if (m.event === 'phx_join') {
        const pedidas = (m.payload && m.payload.config && m.payload.config.postgres_changes) || [];
        const assinaturas = pedidas.map((b, i) => ({ ...b, id: 1000 + reg.canais.length * 100 + i }));
        reg.canais.push({ topico: m.topic, assinaturas, enviar: (dados) => ws.send(JSON.stringify(dados)) });
        ws.send(JSON.stringify({ topic: m.topic, event: 'phx_reply', payload: { status: 'ok', response: { postgres_changes: assinaturas } }, ref: m.ref }));
        return;
      }
      if (m.ref) ws.send(JSON.stringify({ topic: m.topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: m.ref }));
    });
  });
  // Empurra "a conversa mudou" como o Supabase faz quando chega uma mensagem (a linha de conversas é atualizada).
  reg.conversaMudou = (id = 'c1') => {
    const canal = reg.canais.find((c) => c.topico === 'realtime:painel-atendimento'); if (!canal) throw new Error('o painel não se inscreveu no canal de atendimento');
    const a = canal.assinaturas.find((x) => x.table === 'conversas');
    canal.enviar({ topic: canal.topico, event: 'postgres_changes', ref: null,
      payload: { ids: [a.id], data: { type: 'UPDATE', schema: 'public', table: 'conversas', commit_timestamp: new Date().toISOString(), columns: [], record: { id }, old_record: { id }, errors: null } } });
  };
  return { page, ctx, reg };
}

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const abrir = async (opcoes) => {
  const r = await pagina(browser, opcoes);
  await r.page.goto(`${base}/painel/`);
  await r.page.waitForSelector('.modo', { timeout: 10000 });
  await r.page.waitForFunction(() => document.getElementById('pontoVivo') && document.getElementById('pontoVivo').className === 'on', null, { timeout: 10000 });
  await espera(900);   // a releitura que acontece logo depois de o tempo real conectar
  return r;
};

await caso('o painel conecta no tempo real simulado e a lista aparece', async () => {
  const { page, ctx, reg } = await abrir();
  const itens = await page.$$eval('.item', (ns) => ns.length);
  const ok = itens >= 2 && reg.canais.some((c) => c.topico === 'realtime:painel-atendimento') && reg.excecoes.length === 0;
  await ctx.close();
  return { ok, detalhe: `${itens} conversas na lista; canais: ${reg.canais.map((c) => c.topico).join(', ')}` };
});

await caso('10 eventos espaçados (10 mensagens chegando): a lista é relida a cada um, mas as consultas PESADAS não se repetem', async () => {
  const { ctx, reg } = await abrir();
  const antes = { ...reg.n };
  for (let i = 0; i < 10; i++) { reg.conversaMudou(i % 2 ? 'c1' : 'c2'); await espera(420); }
  await espera(700);
  const d = (k) => (reg.n[k] || 0) - (antes[k] || 0);
  const ok = d('conversas') >= 8 && d('pessoa_sugestoes') === 0 && d('pessoa_avisos_data') === 0 && d('paciente_avisos') >= 8 && reg.excecoes.length === 0;
  await ctx.close();
  return { ok, detalhe: `releituras da lista=${d('conversas')}; pessoa_sugestoes=${d('pessoa_sugestoes')}; pessoa_avisos_data=${d('pessoa_avisos_data')}; avisos leves=${d('paciente_avisos')}` };
});

await caso('ao abrir a aba Avisos as consultas pesadas são refeitas na hora (a equipe sempre vê o dado fresco quando vai decidir)', async () => {
  const { page, ctx, reg } = await abrir();
  await espera(3200);   // passa a janela em que a leitura da abertura ainda vale
  const antes = reg.n.pessoa_sugestoes || 0;
  await page.click('nav button[data-aba="avisos"]');   // o primeiro toque também redesenha a tela (pedido de permissão de avisos): não pode triplicar a consulta
  await page.waitForSelector('#paginaAvisos', { timeout: 5000 }); await espera(600);
  const depois = reg.n.pessoa_sugestoes || 0;
  await ctx.close();
  return { ok: depois === antes + 1, detalhe: `antes=${antes} depois=${depois}` };
});

await caso('servidor lento + rajada de 12 eventos: nunca há duas releituras ao mesmo tempo, e no fim a lista fica atualizada', async () => {
  const { ctx, reg } = await abrir();
  reg.atrasoConversas = 700; reg.maxEmVoo = 0;
  const antes = reg.n.conversas || 0;
  for (let i = 0; i < 12; i++) { reg.conversaMudou('c1'); await espera(300); }   // 3,6 s de eventos; cada releitura leva 0,7 s
  await espera(2200);
  const feitas = (reg.n.conversas || 0) - antes, emVoo = reg.emVoo;
  reg.atrasoConversas = 0;
  await ctx.close();
  return { ok: reg.maxEmVoo === 1 && feitas >= 3 && feitas <= 8 && emVoo === 0 && reg.excecoes.length === 0, detalhe: `releituras=${feitas} para 12 eventos; ao mesmo tempo no máximo ${reg.maxEmVoo}` };
});

await browser.close(); srv.close();
const passou = resultados.filter(Boolean).length;
console.log(`\n${passou} de ${resultados.length} verificações passaram.`);
process.exit(passou === resultados.length ? 0 : 1);
