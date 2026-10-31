// FLUXOGRAMA: entrada (repositório servido localmente + Supabase simulado) -> validação (cada página abre sem exceção de JavaScript e mostra a tela esperada) -> lógica (chat deslogado e com formulário; painel deslogado e logado como admin; fila sem token e com token inválido) -> saída (PASS/FAIL por página e código de saída)
// Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
//
// Teste de fumaça: prova que o JavaScript de cada página carrega e monta a tela. Não substitui o teste com o Supabase real.
// Requer: npm install (nesta pasta) e um Chromium para o Playwright (npx playwright install chromium).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const RAIZ = resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST_SUPABASE = 'nrvuynjwcgwpjdptkiay.supabase.co';
const ADMIN = { id: '11111111-1111-4111-8111-111111111111', nome: 'Administrador de Teste', email: 'admin@teste.local', papel: 'admin', ativo: true };

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      let caminho = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let arquivo = join(RAIZ, caminho);
      if (existsSync(arquivo) && !extname(arquivo)) arquivo = join(arquivo, 'index.html');
      if (!existsSync(arquivo)) { res.writeHead(404); res.end('não encontrado'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(arquivo)] ?? 'application/octet-stream' });
      res.end(await readFile(arquivo));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}

function jwtFalso(sub) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.assinatura`;
}

// Forma real de ia_relatorio, lida do banco de produção (só chaves e números zerados).
const RELATORIO = { dias: 28, desde: '2026-10-02T10:58:04+00:00', resumo: { criados: 0, cancelados: 0, abandonados: 0, em_andamento: 0, agendados_auto: 0, agendados_manual: 0,
  com_alerta_agora: 0, prontos_esperando: 0, agendados_auto_sem_alerta: 0 }, alertas: {}, semanas: [], conversas: { total: 0, assumidas_por_atendente: 0 },
  atendentes: { cancelou: 0, desfez_agendado: 0, marcou_agendado: 0, cancelou_com_motivo: 0 }, observacao: 'teste', registro_desde: '2026-10-30T10:30:19+00:00',
  exames_problema: [], abandono_por_etapa: {}, pedidos_sem_registro: 0, tempo_mediano_pronto_agendado_min: null };

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

async function novaPagina(browser, { logado = false, vinculos = [] } = {}) {
  const ctx = await browser.newContext();
  const decisoes = [];
  if (logado) {
    await ctx.addInitScript(([id, jwt, email]) => {
      localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({
        access_token: jwt, refresh_token: 'x', token_type: 'bearer', expires_in: 86400,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} },
      }));
    }, [ADMIN.id, jwtFalso(ADMIN.id), ADMIN.email]);
  }
  const erros = { excecoes: [], consoleErros: [], pedidosNaoSimulados: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.excecoes.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|WebSocket|Failed to load resource/.test(m.text())) erros.consoleErros.push(m.text()); });

  // O Playwright aplica primeiro a rota registrada por último: o bloqueio genérico vem antes das rotas específicas.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());   // fontes e afins: bloqueia
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: require('node:fs').readFileSync(UMD) }));
  await ctx.route(`https://${HOST_SUPABASE}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    const objeto = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    let corpo;
    if (url.pathname.endsWith('/rpc/vinculo_listar')) corpo = vinculos;
    else if (url.pathname.endsWith('/rpc/vinculo_decidir')) { decisoes.push(JSON.parse(req.postData() || '{}')); corpo = { ok: true }; }
    else if (url.pathname.endsWith('/rpc/chat_config')) corpo = { nome_empresa: 'Clínica de Teste', boas_vindas: 'Olá! Como podemos ajudar?' };
    else if (url.pathname.startsWith('/auth/v1/user')) corpo = { id: ADMIN.id, aud: 'authenticated', role: 'authenticated', email: ADMIN.email };
    else if (url.pathname.startsWith('/rest/v1/agentes')) corpo = objeto ? ADMIN : [ADMIN];
    else if (url.pathname.endsWith('/rpc/catalogo_mudancas') || url.pathname.endsWith('/rpc/ia_exemplos')) corpo = [];
    else if (url.pathname.endsWith('/rpc/ia_relatorio')) corpo = RELATORIO;
    else if (url.pathname.endsWith('/rpc/ia_precos_divergentes')) corpo = { comparados: 0, divergentes: [], sem_referencia: 0, com_varias_linhas: 0, divergentes_total: 0, atualizado_em: new Date().toISOString() };
    else if (url.pathname.startsWith('/rest/v1/rpc/')) corpo = {};   // catalogo_limpeza e demais: objeto vazio é uma forma válida
    else if (url.pathname.startsWith('/rest/v1/')) corpo = objeto ? null : [];
    else { erros.pedidosNaoSimulados.push(url.pathname); corpo = {}; }
    return rota.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());
  return { page, ctx, erros, decisoes };
}

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
// CHROMIUM_PATH aponta para um Chromium já instalado (ex.: /opt/pw-browsers/chromium); sem ele o Playwright usa o próprio.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

await caso('chat: abre, mostra o formulário e valida campos vazios sem exceção de JS', async () => {
  const { page, ctx, erros } = await novaPagina(browser);
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 8000 });
  await page.click('#btnIniciar');
  await page.waitForTimeout(400);
  const mensagem = (await page.locator('#erroForm').innerText()).trim();
  await ctx.close();
  return { ok: erros.excecoes.length === 0 && mensagem.length > 0, detalhe: erros.excecoes[0] ?? `validação: "${mensagem.slice(0, 60)}"` };
});

await caso('painel (deslogado): mostra a tela de login sem exceção de JS', async () => {
  const { page, ctx, erros } = await novaPagina(browser);
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('text=Painel de atendimento', { timeout: 8000 });
  const campos = await page.locator('#lEmail, #lSenha').count();
  await ctx.close();
  return { ok: erros.excecoes.length === 0 && campos === 2, detalhe: erros.excecoes[0] ?? `campos de login=${campos}` };
});

await caso('painel (admin logado): monta o menu com as 7 seções do administrador', async () => {
  const { page, ctx, erros } = await novaPagina(browser, { logado: true });
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('nav.nav button', { timeout: 10000 });
  const abas = await page.locator('nav.nav button').evaluateAll((bs) => bs.map((b) => b.dataset.aba));
  await ctx.close();
  const esperado = ['atendimento', 'contatos', 'vinculos', 'equipe', 'catalogo', 'aprendizado', 'config'];
  return { ok: erros.excecoes.length === 0 && esperado.every((a) => abas.includes(a)), detalhe: erros.excecoes[0] ?? abas.join(',') };
});

await caso('painel (admin logado): cada aba abre sem exceção de JS', async () => {
  const { page, ctx, erros } = await novaPagina(browser, { logado: true });
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('nav.nav button', { timeout: 10000 });
  for (const aba of ['contatos', 'vinculos', 'equipe', 'catalogo', 'aprendizado', 'config', 'atendimento']) {
    await page.click(`nav.nav button[data-aba="${aba}"]`);
    await page.waitForTimeout(350);
  }
  await ctx.close();
  return { ok: erros.excecoes.length === 0, detalhe: erros.excecoes[0] ?? 'sem exceções' };
});

const AVISO_ATUALIZAR = { id: 7, tipo: 'atualizar', criado_em: '2026-10-31T15:00:00Z', batem: ['nome', 'nascimento', 'telefone'], diferem: ['email'],
  conta: { email: 'maria.nova@exemplo.com', nome: 'Maria da Silva', telefone: '71988710544' },
  cadastro: { nome: 'Maria da Silva', email: 'maria.antiga@exemplo.com', telefones: ['7188710544'], dt_nasc: '1980-03-25', ultima_visita_em: '2026-09-01T10:00:00Z' } };
const PEDIDO_VERIFICAR = { id: 8, tipo: 'verificar', criado_em: '2026-10-31T16:00:00Z', batem: ['nome', 'nascimento'], diferem: ['telefone', 'email'],
  conta: { email: 'joao.novo@exemplo.com', nome: 'João Pereira Lima', telefone: '71977776666' },
  cadastro: { nome: 'João Pereira Lima', email: 'joao.velho@exemplo.com', telefones: ['7133334444'], dt_nasc: '1975-07-10', ultima_visita_em: '2026-08-01T10:00:00Z' } };

await caso('painel (atendente): aba Vínculos mostra o selo, compara conta x cadastro, destaca o que difere e manda a decisão certa', async () => {
  const { page, ctx, erros, decisoes } = await novaPagina(browser, { logado: true, vinculos: [AVISO_ATUALIZAR, PEDIDO_VERIFICAR] });
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('nav.nav button[data-aba="vinculos"]', { timeout: 10000 });
  await page.waitForTimeout(500);
  const selo = await page.locator('#seloVinculos').evaluate((e) => ({ txt: e.textContent, oculto: e.hidden }));
  await page.click('nav.nav button[data-aba="vinculos"]');
  await page.waitForSelector('.cartao-vinculo', { timeout: 5000 });
  const cartoes = await page.locator('.cartao-vinculo').count();
  const difere = await page.locator('.cartao-vinculo').first().locator('tr.difere th').allTextContents();
  const botoes1 = await page.locator('.cartao-vinculo').first().locator('.acoes-vinculo button').allTextContents();
  const botoes2 = await page.locator('.cartao-vinculo').nth(1).locator('.acoes-vinculo button').allTextContents();
  await page.locator('.cartao-vinculo').first().locator('button', { hasText: 'Atualizar o cadastro' }).click();
  await page.waitForTimeout(400);
  await ctx.close();
  const ok = selo.txt === '2' && !selo.oculto && cartoes === 2 && difere.join() === 'E-mail'
    && botoes1.includes('Atualizar o cadastro com os dados novos') && botoes1.includes('Desfazer o vínculo')
    && botoes2.includes('Vincular') && botoes2.includes('Não vincular') && botoes2.includes('Vincular e atualizar o cadastro')
    && decisoes.length === 1 && decisoes[0].p_id === 7 && decisoes[0].p_acao === 'atualizar' && erros.excecoes.length === 0;
  return { ok, detalhe: erros.excecoes[0] ?? JSON.stringify({ selo, cartoes, difere, botoes1, botoes2, decisoes }) };
});

await caso('painel: sem nada para conferir mostra a mensagem vazia e esconde o selo', async () => {
  const { page, ctx, erros } = await novaPagina(browser, { logado: true, vinculos: [] });
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('nav.nav button[data-aba="vinculos"]', { timeout: 10000 });
  await page.click('nav.nav button[data-aba="vinculos"]');
  await page.waitForSelector('.vazio', { timeout: 5000 });
  const txt = await page.locator('.vazio').textContent(), oculto = await page.locator('#seloVinculos').evaluate((e) => e.hidden);
  await ctx.close();
  return { ok: /Nada para conferir/.test(txt) && oculto && erros.excecoes.length === 0, detalhe: erros.excecoes[0] ?? txt };
});

// A tela da Fila foi retirada do repositório (a antiga era incompatível). Os casos voltam sozinhos quando a pasta fila/ voltar.
if (existsSync(join(RAIZ, 'fila', 'index.html'))) {
  await caso('fila: sem token mostra "Link expirado ou inválido" sem exceção de JS', async () => {
    const { page, ctx, erros } = await novaPagina(browser);
    await page.goto(`${base}/fila/`);
    await page.waitForSelector('#estado-expirado:not([hidden])', { timeout: 8000 });
    await ctx.close();
    return { ok: erros.excecoes.length === 0, detalhe: erros.excecoes[0] ?? '' };
  });

  await caso('fila: o token sai da barra de endereço depois de lido', async () => {
    const { page, ctx } = await novaPagina(browser);
    const fake = ['a', Buffer.from(JSON.stringify({ atendimento_id: 'x', exp: 1 })).toString('base64url'), 'c'].join('.');
    await page.goto(`${base}/fila/?token=${fake}`);
    await page.waitForTimeout(500);
    const url = page.url();
    await ctx.close();
    return { ok: !url.includes('token='), detalhe: url.replace(base, '') };
  });

}

await browser.close();
srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
