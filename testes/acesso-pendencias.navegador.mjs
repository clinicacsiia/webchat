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
    valores.push(info.tipos[i] === 'jsonb' ? (v === null ? null : JSON.stringify(v)) : v === null ? null : String(v));
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
  await ctx.route(`${ORIGEM}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML }));
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
await esperaTexto(a.page, /Olá, Ana/);

await caso('depois do cadastro o início mostra "Falta pouco" com o CPF dela, o e-mail (opcional) e o CPF do Leo', async () => {
  await esperaTexto(a.page, /Falta pouco/);
  const t = await texto(a.page);
  return { ok: /Qual é o seu CPF/.test(t) && /e-mail/.test(t) && /CPF de Leo/.test(t) && (await a.page.locator('#pend input').count()) === 3, detalhe: t.slice(0, 160).replace(/\n/g, ' | ') };
});
await caso('nada da base da clínica aparece na tela (nem CPF, nem "cadastro encontrado")', async () => {
  const t = await a.page.content();
  return { ok: !t.includes('529.982.247-25') && !t.includes('52998224725') && !/encontramos|já temos seu cadastro/i.test(t) };
});
await caso('salvar sem preencher nada avisa; CPF curto e e-mail torto são recusados na tela, sem chamar o servidor', async () => {
  const antes = chamadasRede.length;
  await a.page.click('[data-act="pendsalvar"]'); const e1 = /pelo menos um campo/.test(await texto(a.page));
  await a.page.fill('#pd0', '123'); await a.page.click('[data-act="pendsalvar"]'); const e2 = /11 números/.test(await texto(a.page));
  await a.page.fill('#pd0', ''); await a.page.fill('#pd1', 'torto'); await a.page.click('[data-act="pendsalvar"]'); const e3 = /não parece certo/.test(await texto(a.page));
  return { ok: e1 && e2 && e3 && chamadasRede.slice(antes).every((c) => c.nome !== 'app_pendencia_responder'), detalhe: [e1, e2, e3].join() };
});
await caso('CPF inválido (dígito errado) é recusado pelo servidor com a mensagem dele', async () => {
  await a.page.fill('#pd0', '123.456.789-00'); await a.page.fill('#pd1', ''); await a.page.click('[data-act="pendsalvar"]');
  await esperaTexto(a.page, /não conferem/);
  return { ok: (await n(`select count(*)::int n from public.app_paciente where cpf is not null`)) === 0 };
});
await caso('o CPF digitado ganha pontos e traço; salvando CPF dela, do filho e e-mail o cartão some e fica tudo guardado', async () => {
  await a.page.fill('#pd0', '52998224725'); const mascara = await a.page.inputValue('#pd0');
  await a.page.fill('#pd1', 'ana@exemplo.invalid'); await a.page.fill('#pd2', '12345678909');
  await a.page.click('[data-act="pendsalvar"]');
  await a.page.waitForFunction(() => !document.getElementById('pend'), null, { timeout: 4000 });
  const r = (await q(`select (select cpf from public.app_paciente) cpf, (select email from public.app_paciente) email, (select cpf from public.app_filho) f`))[0];
  return { ok: mascara === '529.982.247-25' && r.cpf === '52998224725' && r.email === 'ana@exemplo.invalid' && r.f === '12345678909', detalhe: mascara };
});
await caso('o CPF dela bate com o cadastro da clínica de MESMO celular: vira sugestão e não aparece nenhum aviso para ela', async () => {
  const r = (await q(`select paciente_sugerido_id is not null s, revisar_motivo m from public.app_paciente`))[0];
  const t = await texto(a.page);
  return { ok: r.s === true && r.m === null && !/cl[ií]nica (vai|confere)|revis|divergên/i.test(t) };
});
await caso('Meus dados também não mostra mais o cartão; "Agora não" esconde sem gravar', async () => {
  await a.page.click('[data-act="go"][data-v="dados"]'); await espera(300);
  return { ok: (await a.page.locator('#pend').count()) === 0 };
});

// outra pessoa, outro celular, CPF que não bate: a tela é a mesma e a equipe recebe a marca
let b = await novaPagina();
await b.page.fill('#tel', '71991230009'); await b.page.click('[data-act="c1"]');
await b.page.fill('#nome', 'Carla Dias Teste'); await b.page.fill('#nasc', '1991-01-01'); await b.page.click('[data-act="c2"]');
await b.page.click('[data-act="tf"][data-v="0"]'); await b.page.click('[data-act="c3"]'); await b.page.click('[data-act="c4skip"]');
await pin(b.page, '2468'); await pin(b.page, '2468');
await esperaTexto(b.page, /Falta pouco/);
await caso('CPF de outra pessoa da clínica digitado em outro celular: tela igual ("Salvo"), marca só para a equipe', async () => {
  await b.page.fill('#pd0', '529.982.247-25'); await b.page.click('[data-act="pendsalvar"]');
  await b.page.waitForFunction(() => /Salvo/.test(document.body.innerText), null, { timeout: 4000 });
  const t = await b.page.content();
  const r = (await q(`select revisar_motivo m from public.app_paciente where telefone = '71991230009'`))[0];
  return { ok: r.m === 'cpf_com_outro_celular' && !/cpf_com_outro_celular|cl[ií]nica vai/i.test(t), detalhe: r.m };
});
await caso('"Agora não" esconde o cartão nesta visita, sem chamar o servidor', async () => {
  let c = await novaPagina();
  await c.page.fill('#tel', '71991230010'); await c.page.click('[data-act="c1"]');
  await c.page.fill('#nome', 'Duda Rocha Teste'); await c.page.fill('#nasc', '1990-01-01'); await c.page.click('[data-act="c2"]');
  await c.page.click('[data-act="tf"][data-v="0"]'); await c.page.click('[data-act="c3"]'); await c.page.click('[data-act="c4skip"]');
  await pin(c.page, '1357'); await pin(c.page, '1357'); await esperaTexto(c.page, /Falta pouco/);
  const antes = chamadasRede.length; await c.page.click('[data-act="pendmais"]');
  return { ok: (await c.page.locator('#pend').count()) === 0 && chamadasRede.length === antes };
});
await caso('nenhum erro de script nem violação da política de segurança do navegador durante todo o roteiro', async () => ({ ok: erros.length === 0, detalhe: erros.slice(0, 3).join(' ; ') }));

await browser.close();
const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
