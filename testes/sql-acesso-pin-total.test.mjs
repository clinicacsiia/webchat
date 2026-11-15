// FLUXOGRAMA: entrada (o retrato da produção + migrações do acesso rápido + acesso-rapido-pin-servidor.sql + acesso-rapido-pin-total.sql; cadastro e agentes INVENTADOS) -> validação (cada função do paciente chamada como "anon" ou "authenticated" sem aparelho, com aparelho, com PIN vencido e como equipe) -> lógica (a trava recusa com "pin_obrigatorio" só com as três chaves ligadas; equipe, service_role, funções app_* e rotinas internas passam; leituras não renovam o prazo) -> saída (casos PASS/FAIL)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (auditoria: o PIN vale para o sistema todo, inclusive contas antigas e check-in).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
for (const f of ['acesso-rapido-paciente', 'acesso-rapido-chat', 'acesso-rapido-pendencias', 'acesso-rapido-pin-obrigatorio', 'acesso-rapido-pin-servidor']) await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/acesso-rapido-pin-total.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-rapido-pin-total.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

// As funções do paciente que a migração protege (a mesma lista do arquivo SQL).
const PROTEGIDAS = [...sql.match(/p\.proname in \(([^)]*)\)/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const SQL_PURO = ['conta_paciente_conversas', 'conta_paciente_resumo', 'conta_paciente_vinculo_estado', 'conta_precisa_trocar_senha'];
const sqlFila = readFileSync(`${REPO}/supabase/acesso-rapido-pin-fila.sql`, 'utf8');   // fase 2: só depois de a minha-vez nova estar publicada
const FILA = [...sqlFila.match(/p\.proname in \(([^)]*)\)/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
let TODAS = [...PROTEGIDAS, ...SQL_PURO];
const NAO_PROTEGIDAS = ['chat_incidente', 'chat_config', 'chat_saude', 'app_porta', 'login_paciente_ativo', 'fila_minha_vez_ticket', 'conta_senha_trocada'];

const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
await cfg('app_acesso_modo', 'sim'); await cfg('app_pin_obrigatorio', 'sim'); await cfg('app_pin_servidor', 'sim');

await anonimo();
const cad = (await q(`select public.app_cadastrar(p_telefone => '71991230001', p_nome => 'Ana Souza Teste', p_nascimento => '1988-04-12', p_pin => '1357', p_filhos => '[]'::jsonb, p_aparelho => 'teste') r`))[0].r;
await db.exec('reset role');
const TOK = cad && cad.token;
const PACIENTE_JWT = '00000000-0000-4000-8000-0000000000c1', ADM = '00000000-0000-4000-8000-0000000000b1';
await db.exec(`insert into auth.users (id, email) values ('${ADM}', 'adm3@exemplo.invalid'), ('${PACIENTE_JWT}', 'pac3@exemplo.invalid') on conflict do nothing;
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Adm Teste', 'adm3@exemplo.invalid', 'admin', true) on conflict (id) do update set papel = excluded.papel, ativo = true`);
await caso('cadastro de teste criado', async () => ({ ok: !!TOK }));

// Argumentos NULOS com os tipos certos: a trava roda ANTES de qualquer validação, então basta para ver se recusa.
const tipos = async (nome) => (await q(`select coalesce(string_agg('NULL::' || format_type(t, null), ', ' order by o), '') as a, bool_or(has_function_privilege('anon', p.oid, 'execute')) as anon
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(p.proargtypes::oid[]) with ordinality as x(t, o) where n.nspname = 'public' and p.proname = $1 group by p.oid`, [nome]))[0]
  || (await q(`select '' as a, has_function_privilege('anon', p.oid, 'execute') as anon from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [nome]))[0];
async function chamar(nome, { cab = {}, uid = null, papel = null, caminho = null, semHttp = false } = {}) {
  const t = await tipos(nome);
  const role = papel || (t.anon ? 'anon' : 'authenticated');
  const jwt = role === 'authenticated' ? { sub: uid || PACIENTE_JWT, role } : { role };
  await db.exec('reset role');
  if (!semHttp) await db.query(`select set_config('request.headers', $1, false), set_config('request.path', $2, false), set_config('request.jwt.claims', $3, false)`, [JSON.stringify(cab), caminho || `/rpc/${nome}`, JSON.stringify(jwt)]);
  else await db.query(`select set_config('request.headers', '', false), set_config('request.path', '', false), set_config('request.jwt.claims', $1, false)`, [JSON.stringify(jwt)]);
  await db.exec(`set role ${role}`);
  try { return { ok: true, r: (await q(`select public.${nome}(${t.a}) r`))[0]?.r }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec('reset role'); await db.query(`select set_config('request.headers', '', false), set_config('request.path', '', false), set_config('request.jwt.claims', '', false)`); }
}
const recusou = (x) => x.ok === false && /pin_obrigatorio/.test(x.msg);

await caso('FASE 1 (antes de acesso-rapido-pin-fila.sql): o check-in e a fila NÃO são recusados, para a minha-vez antiga (que não manda o aparelho) continuar funcionando', async () => {
  const x = []; for (const n of FILA) x.push(await chamar(n));
  return { ok: FILA.length === 5 && x.every((r) => !recusou(r)), detalhe: x.map((r, i) => `${FILA[i]}:${recusou(r) ? 'RECUSOU' : 'livre'}`).join(' ') };
});
await caso('FASE 2: acesso-rapido-pin-fila.sql aplica duas vezes sem erro; as 5 funções da fila passam a exigir o PIN', async () => {
  await db.exec(sqlFila); await db.exec(sqlFila); TODAS = [...TODAS, ...FILA];
  const x = []; for (const n of FILA) x.push(await chamar(n));
  return { ok: x.every(recusou), detalhe: x.map((r, i) => `${FILA[i]}:${recusou(r) ? 'recusou' : 'PASSOU'}`).join(' ') };
});
await caso(`a lista tem as ${PROTEGIDAS.length} funções do bloco, as ${SQL_PURO.length} reescritas e as ${FILA.length} da fila`, async () => ({ ok: PROTEGIDAS.length >= 35 && TODAS.length === PROTEGIDAS.length + SQL_PURO.length + FILA.length, detalhe: `${PROTEGIDAS.length}+${SQL_PURO.length}+${FILA.length}` }));
await caso('a chamada da trava entrou UMA vez em cada função protegida (aplicar duas vezes não duplica)', async () => {
  const r = await q(`select p.proname, (length(pg_get_functiondef(p.oid)) - length(replace(pg_get_functiondef(p.oid), 'app_pin_exigir', ''))) / length('app_pin_exigir') as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1::text[]) order by 1`, [TODAS]);
  const ruins = r.filter((x) => Number(x.n) !== 1);
  return { ok: r.length === TODAS.length && ruins.length === 0, detalhe: `${r.length} funções; fora do padrão: ${ruins.map((x) => x.proname + '=' + x.n).join(' ') || 'nenhuma'}` };
});

// ---- trava LIGADA, sem aparelho
await caso('SEM aparelho: TODAS as funções do paciente são recusadas com "pin_obrigatorio"', async () => {
  const ruins = [];
  for (const n of TODAS) { const x = await chamar(n); if (!recusou(x)) ruins.push(`${n}:${x.ok ? 'PASSOU' : x.msg.slice(0, 40)}`); }
  return { ok: ruins.length === 0, detalhe: ruins.length ? ruins.join(' | ') : `${TODAS.length} recusadas` };
});
await caso('COM o aparelho do cadastro e PIN dos últimos 30 minutos: nenhuma é recusada pelo PIN', async () => {
  const ruins = [];
  for (const n of TODAS) { const x = await chamar(n, { cab: { 'x-acesso': TOK } }); if (recusou(x)) ruins.push(n); }
  return { ok: ruins.length === 0, detalhe: ruins.join(' ') || `${TODAS.length} passaram pela trava` };
});
await caso('PIN vencido, aparelho desconhecido ou código vazio: recusa em todas', async () => {
  await db.query(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const a = []; for (const n of TODAS) a.push(await chamar(n, { cab: { 'x-acesso': TOK } }));   // em sequência: cada chamada tem o seu próprio estado de requisição
  await db.query(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  const b = await chamar('chat_listar', { cab: { 'x-acesso': 'nao-existe' } }), c = await chamar('conta_paciente_conversas', { cab: { 'x-acesso': '  ' } });
  return { ok: a.every(recusou) && recusou(b) && recusou(c), detalhe: `vencido=${a.filter(recusou).length}/${a.length}` };
});
await caso('as leituras NÃO renovam o prazo do PIN (só a atividade do chat renova), mas as 5 ações principais renovam', async () => {
  await db.query(`update public.conversas set criado_em = criado_em - interval '2 hours'`);
  const conv = (await q(`select public.chat_iniciar(p_nome => 'Ana Souza Teste', p_telefone => '71991230001', p_email => 'ana@exemplo.invalid', p_aceite => true) r`))[0].r;   // por dentro (sem requisição HTTP)
  const minutos = async () => Number((await um(`select extract(epoch from (desbloqueada_ate - now())) / 60 as m from public.app_aparelho`)).m);
  const comoPaciente = async (nome, args) => {   // chamada "vinda da internet" com o aparelho e argumentos de verdade
    await db.exec('reset role');
    await db.query(`select set_config('request.headers', $1, false), set_config('request.path', $2, false), set_config('request.jwt.claims', '{"role":"anon"}', false)`, [JSON.stringify({ 'x-acesso': TOK }), `/rpc/${nome}`]);
    await db.exec('set role anon');
    try { return (await q(`select public.${nome}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args))[0].r; } finally { await db.exec('reset role'); }
  };
  await db.query(`update public.app_aparelho set desbloqueada_ate = now() + interval '2 minutes'`);
  await comoPaciente('chat_voltar', [conv.conversa_id, conv.token]).catch(() => null);   // leitura/ação leve: só confere
  const depoisLeitura = await minutos();
  await comoPaciente('chat_enviar', [conv.conversa_id, conv.token, 'oi']);
  const depoisAcao = await minutos();
  return { ok: depoisLeitura < 3 && depoisAcao > 25, detalhe: `leitura=${depoisLeitura.toFixed(1)} min, ação=${depoisAcao.toFixed(1)} min` };
});
await caso('a EQUIPE (admin) passa sem aparelho, mesmo nas funções de paciente que ela também usa', async () => {
  const x = await chamar('paciente_jornada', { uid: ADM }), y = await chamar('fila_push_salvar', { uid: ADM });
  return { ok: !recusou(x) && !recusou(y), detalhe: `${x.msg || 'ok'} | ${y.msg || 'ok'}`.slice(0, 120) };
});
await caso('exceções que nunca são recusadas: service_role, rotina do banco, funções app_* e as públicas (config, saúde, incidente, ticket da fila)', async () => {
  const srv = await chamar('chat_listar', { papel: 'service_role' }), interna = await chamar('chat_listar', { semHttp: true }), viaApp = await chamar('chat_listar', { caminho: '/rpc/app_conta_antiga_migrar' });
  const publicas = []; for (const n of NAO_PROTEGIDAS) { const x = await chamar(n); if (recusou(x)) publicas.push(n); }
  return { ok: !recusou(srv) && !recusou(interna) && !recusou(viaApp) && publicas.length === 0, detalhe: `recusadas indevidamente: ${publicas.join(' ') || 'nenhuma'}` };
});
await caso('contas antigas: sem PIN, conta_paciente_conversas (códigos das conversas), conta_paciente_resumo e conta_paciente_meus_dados (CPF e histórico) NÃO respondem; com PIN respondem', async () => {
  const sem = [await chamar('conta_paciente_conversas'), await chamar('conta_paciente_resumo'), await chamar('conta_paciente_meus_dados')];
  const com = [await chamar('conta_paciente_conversas', { cab: { 'x-acesso': TOK } }), await chamar('conta_paciente_resumo', { cab: { 'x-acesso': TOK } })];
  return { ok: sem.every(recusou) && com.every((x) => x.ok), detalhe: `sem=${sem.map((x) => (recusou(x) ? 'recusou' : 'PASSOU')).join(',')} com=${com.map((x) => (x.ok ? 'ok' : x.msg.slice(0, 30))).join(',')}` };
});
await caso('as 4 funções reescritas em PL/pgSQL mantêm o resultado de antes (conta que não existe)', async () => {
  const c = await chamar('conta_paciente_conversas', { cab: { 'x-acesso': TOK } }), r = await chamar('conta_paciente_resumo', { cab: { 'x-acesso': TOK } });
  const v = await chamar('conta_paciente_vinculo_estado', { cab: { 'x-acesso': TOK } }), t = await chamar('conta_precisa_trocar_senha', { cab: { 'x-acesso': TOK } });
  return { ok: JSON.stringify(c.r) === '[]' && r.r && r.r.conta === false && v.r && v.r.ligada === false && t.r === false, detalhe: JSON.stringify([c.r, r.r, v.r, t.r]).slice(0, 140) };
});

// ---- desligar libera
await caso('desligar app_pin_servidor, app_pin_obrigatorio ou app_acesso_modo libera TODAS na hora', async () => {
  const resultado = [];
  for (const [chave, valor] of [['app_pin_servidor', 'nao'], ['app_pin_obrigatorio', 'nao'], ['app_acesso_modo', 'nao']]) {
    const volta = (await um(`select valor from public.config where chave = $1`, [chave])).valor;
    await cfg(chave, valor);
    const ruins = []; for (const n of TODAS) if (recusou(await chamar(n))) ruins.push(n);
    resultado.push(ruins.length === 0); await cfg(chave, volta);
  }
  return { ok: resultado.every(Boolean), detalhe: resultado.join(',') };
});
await caso('as funções da trava não podem ser chamadas pelo público', async () => {
  const r = [];
  for (const f of ['app_pin_token()', 'app_pin_exigir()', 'app_pin_exigir_leitura()']) { await anonimo(); try { await q(`select public.${f}`); r.push(false); } catch (e) { r.push(/permission denied/.test(e.message)); } finally { await db.exec('reset role'); } }
  return { ok: r.every(Boolean), detalhe: r.join(',') };
});

console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} casos passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
