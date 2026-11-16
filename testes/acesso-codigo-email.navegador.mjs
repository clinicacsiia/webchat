// FLUXOGRAMA: entrada (acesso/index.html num Chromium de celular falando com o banco de teste: retrato da produção + acesso rápido + supabase/acesso-codigo-email.sql, chave ligada) -> validação (cadastro novo e "esqueci o PIN" só avançam com o código; código errado, vencido e sem e-mail) -> lógica (a página pede o código, mostra o e-mail mascarado e o aviso de spam/lixeira; a atendente passa o código lido do banco) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (confirmação por e-mail no primeiro acesso e no "esqueci o PIN").
// Prova a página e o banco JUNTOS. Não fala com o Supabase de verdade e não envia e-mail. Dados inventados.
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
await db.exec(readFileSync(`${REPO}/supabase/acesso-codigo-email.sql`, 'utf8'));
await db.exec(`insert into public.config (chave, valor) values ('app_acesso_modo', 'sim') on conflict (chave) do update set valor = 'sim'`);
await db.exec(`update public.config set valor = 'sim' where chave = 'app_codigo_email'`);

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
async function novaPagina(caminho = '/acesso/') {
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
  await page.goto(`${ORIGEM}${caminho}`);
  return { ctx, page };
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const texto = (page) => page.locator('#app').innerText();
async function pin(page, digitos) {
  for (const d of digitos) await page.locator(`.pad button[data-k="${d}"]`).click();
  await espera(450);
}
// Depois do PIN a página não tem mais tela inicial: vai direto ao chat (aqui, uma página de mentira em "/").
const noChat = (page, ms = 6000) => page.waitForURL((u) => u.pathname === '/', { timeout: ms });
// "Meus dados" como o botão do chat faz: com o PIN ainda válido abre direto, sem teclado.
async function dados(page) { await page.goto(`${ORIGEM}/acesso/?ir=dados`); await esperaTexto(page, /Nascimento/); }
const esperaTexto = (page, re, ms = 4000) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById('app').innerText + document.body.innerText), re.source, { timeout: ms });
const n = async (sqlTexto) => (await q(sqlTexto))[0].n;
const AMANHA = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
const NASC_ANA = '1988-04-12', NASC_LEO = '2019-08-30', NASC_DAVI = '2022-01-10';


const codigoDe = async (tel, fin) => (await q(`select codigo from public.app_codigo_email where telefone = '${tel}' and finalidade = '${fin}' and usado_em is null and descartado_em is null order by criado_em desc limit 1`))[0]?.codigo;
const emBranco = async (page, tel) => { await page.fill('#tel', tel); await page.click('[data-act="c1"]'); };

// ================================================================= cadastro novo
const m = await novaPagina();
await caso('cadastro novo: depois do número de confiança pede o e-mail (antes do PIN)', async () => {
  await emBranco(m.page, '71991230001');
  await m.page.fill('#nome', 'Maria Teste Silva'); await m.page.fill('#nasc', '1985-03-10'); await m.page.click('[data-act="c2"]');
  await m.page.click('[data-act="tf"][data-v="0"]'); await m.page.click('[data-act="c3"]');
  await m.page.click('[data-act="c4skip"]');
  await esperaTexto(m.page, /Confirme seu e-mail/);
  return { ok: /Enviar código/.test(await texto(m.page)) && (await q(`select count(*)::int n from public.app_codigo_email`))[0].n === 0 };
});
await caso('e-mail inválido é recusado na própria página, sem chamar o servidor', async () => {
  const antes = chamadasRede.length;
  await m.page.fill('#cemail', 'sem-arroba'); await m.page.click('[data-act="c4e"]');
  return { ok: /não parece certo/.test(await texto(m.page)) && chamadasRede.length === antes };
});
await caso('e-mail válido: mostra o e-mail mascarado, avisa para olhar spam e lixeira e a atendente pode passar o código', async () => {
  await m.page.fill('#cemail', 'Maria.Teste@Exemplo.invalid'); await m.page.click('[data-act="c4e"]');
  await esperaTexto(m.page, /Digite o código/);
  const t = await texto(m.page);
  return { ok: /m\*\*\*@exemplo\.invalid/.test(t) && /spam/.test(t) && /lixeira/.test(t) && /atendente/.test(t) && !/Maria\.Teste/.test(t) };
});
await caso('o código sai de verdade no banco e nenhum cadastro nasce antes de digitá-lo', async () => {
  const c = await codigoDe('71991230001', 'cadastro');
  return { ok: /^[0-9]{6}$/.test(c) && (await q(`select count(*)::int n from public.app_paciente`))[0].n === 0 };
});
await caso('código errado: avisa quantas tentativas restam e continua na mesma tela', async () => {
  const certo = await codigoDe('71991230001', 'cadastro'); const errado = certo === '000000' ? '111111' : '000000';
  await m.page.fill('#cod', errado); await m.page.click('[data-act="c4c"]');
  await esperaTexto(m.page, /Restam 4 tentativas/);
  return { ok: /Digite o código/.test(await texto(m.page)) };
});
await caso('código com menos de 6 números é recusado sem ir ao servidor', async () => {
  const antes = chamadasRede.length;
  await m.page.fill('#cod', '123'); await m.page.click('[data-act="c4c"]');
  return { ok: /6 números/.test(await texto(m.page)) && chamadasRede.length === antes };
});
await caso('código certo (o que a atendente passou): vai ao PIN; criando o PIN o cadastro nasce com o e-mail confirmado e chega ao chat', async () => {
  const certo = await codigoDe('71991230001', 'cadastro');
  await m.page.fill('#cod', certo); await m.page.click('[data-act="c4c"]');
  await esperaTexto(m.page, /Crie seu PIN/);
  await pin(m.page, '2580'); await pin(m.page, '2580');
  await noChat(m.page);
  const p = (await q(`select email from public.app_paciente where telefone = '71991230001'`))[0];
  const usado = (await q(`select count(*)::int n from public.app_codigo_email where telefone = '71991230001' and usado_em is not null`))[0].n;
  return { ok: p?.email === 'maria.teste@exemplo.invalid' && usado === 1, detalhe: JSON.stringify(p) };
});

// voltar do PIN para trás não obriga a confirmar o e-mail de novo (vale por 25 minutos)
const v = await novaPagina();
await caso('quem já confirmou o e-mail e volta atrás no PIN não recebe outro código', async () => {
  await emBranco(v.page, '71991230003');
  await v.page.fill('#nome', 'Vera Teste Lima'); await v.page.fill('#nasc', '1990-05-05'); await v.page.click('[data-act="c2"]');
  await v.page.click('[data-act="tf"][data-v="0"]'); await v.page.click('[data-act="c3"]'); await v.page.click('[data-act="c4skip"]');
  await v.page.fill('#cemail', 'vera@exemplo.invalid'); await v.page.click('[data-act="c4e"]'); await esperaTexto(v.page, /Digite o código/);
  await v.page.fill('#cod', await codigoDe('71991230003', 'cadastro')); await v.page.click('[data-act="c4c"]'); await esperaTexto(v.page, /Crie seu PIN/);
  await v.page.click('.back'); await esperaTexto(v.page, /Número de confiança/);
  await v.page.click('[data-act="c4skip"]'); await esperaTexto(v.page, /Crie seu PIN/);
  return { ok: (await q(`select count(*)::int n from public.app_codigo_email where telefone = '71991230003'`))[0].n === 1 };
});
await caso('código que venceu antes de criar o PIN: o servidor recusa e a página volta ao e-mail com a explicação', async () => {
  await q(`update public.app_codigo_email set validado_em = now() - interval '40 minutes' where telefone = '71991230003'`);
  await pin(v.page, '2580'); await pin(v.page, '2580');
  await esperaTexto(v.page, /Confirme seu e-mail/);
  return { ok: /Confirme o seu e-mail com o código/.test(await texto(v.page)) && (await q(`select count(*)::int n from public.app_paciente where telefone = '71991230003'`))[0].n === 0 };
});
await caso('descartar o código no painel: a página avisa que venceu e pede para recomeçar', async () => {
  await v.page.fill('#cemail', 'vera@exemplo.invalid'); await v.page.click('[data-act="c4e"]'); await esperaTexto(v.page, /Digite o código/);
  const c = await codigoDe('71991230003', 'cadastro');
  await q(`update public.app_codigo_email set descartado_em = now() where telefone = '71991230003' and codigo = '${c}'`);
  await v.page.fill('#cod', c); await v.page.click('[data-act="c4c"]');
  await esperaTexto(v.page, /venceu ou foi cancelado/);
  return { ok: /Confirme seu e-mail/.test(await texto(v.page)) };
});

// ================================================================= esqueci o PIN
// cadastro antigo (feito antes de a chave ser ligada), com e-mail; e outro sem e-mail
await q(`update public.config set valor = 'nao' where chave = 'app_codigo_email'`);
const mk = async (tel, nome, email) => { await q(`select public.app_cadastrar('${tel}', '${nome}', '1980-01-02', '1357', '[]'::jsonb, null, 'x')`); if (email) await q(`update public.app_paciente set email = '${email}' where telefone = '${tel}'`); };
await mk('71991230010', 'Paula Teste Souza', 'paula@exemplo.invalid');
await mk('71991230011', 'Pedro Teste Souza', null);
await q(`update public.config set valor = 'sim' where chave = 'app_codigo_email'`);
const e = await novaPagina();
await caso('esqueci o PIN: com nome e nascimento certos o código vai ao e-mail do cadastro (mascarado) e a página pede para digitá-lo', async () => {
  await e.page.click('[data-act="go"][data-v="entrar"]'); await e.page.fill('#tel', '71991230010'); await e.page.click('[data-act="entrar"]'); await e.page.click('[data-act="esqueci"]');
  await esperaTexto(e.page, /Esqueci o PIN/);
  await e.page.fill('#tel', '71991230010'); await e.page.fill('#nome', 'Paula Teste Souza'); await e.page.fill('#nasc', '1980-01-02'); await e.page.click('[data-act="esqueci2"]');
  await esperaTexto(e.page, /Digite o código/);
  const t = await texto(e.page);
  return { ok: /p\*\*\*@exemplo\.invalid/.test(t) && /spam/.test(t) && /lixeira/.test(t), detalhe: t.slice(0, 80) };
});
await caso('esqueci o PIN: com o código certo cria o novo PIN e entra; o PIN antigo deixa de valer', async () => {
  await e.page.fill('#cod', await codigoDe('71991230010', 'esqueci_pin')); await e.page.click('[data-act="esqc"]');
  await esperaTexto(e.page, /PIN/);
  await pin(e.page, '9731'); await pin(e.page, '9731');
  await noChat(e.page);
  const antigo = (await q(`select public.app_login('71991230010', '1357', 'novo') r`))[0].r, novo = (await q(`select public.app_login('71991230010', '9731', 'novo') r`))[0].r;
  return { ok: antigo.ok === false && novo.ok === true };
});
const e2 = await novaPagina();
await caso('esqueci o PIN sem e-mail no cadastro: a página diz que nenhum e-mail foi enviado e que a atendente passa o código (que aparece no painel)', async () => {
  await e2.page.click('[data-act="go"][data-v="entrar"]'); await e2.page.fill('#tel', '71991230011'); await e2.page.click('[data-act="entrar"]'); await e2.page.click('[data-act="esqueci"]');
  await esperaTexto(e2.page, /Esqueci o PIN/);
  await e2.page.fill('#tel', '71991230011'); await e2.page.fill('#nome', 'Pedro Teste Souza'); await e2.page.fill('#nasc', '1980-01-02'); await e2.page.click('[data-act="esqueci2"]');
  await esperaTexto(e2.page, /Digite o código/);
  const t = await texto(e2.page);
  const linha = (await q(`select envio, email from public.app_codigo_email where telefone = '71991230011'`))[0];
  return { ok: /nenhum e-mail foi enviado/.test(t) && /Pedir outro código/.test(t) && linha.envio === 'sem_email' && linha.email === null, detalhe: JSON.stringify(linha) };
});
await caso('esqueci o PIN com nome errado: "dados não conferem" e nenhum código é criado', async () => {
  await e2.page.click('[data-act="go"][data-v="esqueci"]');
  await e2.page.fill('#nome', 'Outra Pessoa Qualquer'); await e2.page.click('[data-act="esqueci2"]');
  await esperaTexto(e2.page, /não conferem/);
  return { ok: (await q(`select count(*)::int n from public.app_codigo_email where telefone = '71991230011' and descartado_em is null`))[0].n === 1 };
});
await caso('chave desligada: o cadastro e o esqueci voltam ao caminho antigo (direto ao PIN)', async () => {
  await q(`update public.config set valor = 'nao' where chave = 'app_codigo_email'`);
  const d = await novaPagina();
  await emBranco(d.page, '71991230020');
  await d.page.fill('#nome', 'Dora Teste Alves'); await d.page.fill('#nasc', '1991-01-01'); await d.page.click('[data-act="c2"]');
  await d.page.click('[data-act="tf"][data-v="0"]'); await d.page.click('[data-act="c3"]'); await d.page.click('[data-act="c4skip"]');
  await esperaTexto(d.page, /Crie seu PIN/);
  return { ok: !/Confirme seu e-mail/.test(await texto(d.page)) };
});
await caso('nenhum erro de JavaScript em nenhuma tela', async () => ({ ok: erros.length === 0, detalhe: erros.slice(0, 3).join(' | ') }));

await browser.close();
const falhou = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhou} de ${resultados.length} casos passaram.`);
process.exit(falhou ? 1 : 0);
