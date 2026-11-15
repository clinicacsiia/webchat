// FLUXOGRAMA: entrada (acesso/index.html num Chromium de celular; chamadas desviadas para o banco de teste com o retrato da produção + acesso rápido + pendências) -> validação (cadastro novo; cartão "Falta pouco" com CPF dela, do filho e e-mail) -> lógica (CPF inválido recusado na tela e no servidor; salvar some com o cartão; "Agora não" esconde; nada da clínica aparece) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (pendências para todo paciente)
// Prova a página e o banco JUNTOS. Dados inventados; não fala com o Supabase de verdade.
import { readFileSync } from 'node:fs';
import { chromium } from './mock-chat.mjs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db } = await criarBancoProducao();
const { q } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-chat.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-pendencias.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-filhos.sql`, 'utf8'));
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const HTML = readFileSync(`${REPO}/acesso/index.html`, 'utf8');
const ORIGEM = 'https://acesso.teste.local';
const API = 'https://nrvuynjwcgwpjdptkiay.supabase.co';
const chamadasRede = [];

// Fila única: o banco de teste tem uma conexão só.
let fila = Promise.resolve();
const serializar = (fn) => { const r = fila.then(fn, fn); fila = r.catch(() => {}); return r; };
const infoCache = new Map();
async function chamarFuncao(nome, corpo) {
  let info = infoCache.get(nome);
  if (!info) {
    info = (await db.query(`select p.proargnames as nomes, (select array_agg(format_type(t, null) order by o) from unnest(p.proargtypes::oid[]) with ordinality as x(t, o)) as tipos
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [nome])).rows[0];
    infoCache.set(nome, info);
  }
  if (!info) return { status: 404, corpo: { message: 'função inexistente' } };
  const partes = [], valores = [];
  Object.entries(corpo || {}).forEach(([k, v]) => {
    const i = info.nomes.indexOf(k);
    if (i < 0) throw new Error(`parâmetro desconhecido em ${nome}: ${k}`);
    valores.push(info.tipos[i] === 'jsonb' ? (v === null ? null : JSON.stringify(v)) : info.tipos[i] === 'boolean' ? v === true : v === null ? null : String(v));
    partes.push(`${k} => $${valores.length}::${info.tipos[i]}`);
  });
  await db.exec('reset role; set role anon');
  try { return { status: 200, corpo: (await db.query(`select public.${nome}(${partes.join(', ')}) as r`, valores)).rows[0].r }; }
  catch (e) { return { status: 400, corpo: { message: e.message } }; }
  finally { await db.exec('reset role'); }
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const erros = [];
async function novaPagina(caminho = '/') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push('console: ' + m.text()); });
  await ctx.route(`${ORIGEM}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: new URL(r.request().url()).pathname === '/' ? '<!doctype html><title>chat</title><body>CHAT-DE-MENTIRA</body>' : HTML }));
  await ctx.route(`${API}/**`, async (r) => {
    const req = r.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const nome = new URL(req.url()).pathname.split('/rpc/')[1];
    const corpo = req.postDataJSON();
    chamadasRede.push({ nome, chaves: Object.keys(corpo || {}), apikey: req.headers()['apikey'], auth: req.headers()['authorization'] });
    const res = await serializar(() => chamarFuncao(nome, corpo));
    return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(res.corpo) });
  });
  await page.goto(`${ORIGEM}/acesso${caminho}`);
  return { ctx, page };
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const texto = (page) => page.locator('#app').innerText();
async function pin(page, digitos) {
  for (const d of digitos) await page.locator(`.pad button[data-k="${d}"]`).click();
  await espera(450);
}
const esperaTexto = (page, re, ms = 4000) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById('app').innerText + document.body.innerText), re.source, { timeout: ms });
const n = async (sqlTexto) => (await q(sqlTexto))[0].n;
const AMANHA = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
const NASC_ANA = '1988-04-12', NASC_LEO = '2019-08-30', NASC_DAVI = '2022-01-10';


await db.exec(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc, cpf) values ('Ana Souza Teste', 'ana souza teste', array['71991230001'], '1988-04-12', '529.982.247-25')`);
let a = await novaPagina();
await a.page.fill('#tel', '71991230001'); await a.page.click('[data-act="c1"]');
await a.page.fill('#nome', 'Ana Souza Teste'); await a.page.fill('#nasc', '1988-04-12'); await a.page.click('[data-act="c2"]');
await a.page.click('[data-act="tf"][data-v="1"]');
await a.page.fill('#fnome', 'Leo Souza Teste'); await a.page.fill('#fnasc', '2019-08-30'); await a.page.click('[data-act="addf"]');
await a.page.click('[data-act="c3"]'); await a.page.click('[data-act="c4skip"]');
await pin(a.page, '1357'); await pin(a.page, '1357');
await a.page.waitForURL((u) => u.pathname === '/', { timeout: 6000 });

await caso('depois do cadastro a pessoa vai ao chat e não vê cartão pedindo informação (15/11/2026: o que falta só é pedido na entrada, com o PIN obrigatório)', async () => {
  await espera(500);
  const t = await a.page.locator('body').innerText();
  return { ok: !/Falta pouco/.test(t) && (await a.page.locator('#pend').count()) === 0, detalhe: t.slice(0, 100).replace(/\n/g, ' | ') };
});
await caso('nada da base da clínica aparece na tela (nem CPF, nem "cadastro encontrado")', async () => {
  const t = await a.page.content();
  return { ok: !t.includes('529.982.247-25') && !t.includes('52998224725') && !/encontramos|já temos seu cadastro/i.test(t) };
});
await caso('Meus dados também não mostra cartão pedindo informação', async () => {
  await a.page.goto(`${ORIGEM}/acesso/?ir=dados`); await esperaTexto(a.page, /Nascimento/);
  return { ok: (await a.page.locator('#pend').count()) === 0 };
});

// ---- filho com o nome da mãe (o caso real: uma mãe cadastrou um "filho" com o próprio nome)
const h = await novaPagina();
await h.page.fill('#tel', '71991230020'); await h.page.click('[data-act="c1"]');
await h.page.fill('#nome', 'Elisa Prado Teste'); await h.page.fill('#nasc', '1990-01-01'); await h.page.click('[data-act="c2"]');
await h.page.click('[data-act="tf"][data-v="1"]');
await caso('cadastro: colocar a si mesma como filha (mesmo nome e mesmo nascimento) é recusado na tela, sem chamar o servidor', async () => {
  const antes = chamadasRede.length;
  await h.page.fill('#fnome', 'Elisa Prado Teste'); await h.page.fill('#fnasc', '1990-01-01'); await h.page.click('[data-act="addf"]');
  return { ok: /seu próprio cadastro/.test(await texto(h.page)) && chamadasRede.length === antes && (await h.page.locator('[data-act="rmf"]').count()) === 0 };
});
await caso('mesmo nome da mãe com outro nascimento: pergunta "É outra pessoa?"; ao confirmar a filha entra na lista', async () => {
  await h.page.fill('#fnome', 'Elisa Prado Teste'); await h.page.fill('#fnasc', '2016-06-06'); await h.page.click('[data-act="addf"]');
  await esperaTexto(h.page, /O nome é igual ao seu/);
  await h.page.click('[data-act="confirmar"]');
  await esperaTexto(h.page, /06\/06\/2016/);
  return { ok: (await h.page.locator('[data-act="rmf"]').count()) === 1 };
});
await caso('um filho de nome diferente entra direto, e o mesmo filho digitado duas vezes vira um só no banco', async () => {
  for (let i = 0; i < 2; i++) { await h.page.fill('#fnome', 'Rui Prado Teste'); await h.page.fill('#fnasc', '2018-08-08'); await h.page.click('[data-act="addf"]'); }
  await h.page.click('[data-act="c3"]'); await h.page.click('[data-act="c4skip"]');
  await pin(h.page, '1357'); await pin(h.page, '1357'); await h.page.waitForURL((u) => u.pathname === '/', { timeout: 6000 });
  const f = await q(`select f.nome from public.app_filho f join public.app_paciente p on p.id = f.responsavel_id where p.telefone = '71991230020' order by f.nome`);
  return { ok: f.length === 2 && f[0].nome === 'Elisa Prado Teste' && f[1].nome === 'Rui Prado Teste', detalhe: f.map((x) => x.nome).join('|') };
});
await caso('Meus dados > adicionar filho com o nome dela: pede confirmação e só entra depois de confirmar (não duplica)', async () => {
  await h.page.goto(`${ORIGEM}/acesso/?ir=dados`); await esperaTexto(h.page, /Meus dados/);
  await h.page.click('[data-act="sheet"][data-t="filho"]');
  await h.page.fill('#fnome', 'Elisa Prado Teste'); await h.page.fill('#fnasc', '2012-02-02'); await h.page.click('[data-act="sf"]');
  await esperaTexto(h.page, /O nome é igual ao seu/);
  await h.page.click('[data-act="confirmar"]'); await espera(500);
  const n1 = (await q(`select count(*)::int n from public.app_filho f join public.app_paciente p on p.id = f.responsavel_id where p.telefone = '71991230020'`))[0].n;
  return { ok: n1 === 3, detalhe: String(n1) };
});
await caso('nenhum erro de script nem violação da política de segurança do navegador durante todo o roteiro', async () => ({ ok: erros.length === 0, detalhe: erros.slice(0, 3).join(' ; ') }));

await browser.close();
const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
