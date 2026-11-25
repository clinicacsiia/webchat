// FLUXOGRAMA: entrada (o retrato da produção + as migrações do acesso rápido (PIN) + supabase/marcacao-etapas-parte1.sql; cadastros e conversas INVENTADOS)
//   -> validação (chat_config e a lista do piloto; marcacao_etapas_pode em cada modo e formato de telefone; marcacao_ciencia_registrar como "anon" com e sem PIN, com token certo e errado)
//   -> lógica (a ciência grava hora do servidor, IP que a plataforma informa e só os campos permitidos do aparelho; limite por hora; a tabela é fechada ao público)
//   -> saída (casos PASS/FAIL)
// Versão 1.0 — 24/11/2026 / Mudança: Implementação inicial (parte 1 da integração do sistema de marcação por etapas).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
for (const f of ['acesso-rapido-paciente', 'acesso-rapido-chat', 'acesso-rapido-pendencias', 'acesso-rapido-pin-obrigatorio', 'acesso-rapido-pin-servidor']) await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/marcacao-etapas-parte1.sql`, 'utf8');
const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);

await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('a migração aplica duas vezes sem erro (idempotente) e o modo nasce "nao" com a lista vazia', async () => {
  await db.exec(sql); await db.exec(sql);
  const m = await um(`select valor from public.config where chave = 'marcacao_etapas_modo'`), t = await um(`select valor from public.config where chave = 'marcacao_etapas_telefones'`);
  return { ok: m.valor === 'nao' && t.valor === '', detalhe: `modo=${m.valor} telefones="${t.valor}"` };
});

// ---- chat_config
await cfg('marcacao_etapas_telefones', '(71) 99999-1111, +55 71 98888-2222');
await caso('chat_config devolve o modo e NUNCA a lista de telefones do piloto', async () => {
  const c = (await q(`select public.chat_config() r`))[0].r;
  return { ok: c.marcacao_etapas_modo === 'nao' && !('marcacao_etapas_telefones' in c) && JSON.stringify(c).indexOf('99999') < 0, detalhe: Object.keys(c).join(',') };
});

// ---- marcacao_etapas_pode
const pode = async (tel) => (await q(`select public.marcacao_etapas_pode($1) r`, [tel]))[0].r;
await caso('modo "nao": ninguém entra, nem quem está na lista do piloto', async () => ({ ok: (await pode('71999991111')) === false && (await pode('71988882222')) === false }));
await cfg('marcacao_etapas_modo', 'piloto');
await caso('modo "piloto": entra só quem está na lista, em qualquer formato (máscara, +55, sem DDI); os outros não', async () => {
  const r = [await pode('71999991111'), await pode('(71) 99999-1111'), await pode('+55 71 99999-1111'), await pode('5571988882222'), await pode('71988882222'),
    await pode('71977773333'), await pode(''), await pode(null), await pode('123'), await pode('abc')];
  return { ok: r.slice(0, 5).every((x) => x === true) && r.slice(5).every((x) => x === false), detalhe: r.join(',') };
});
await caso('modo "piloto" com a lista vazia: ninguém entra', async () => {
  await cfg('marcacao_etapas_telefones', '');
  const r = [await pode('71999991111'), await pode('')];
  await cfg('marcacao_etapas_telefones', '(71) 99999-1111, +55 71 98888-2222');
  return { ok: r.every((x) => x === false) };
});
await caso('valor desconhecido (typo) = desligado; "sim" = todos', async () => {
  await cfg('marcacao_etapas_modo', 'talvez'); const a = await pode('71999991111');
  await cfg('marcacao_etapas_modo', 'SIM'); const b = await pode('71999991111');
  await cfg('marcacao_etapas_modo', 'sim'); const c = await pode('71977773333');
  await cfg('marcacao_etapas_modo', 'nao');
  return { ok: a === false && b === false && c === true, detalhe: `talvez=${a} SIM=${b} sim=${c}` };
});

// ---- ciência: cadastro e conversa inventados (como no teste do PIN)
await cfg('app_acesso_modo', 'sim'); await cfg('app_pin_obrigatorio', 'sim');
await anonimo();
const cad = (await q(`select public.app_cadastrar(p_telefone => '71991230001', p_nome => 'Ana Souza Teste', p_nascimento => '1988-04-12', p_pin => '1357', p_filhos => '[]'::jsonb, p_aparelho => 'teste') r`))[0].r;
await db.exec('reset role');
const TOK = cad && cad.token;
await caso('cadastro de teste criado', async () => ({ ok: !!TOK }));
const r0 = (await q(`select public.chat_iniciar(p_nome => 'Ana Souza Teste', p_telefone => '71991230001', p_email => 'ana@exemplo.invalid', p_aceite => true) r`))[0].r;
const conv = { c: r0.conversa_id, t: r0.token };
const r1 = (await q(`select public.chat_iniciar(p_nome => 'Bia Costa Teste', p_telefone => '71991230002', p_email => 'bia@exemplo.invalid', p_aceite => true) r`))[0].r;
const outra = { c: r1.conversa_id, t: r1.token };
await cfg('app_pin_servidor', 'sim');

async function chamar(sqlChamada, params = [], { cab = {}, caminho = '/rpc/marcacao_ciencia_registrar', papel = 'anon' } = {}) {
  await db.query(`select set_config('request.headers', $1, false), set_config('request.path', $2, false), set_config('request.jwt.claims', $3, false)`, [JSON.stringify(cab), caminho, JSON.stringify({ role: papel })]);
  await db.exec(`reset role; set role ${papel}`);
  try { return { ok: true, r: (await q(sqlChamada, params))[0]?.r }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec('reset role'); await db.query(`select set_config('request.headers', '', false), set_config('request.path', '', false), set_config('request.jwt.claims', '', false)`); }
}
const CIENCIA = (c, ap = '{"aparelho":"Android 14 · Pixel","idioma":"pt-BR","tela":"360x800","fuso":"America/Bahia"}', motivo = 'plano') =>
  [`select public.marcacao_ciencia_registrar($1::uuid, $2, $3::jsonb, $4) r`, [c.c, c.t, ap, motivo]];

await caso('com o PIN obrigatório e SEM aparelho: a ciência é recusada ("pin_obrigatorio") e nada é gravado', async () => {
  const x = await chamar(...CIENCIA(conv));
  const n = await um(`select count(*)::int n from public.marcacao_ciencia`);
  return { ok: x.ok === false && /pin_obrigatorio/.test(x.msg) && n.n === 0, detalhe: (x.msg || '').slice(0, 60) };
});
await caso('com o aparelho do cadastro (PIN válido) e o token certo: grava; o IP é o que a plataforma informa (cf-connecting-ip)', async () => {
  const x = await chamar(...CIENCIA(conv), { cab: { 'x-acesso': TOK, 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } });
  const l = await um(`select ip, aparelho, motivo, versao_texto, em from public.marcacao_ciencia where conversa_id = $1`, [conv.c]);
  return { ok: x.ok && x.r.ok === true && l.ip === '203.0.113.9' && l.aparelho.aparelho === 'Android 14 · Pixel' && l.motivo === 'plano' && l.versao_texto === 'pre-marcacao-v1', detalhe: JSON.stringify(l).slice(0, 140) };
});
await caso('sem cf-connecting-ip, vale o ÚLTIMO item do x-forwarded-for (o começo pode ser escrito pelo cliente)', async () => {
  await chamar(...CIENCIA(conv), { cab: { 'x-acesso': TOK, 'x-forwarded-for': '9.9.9.9, 198.51.100.7' } });
  const l = await um(`select ip from public.marcacao_ciencia where conversa_id = $1 order by id desc limit 1`, [conv.c]);
  return { ok: l.ip === '198.51.100.7', detalhe: l.ip };
});
await caso('só os campos permitidos do aparelho entram, cada um com no máximo 160 caracteres', async () => {
  await chamar(...CIENCIA(conv, JSON.stringify({ aparelho: 'x'.repeat(500), cpf: '11144477735', senha: 'abc', idioma: 'pt-BR' })), { cab: { 'x-acesso': TOK } });
  const l = await um(`select aparelho from public.marcacao_ciencia where conversa_id = $1 order by id desc limit 1`, [conv.c]);
  return { ok: Object.keys(l.aparelho).sort().join(',') === 'aparelho,idioma' && l.aparelho.aparelho.length === 160, detalhe: Object.keys(l.aparelho).join(',') };
});
await caso('a hora é a do servidor (o aparelho não consegue mandar a sua)', async () => {
  await chamar(...CIENCIA(conv, JSON.stringify({ aparelho: 'x', em: '2000-01-01T00:00:00Z' })), { cab: { 'x-acesso': TOK } });
  const l = await um(`select (em > now() - interval '1 minute') ok from public.marcacao_ciencia where conversa_id = $1 order by id desc limit 1`, [conv.c]);
  return { ok: l.ok === true };
});
await caso('token da conversa errado (ou de outra conversa): recusado e nada gravado para ela', async () => {
  const antes = await um(`select count(*)::int n from public.marcacao_ciencia where conversa_id = $1`, [outra.c]);
  const x = await chamar(...CIENCIA({ c: outra.c, t: conv.t }), { cab: { 'x-acesso': TOK } });
  const y = await chamar(...CIENCIA({ c: outra.c, t: 'token-errado' }), { cab: { 'x-acesso': TOK } });
  const dep = await um(`select count(*)::int n from public.marcacao_ciencia where conversa_id = $1`, [outra.c]);
  return { ok: x.ok === false && y.ok === false && dep.n === antes.n, detalhe: `${(x.msg || '').slice(0, 40)} | ${(y.msg || '').slice(0, 40)}` };
});
await caso('a ciência vira uma nota na conversa para a equipe ver (sem IP nem dado pessoal na nota)', async () => {
  const f = await um(`select dados from public.conversa_fluxo where conversa_id = $1`, [conv.c]);
  const notas = (f.dados.notas || []).filter((n) => /CIÊNCIA DA PRÉ-MARCAÇÃO/.test(n));
  return { ok: notas.length >= 1 && !/\d+\.\d+\.\d+\.\d+/.test(notas[0]), detalhe: (notas[0] || '').slice(0, 120) };
});
await caso('limite: a 6ª ciência na mesma hora é recusada', async () => {
  let ult = null;
  for (let i = 0; i < 4; i++) ult = await chamar(...CIENCIA(conv), { cab: { 'x-acesso': TOK } });   // já havia 4 (ip, ultimo item, campos, hora): 5ª passa, 6ª não
  const sexta = await chamar(...CIENCIA(conv), { cab: { 'x-acesso': TOK } });
  const n = await um(`select count(*)::int n from public.marcacao_ciencia where conversa_id = $1`, [conv.c]);
  return { ok: sexta.ok === false && /Muitas confirma/.test(sexta.msg) && n.n === 5, detalhe: `n=${n.n} ${(sexta.msg || '').slice(0, 50)}` };
});
await caso('o público (anon) NÃO lê nem escreve a tabela da ciência direto', async () => {
  const a = await chamar(`select count(*) r from public.marcacao_ciencia`, [], { cab: { 'x-acesso': TOK } });
  const b = await chamar(`insert into public.marcacao_ciencia (conversa_id, versao_texto) values ($1::uuid, 'x') returning 1 r`, [conv.c], { cab: { 'x-acesso': TOK } });
  return { ok: a.ok === false && b.ok === false, detalhe: `${(a.msg || '').slice(0, 40)} | ${(b.msg || '').slice(0, 40)}` };
});
await caso('as duas funções novas são executáveis pelo paciente (anon) e a tabela tem a regra de acesso por linha (RLS) ligada', async () => {
  const f = await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('marcacao_etapas_pode', 'marcacao_ciencia_registrar')`);
  const t = await um(`select relrowsecurity r from pg_class where oid = 'public.marcacao_ciencia'::regclass`);
  return { ok: f.length === 2 && f.every((x) => x.a === true) && t.r === true };
});
await caso('apagar a conversa apaga a ciência dela (LGPD: eliminação a pedido)', async () => {
  await db.query(`delete from public.conversas where id = $1`, [outra.c]);
  await db.query(`insert into public.marcacao_ciencia (conversa_id, versao_texto) values ($1, 'x')`, [conv.c]);
  await db.query(`delete from public.conversas where id = $1`, [conv.c]);
  const n = await um(`select count(*)::int n from public.marcacao_ciencia`);
  return { ok: n.n === 0, detalhe: `restaram ${n.n}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
