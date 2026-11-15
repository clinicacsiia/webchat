// FLUXOGRAMA: entrada (acesso/index.html aberto num Chromium de celular; API do Supabase e do Auth desviadas para o banco de teste com o retrato da produção + acesso-rapido-paciente.sql + acesso-rapido-chat.sql + acesso-rapido-conta-antiga.sql) -> validação (contas antigas inventadas; e-mail e senha conferidos por um Auth de mentira; a sessão vira o papel "authenticated" no banco) -> lógica (entrar uma última vez, ver o que já temos, completar o que falta, criar o PIN, cair no acesso rápido; sessão do chat reaproveitada; conta já migrada avisa) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (contas antigas viram acesso rápido)
// Prova a página e o banco JUNTOS. Não fala com o Supabase de verdade. Dados inventados.
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
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-conta-antiga.sql`, 'utf8'));
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const HTML = readFileSync(`${REPO}/acesso/index.html`, 'utf8');
const ORIGEM = 'https://acesso.teste.local';
const API = 'https://nrvuynjwcgwpjdptkiay.supabase.co';
const SENHA = 'senha-certa-123';
const logouts = [];

// Fila única: o banco de teste tem uma conexão só.
let fila = Promise.resolve();
const serializar = (fn) => { const r = fila.then(fn, fn); fila = r.catch(() => {}); return r; };
const infoCache = new Map();
async function chamarFuncao(nome, corpo, uid) {
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
    valores.push(info.tipos[i] === 'jsonb' ? (v === null ? null : JSON.stringify(v)) : v === null ? null : String(v));
    partes.push(`${k} => $${valores.length}::${info.tipos[i]}`);
  });
  await db.exec('reset role');
  if (uid) { await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await db.exec('set role authenticated'); }
  else await db.exec('set role anon');
  try { return { status: 200, corpo: (await db.query(`select public.${nome}(${partes.join(', ')}) as r`, valores)).rows[0].r }; }
  catch (e) { return { status: 400, corpo: { message: e.message } }; }
  finally { await db.exec('reset role'); }
}


const CPF = '52998224725';
const pac = (await q(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc, cpf) values ('Ana Souza Teste', 'ana souza teste', array['71991230001'], '1988-04-12', '${CPF}') returning id`))[0].id;
const ids = {};
for (const [k, email] of [['ana', 'ana@exemplo.invalid'], ['bia', 'bia@exemplo.invalid'], ['chat', 'chat@exemplo.invalid']]) ids[k] = (await q(`insert into auth.users (id, email) values (gen_random_uuid(), '${email}') returning id`))[0].id;
await db.exec(`
  insert into public.contas_paciente (id, email, nome, telefone, paciente_id) values ('${ids.ana}', 'ana@exemplo.invalid', 'Ana Souza Teste', '71991230001', '${pac}');
  insert into public.contas_paciente (id, email) values ('${ids.bia}', 'bia@exemplo.invalid');
  insert into public.contas_paciente (id, email, nome, telefone) values ('${ids.chat}', 'chat@exemplo.invalid', 'Carla Chat Teste', '71991230005');
`);
const tokenDe = (uid) => `tok-${uid}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const erros = [];
async function novaPagina(caminho = '/', semente = null) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  if (semente) await ctx.addInitScript(([k, v]) => { try { if (!sessionStorage.getItem('_semeado')) { localStorage.setItem(k, v); sessionStorage.setItem('_semeado', '1'); } } catch (e) { /* ignora */ } }, semente);   // semeia só na 1ª carga (a página depois recarrega ao voltar para o chat)
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push('console: ' + m.text()); });
  await ctx.route(`${ORIGEM}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML }));
  await ctx.route(`${API}/**`, async (r) => {
    const req = r.request(), u = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const json = (status, corpo) => r.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    if (u.pathname === '/auth/v1/token') {   // Auth de mentira: e-mail conhecido + senha certa
      const { email, password } = req.postDataJSON();
      const linha = (await serializar(async () => (await db.query(`select id from auth.users where email = $1`, [email])).rows[0]));
      if (linha && password === SENHA) return json(200, { access_token: tokenDe(linha.id), token_type: 'bearer' });
      return json(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    if (u.pathname === '/auth/v1/logout') { logouts.push(req.headers()['authorization']); return json(204, {}); }
    if (u.pathname === '/auth/v1/recover') return json(200, {});
    const nome = u.pathname.split('/rpc/')[1];
    const auth = req.headers()['authorization'] || '';
    const uid = auth.startsWith('Bearer tok-') ? auth.slice(11) : null;
    const res = await serializar(() => chamarFuncao(nome, req.postDataJSON(), uid));
    return json(res.status, res.corpo);
  });
  await page.goto(`${ORIGEM}${caminho}`);
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
const entrarComEmail = async (page, email, senha) => { await page.fill('#aem', email); await page.fill('#asen', senha); await page.click('[data-act="antiga"]'); };

// ================================================================= Ana: conta completa (cadastro da clínica ligado)
const a = await novaPagina();
await caso('a tela inicial e a de entrar têm o atalho "Tenho conta com e-mail e senha"', async () => {
  const t1 = await texto(a.page);
  await a.page.click('[data-act="go"][data-v="entrar"]'); const t2 = await texto(a.page);
  await a.page.click('[data-act="go"][data-v="antiga"]');
  return { ok: /Tenho conta com e-mail e senha/.test(t1) && /Tenho conta com e-mail e senha/.test(t2) && /uma última vez/.test(await texto(a.page)) };
});
await caso('senha errada: "E-mail ou senha incorretos." e nada é criado', async () => {
  await entrarComEmail(a.page, 'ana@exemplo.invalid', 'errada-123');
  await esperaTexto(a.page, /E-mail ou senha incorretos/);
  return { ok: (await n(`select count(*)::int n from public.app_paciente`)) === 0 };
});
await caso('senha certa: mostra o que já temos (e-mail, CPF mascarado) e deixa celular, nome e nascimento já preenchidos', async () => {
  await entrarComEmail(a.page, 'ana@exemplo.invalid', SENHA);
  await esperaTexto(a.page, /Confira os seus dados/);
  const t = await texto(a.page);
  const v = await a.page.evaluate(() => ({ tel: document.getElementById('tel').value, nome: document.getElementById('nome').value, nasc: document.getElementById('nasc').value }));
  return { ok: /ana@exemplo\.invalid/.test(t) && /\*\*\*\.\*\*\*\.\*\*\*-25/.test(t) && !t.includes(CPF) && v.tel === '(71) 99123-0001' && v.nome === 'Ana Souza Teste' && v.nasc === '1988-04-12', detalhe: JSON.stringify(v) };
});
await caso('Continuar leva ao PIN; PINs diferentes são recusados; PINs iguais criam o acesso rápido e abrem "Olá, Ana"', async () => {
  await a.page.click('[data-act="antiga2"]');
  await esperaTexto(a.page, /Crie seu PIN/);
  await pin(a.page, '1357'); await esperaTexto(a.page, /Confirme o PIN/);
  await pin(a.page, '9999'); await esperaTexto(a.page, /não conferem/);
  await pin(a.page, '1357'); await pin(a.page, '1357');
  await esperaTexto(a.page, /Olá, Ana/);
  const r = (await q(`select cpf, email, telefone, conta_antiga_id from public.app_paciente`))[0];
  return { ok: r.cpf === CPF && r.email === 'ana@exemplo.invalid' && r.telefone === '71991230001' && r.conta_antiga_id === ids.ana, detalhe: JSON.stringify({ ...r, cpf: '***' }) };
});
await caso('a conta antiga sai do aparelho (logout no Auth) e o aparelho guarda só o código do acesso rápido', async () => {
  const st = await a.page.evaluate(() => ({ acesso: localStorage.getItem('csi_acesso_v2'), antiga: localStorage.getItem('csi-paciente-auth') }));
  return { ok: logouts.includes('Bearer ' + tokenDe(ids.ana)) && !!st.acesso && JSON.parse(st.acesso).dev && st.antiga === null && !/1357|ana@exemplo|529/.test(st.acesso), detalhe: st.acesso && st.acesso.slice(0, 30) };
});
await caso('Meus dados mostra nome, nascimento, celular, e-mail e CPF mascarado de forma clara', async () => {
  await a.page.click('[data-act="go"][data-v="dados"]');
  await esperaTexto(a.page, /Meus dados/);
  const t = await texto(a.page);
  return { ok: /Ana Souza Teste/.test(t) && /12\/04\/1988/.test(t) && /\(71\) 99123-0001/.test(t) && /ana@exemplo\.invalid/.test(t) && /\*\*\*\.\*\*\*\.\*\*\*-25/.test(t) && !t.includes(CPF), detalhe: t.slice(0, 200).replace(/\n/g, ' | ') };
});

// ================================================================= Bia: conta só com e-mail (falta tudo)
const b = await novaPagina();
await b.page.click('[data-act="go"][data-v="antiga"]');
await entrarComEmail(b.page, 'bia@exemplo.invalid', SENHA);
await esperaTexto(b.page, /Confira os seus dados/);
await caso('conta só com e-mail: campos em branco, e o servidor/página não deixam seguir sem celular, nome e nascimento válidos', async () => {
  const vazio = await b.page.evaluate(() => ['tel', 'nome', 'nasc'].every((id) => document.getElementById(id).value === ''));
  await b.page.click('[data-act="antiga2"]'); const e1 = /Celular inválido/.test(await texto(b.page));
  await b.page.fill('#tel', '71991230009'); await b.page.click('[data-act="antiga2"]'); const e2 = /nome e sobrenome/.test(await texto(b.page));
  await b.page.fill('#nome', 'Bia Costa Teste'); await b.page.click('[data-act="antiga2"]'); const e3 = /Data de nascimento inválida/.test(await texto(b.page));
  await b.page.fill('#nasc', '2015-01-01'); await b.page.click('[data-act="antiga2"]'); const e4 = /maior de 18/.test(await texto(b.page));
  return { ok: vazio && e1 && e2 && e3 && e4, detalhe: [vazio, e1, e2, e3, e4].join() };
});
await caso('completando os dados e criando o PIN a Bia entra; o celular novo vira o login', async () => {
  await b.page.fill('#nasc', '1990-02-03'); await b.page.click('[data-act="antiga2"]');
  await pin(b.page, '2468'); await pin(b.page, '2468');
  await esperaTexto(b.page, /Olá, Bia/);
  const r = (await q(`select telefone, cpf from public.app_paciente where conta_antiga_id = '${ids.bia}'`))[0];
  return { ok: r.telefone === '71991230009' && r.cpf === null, detalhe: JSON.stringify(r) };
});

// ================================================================= Carla: veio do chat com a conta já logada (sem digitar a senha de novo)
const sessaoChat = JSON.stringify({ access_token: tokenDe(ids.chat), expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ids.chat } });
const c = await novaPagina('/?voltar=chat&antiga=1', ['csi-paciente-auth', sessaoChat]);
await caso('vindo do chat (?antiga=1) com a conta logada: pula a senha, mostra os dados e já traz nome e celular da conta', async () => {
  await esperaTexto(c.page, /Confira os seus dados/);
  const v = await c.page.evaluate(() => ({ tel: document.getElementById('tel').value, nome: document.getElementById('nome').value }));
  return { ok: v.tel === '(71) 99123-0005' && v.nome === 'Carla Chat Teste', detalhe: JSON.stringify(v) };
});
await caso('terminando o PIN a página devolve para o chat, e a sessão da conta antiga foi apagada deste aparelho', async () => {
  await c.page.fill('#nasc', '1985-05-05'); await c.page.click('[data-act="antiga2"]');
  await pin(c.page, '1357'); await pin(c.page, '1357');
  await c.page.waitForURL(`${ORIGEM}/`, { timeout: 4000 });
  const st = await c.page.evaluate(() => ({ antiga: localStorage.getItem('csi-paciente-auth'), acesso: !!localStorage.getItem('csi_acesso_v2') }));
  return { ok: st.antiga === null && st.acesso === true, detalhe: JSON.stringify(st) };
});

// ================================================================= Quem já migrou e tenta de novo
const d = await novaPagina();
await d.page.click('[data-act="go"][data-v="antiga"]');
await entrarComEmail(d.page, 'ana@exemplo.invalid', SENHA);
await caso('conta que já criou o PIN: avisa e manda entrar com celular + PIN (não cria outro acesso)', async () => {
  await esperaTexto(d.page, /já criou o seu PIN/);
  return { ok: (await n(`select count(*)::int n from public.app_paciente where conta_antiga_id = '${ids.ana}'`)) === 1 && /Entrar/.test(await texto(d.page)) };
});
await caso('"Esqueci a senha" pede o link sem revelar se o e-mail tem conta', async () => {
  const e = await novaPagina(); await e.page.click('[data-act="go"][data-v="antiga"]');
  await e.page.fill('#aem', 'ninguem@exemplo.invalid'); await e.page.click('[data-act="antigaesq"]');
  await esperaTexto(e.page, /Se este e-mail tiver conta/);
  return { ok: true };
});
await caso('nenhum erro de script nem violação da política de segurança do navegador durante todo o roteiro', async () => ({ ok: erros.length === 0, detalhe: erros.slice(0, 3).join(' ; ') }));

await browser.close();
const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
