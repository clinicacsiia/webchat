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
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-pendencias.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-filhos.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-pin-obrigatorio.sql`, 'utf8'));   // app_pre_cadastro (a página pergunta se o celular já tem PIN)
await db.exec(readFileSync(`${REPO}/supabase/acesso-conta-antiga-unir.sql`, 'utf8'));   // app_conta_antiga_unir (a página junta a conta antiga ao PIN que já existe)
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
for (const [k, email] of [['ana', 'ana@exemplo.invalid'], ['bia', 'bia@exemplo.invalid'], ['chat', 'chat@exemplo.invalid'], ['dani', 'dani@exemplo.invalid']]) ids[k] = (await q(`insert into auth.users (id, email) values (gen_random_uuid(), '${email}') returning id`))[0].id;
await db.exec(`
  insert into public.contas_paciente (id, email, nome, telefone, paciente_id) values ('${ids.ana}', 'ana@exemplo.invalid', 'Ana Souza Teste', '71991230001', '${pac}');
  insert into public.contas_paciente (id, email) values ('${ids.bia}', 'bia@exemplo.invalid');
  insert into public.contas_paciente (id, email, nome, telefone) values ('${ids.chat}', 'chat@exemplo.invalid', 'Carla Chat Teste', '71991230005');
  insert into public.contas_paciente (id, email, nome, telefone) values ('${ids.dani}', 'dani@exemplo.invalid', 'Dani Teste Costa', '71991230007');
`);
const tokenDe = (uid) => `tok-${uid}`;
const hist = async (nomeContato, tel, conta, filhos) => {
  const ct = (await q(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, [nomeContato, tel]))[0].id;
  for (const f of filhos) {
    const c = (await q(`insert into public.conversas (contato_id, paciente_tipo, paciente_nome) values ($1, 'filho', $2) returning id`, [ct, f.nome]))[0].id;
    await q(`update public.conversas set conta_id = $2 where id = $1`, [c, conta]);
    await q(`insert into public.pre_agendamentos (conversa_id, paciente) values ($1, $2::jsonb)`, [c, JSON.stringify({ nome: f.nome, ...(f.nasc ? { dt_nasc: f.nasc } : {}), ...(f.cpf ? { cpf: f.cpf } : {}) })]);
  }
};
await hist('Ana Souza Teste', '71991230001', ids.ana, [{ nome: 'Leo Souza Teste', nasc: '30/08/2019', cpf: '529.982.247-25' }, { nome: 'Lia Souza Teste' }, { nome: 'Ana Souza Teste', nasc: '12/04/1988' }]);
await hist('Dani Teste Costa', '71991230007', ids.dani, [{ nome: 'Dani Teste Costa', nasc: '03/03/2013' }]);
await hist('Carla Chat Teste', '71991230005', ids.chat, [{ nome: 'Carla Chat Teste' }]);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const erros = [];
async function novaPagina(caminho = '/', semente = null) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  if (semente) await ctx.addInitScript(([k, v]) => { try { if (!sessionStorage.getItem('_semeado')) { localStorage.setItem(k, v); sessionStorage.setItem('_semeado', '1'); } } catch (e) { /* ignora */ } }, semente);   // semeia só na 1ª carga (a página depois recarrega ao voltar para o chat)
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push('console: ' + m.text()); });
  await ctx.route(`${ORIGEM}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: new URL(r.request().url()).pathname === '/' ? '<!doctype html><title>chat</title><body>CHAT-DE-MENTIRA</body>' : HTML }));
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
await caso('"Seus filhos": Leo (com CPF já salvo, mascarado), Lia (nascimento faltando) e a própria Ana marcada como "Você", sem checkbox', async () => {
  const t = await texto(a.page);
  const marcado = await a.page.locator('[data-fc]').evaluateAll((e) => e.map((x) => x.checked));
  return { ok: /Seus filhos/.test(t) && /Leo Souza Teste/.test(t) && /\*\*\*\.\*\*\*\.\*\*\*-25/.test(t) && /Lia Souza Teste/.test(t) && /faltando/.test(t) && /É você: já está no seu cadastro/.test(t) && marcado.length === 2 && marcado.every(Boolean) && !t.includes(CPF), detalhe: String(marcado) };
});
await caso('sem o nascimento da Lia o servidor/página não deixam seguir; com ele segue', async () => {
  await a.page.click('[data-act="antiga2"]'); const e1 = /Informe a data de nascimento de Lia/.test(await texto(a.page));
  await a.page.fill('#fn2', '2021-02-02');
  return { ok: e1 };
});
await caso('Continuar leva ao PIN; PINs diferentes são recusados; PINs iguais criam o acesso rápido e abrem "Olá, Ana"', async () => {
  await a.page.click('[data-act="antiga2"]');
  await esperaTexto(a.page, /Crie seu PIN/);
  await pin(a.page, '1357'); await esperaTexto(a.page, /Confirme o PIN/);
  await pin(a.page, '9999'); await esperaTexto(a.page, /não conferem/);
  await pin(a.page, '1357'); await pin(a.page, '1357');
  await a.page.waitForURL((u) => u.pathname === '/', { timeout: 6000 });
  const r = (await q(`select cpf, email, telefone, conta_antiga_id from public.app_paciente`))[0];
  const fs = await q(`select nome, cpf from public.app_filho order by nome`);
  return { ok: r.cpf === CPF && r.email === 'ana@exemplo.invalid' && r.telefone === '71991230001' && r.conta_antiga_id === ids.ana && fs.length === 2 && fs[0].nome === 'Leo Souza Teste' && fs[0].cpf === CPF && fs[1].nome === 'Lia Souza Teste' && fs[1].cpf === null, detalhe: JSON.stringify({ ...r, cpf: '***' }) + fs.map((x) => x.nome).join('|') };
});
await caso('a conta antiga sai do aparelho (logout no Auth) e o aparelho guarda só o código do acesso rápido', async () => {
  const st = await a.page.evaluate(() => ({ acesso: localStorage.getItem('csi_acesso_v2'), antiga: localStorage.getItem('csi-paciente-auth') }));
  return { ok: logouts.includes('Bearer ' + tokenDe(ids.ana)) && !!st.acesso && JSON.parse(st.acesso).dev && st.antiga === null && !/1357|ana@exemplo|529/.test(st.acesso), detalhe: st.acesso && st.acesso.slice(0, 30) };
});
await caso('Meus dados mostra nome, nascimento, celular, e-mail e CPF mascarado de forma clara', async () => {
  await a.page.goto(`${ORIGEM}/acesso/?ir=dados`);
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
  await b.page.waitForURL((u) => u.pathname === '/', { timeout: 6000 });
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
await caso('homônimo sem nascimento (Carla): o servidor pergunta "Quem é?"; a escolha padrão é "Sou eu" e nenhum filho é criado', async () => {
  const t = await texto(c.page);
  const sou = await c.page.locator('[data-act="fq"][data-v="0"]').getAttribute('class');
  return { ok: /O nome é igual ao seu\. Quem é\?/.test(t) && /Sou eu/.test(t) && /on/.test(sou) && (await c.page.locator('#fn0').count()) === 0 };
});
await caso('terminando o PIN a página devolve para o chat, e a sessão da conta antiga foi apagada deste aparelho', async () => {
  await c.page.fill('#nasc', '1985-05-05'); await c.page.click('[data-act="antiga2"]');
  await pin(c.page, '1357'); await pin(c.page, '1357');
  await c.page.waitForURL(`${ORIGEM}/`, { timeout: 4000 });
  const st = await c.page.evaluate(() => ({ antiga: localStorage.getItem('csi-paciente-auth'), acesso: !!localStorage.getItem('csi_acesso_v2') }));
  return { ok: st.antiga === null && st.acesso === true && (await n(`select count(*)::int n from public.app_filho f join public.app_paciente p on p.id = f.responsavel_id where p.conta_antiga_id = '${ids.chat}'`)) === 0, detalhe: JSON.stringify(st) };
});
const dn = await novaPagina(); await dn.page.click('[data-act="go"][data-v="antiga"]'); await entrarComEmail(dn.page, 'dani@exemplo.invalid', SENHA);
await esperaTexto(dn.page, /Confira os seus dados/);
await caso('homônimo de criança (Dani, nascimento de menor): já vem como "É outra pessoa" com o nascimento; ao continuar entra como filha confirmada', async () => {
  const antes = await texto(dn.page);
  const v = await dn.page.inputValue('#fn0');
  await dn.page.fill('#nasc', '1980-01-01'); await dn.page.click('[data-act="antiga2"]');
  await pin(dn.page, '1357'); await pin(dn.page, '1357'); await dn.page.waitForURL((u) => u.pathname === '/', { timeout: 6000 });
  const f = await q(`select f.nome, f.nascimento::text n from public.app_filho f join public.app_paciente p on p.id = f.responsavel_id where p.conta_antiga_id = '${ids.dani}'`);
  return { ok: /Quem é\?/.test(antes) && v === '2013-03-03' && f.length === 1 && f[0].nome === 'Dani Teste Costa' && f[0].n === '2013-03-03', detalhe: JSON.stringify(f) };
});

// ================================================================= Conta de e-mail + celular que JÁ tem PIN (cadastro separado, sem ligação com a conta)
// Foi o caso do dono em 15/11/2026: abria pelo chat e caía em "Confira os seus dados" mesmo com o PIN criado.
for (const [k, email, nomeC, tel] of [['eva', 'eva@exemplo.invalid', 'Eva Pin Teste', '71991230011'], ['fabi', 'fabi@exemplo.invalid', 'Fabi Pin Teste', '71991230013']]) {
  ids[k] = (await q(`insert into auth.users (id, email) values (gen_random_uuid(), '${email}') returning id`))[0].id;
  await db.exec(`insert into public.contas_paciente (id, email, nome, telefone) values ('${ids[k]}', '${email}', '${nomeC}', '${tel}')`);
}
await db.exec(`insert into public.app_paciente (telefone, nome, nascimento, pin_hash) values ('71991230011', 'Eva Pin Teste', '1990-01-01', extensions.crypt('2468', extensions.gen_salt('bf', 8)))`);
const antesEva = await n(`select count(*)::int n from public.app_paciente`);
const sessaoEva = JSON.stringify({ access_token: tokenDe(ids.eva), expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ids.eva } });
const ev = await novaPagina('/?voltar=chat&antiga=1', ['csi-paciente-auth', sessaoEva]);
await caso('vindo do chat com a conta logada e o celular dela JÁ com PIN: vai direto para digitar o PIN (não mostra "Confira os seus dados")', async () => {
  await esperaTexto(ev.page, /Você já tem PIN/);
  const t = await texto(ev.page);
  return { ok: !/Confira os seus dados/.test(t) && (await ev.page.locator('.pad button[data-k="1"]').count()) === 1, detalhe: t.slice(0, 120).replace(/\n/g, ' | ') };
});
await caso('o PIN certo abre o acesso rápido E junta a conta de e-mail ao PIN (uma pessoa só); a sessão antiga sai do aparelho; nada é criado a mais', async () => {
  await pin(ev.page, '2468');
  await ev.page.waitForURL((u) => u.pathname === '/', { timeout: 6000 });
  const st = await ev.page.evaluate(() => ({ antiga: localStorage.getItem('csi-paciente-auth') }));
  const lig = await n(`select count(*)::int n from public.app_paciente where telefone = '71991230011' and conta_antiga_id = '${ids.eva}'`);
  return { ok: st.antiga === null && lig === 1 && (await n(`select count(*)::int n from public.app_paciente`)) === antesEva, detalhe: JSON.stringify(st) + ' ligada=' + lig };
});
const fb = await novaPagina(); await fb.page.click('[data-act="go"][data-v="antiga"]'); await entrarComEmail(fb.page, 'fabi@exemplo.invalid', SENHA);
await esperaTexto(fb.page, /Confira os seus dados/);
await caso('conta sem PIN que digita um celular que já tem PIN: ao Continuar vai para o PIN em vez de tentar cadastrar de novo', async () => {
  await fb.page.fill('#tel', '71991230011'); await fb.page.fill('#nome', 'Fabi Pin Teste'); await fb.page.fill('#nasc', '1991-02-02');
  await fb.page.click('[data-act="antiga2"]');
  await esperaTexto(fb.page, /Este celular já tem PIN/);
  return { ok: (await fb.page.locator('.pad button[data-k="1"]').count()) === 1 && (await n(`select count(*)::int n from public.app_paciente`)) === antesEva };
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
