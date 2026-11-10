// FLUXOGRAMA: entrada (as funções reais convenio_chave/ativo/msg de convenios-e-foto.sql + supabase/etapa-e-convenio-suspenso.sql num Postgres embutido) -> validação (só TI e gerência; Particular não suspende) -> lógica (suspenso some do chat e responde com o aviso próprio; 1 mês depois só avisa; não reativa sozinho; renovar e reativar) -> saída (PASS/FAIL)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (CAT-01)
import { readFileSync } from 'node:fs';
import { criarBanco, funcao, REPO } from './stubs-supabase.mjs';
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
const TI = '11111111-1111-1111-1111-111111111111', GER = '77777777-7777-7777-7777-777777777777', AT = '33333333-3333-3333-3333-333333333333';
const conv = readFileSync(`${REPO}/supabase/convenios-e-foto.sql`, 'utf8');
const tabela = conv.match(/create table if not exists public\.convenio_config \([\s\S]*?\);/)[0];
await db.exec(`
  create role service_role nologin;
  create schema cron; create table cron.job (jobname text); create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ select 1::bigint $$;
  alter table public.agentes add column nome text;
  ${tabela}
  create table public.fluxo_texto (chave text primary key, texto text);
  insert into public.fluxo_texto values ('convenio_inativo', 'O convênio {convenio} está desativado.'), ('convenio_varios', 'Só um exame por vez.');
  create function public.fluxo_t(c text) returns text language sql stable as $$ select texto from public.fluxo_texto where chave = c $$;
  create table public.org_membro (id bigint generated always as identity primary key, equipe_id bigint, agente_id uuid, rotulo text, funcao text, ativo boolean default true, fim date);
  create table public.org_alteracao_log (id bigint generated always as identity primary key, em timestamptz default now(), por uuid, acao text, alvo text, antes jsonb, depois jsonb);
  create table public.equipe_notificacao (id bigint generated always as identity primary key, agente_id uuid, tipo text, conversa_id uuid, detalhe jsonb default '{}', criado_em timestamptz default now(), lida_em timestamptz);
  create function public.org_nivel() returns text language sql stable as $$ select case when (select papel from public.agentes where id = (select auth.uid())) = 'admin' then 'ti' else (select funcao from public.org_membro where agente_id = (select auth.uid()) limit 1) end $$;
  ${funcao('convenios-e-foto.sql', 'convenio_chave')}
  insert into public.agentes (id, papel, nome) values ('${TI}', 'admin', 'Alisson'), ('${GER}', 'atendente', 'Gabi'), ('${AT}', 'atendente', 'Ana');
  insert into public.org_membro (agente_id, funcao) values ('${GER}', 'gerente'), ('${AT}', 'atendente');
  create function public.como(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid)::text, false) $$;
`).catch(async (e) => { console.error('setup:', e.message); process.exit(1); });
const sql = readFileSync(`${REPO}/supabase/etapa-e-convenio-suspenso.sql`, 'utf8');
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
const como = async (uid, fn) => { await db.query(`select public.como($1)`, [uid]); return fn(); };
const erro = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const ativo = async (n) => (await db.query(`select public.convenio_ativo($1) a`, [n])).rows[0].a;
await db.exec(`insert into public.convenio_config (operadora, ativo) values ('AMIL', true)`);
await caso('antes: o convênio está ativo; atendente comum NÃO consegue suspender', async () => {
  const e = await como(AT, () => erro(() => db.query(`select public.convenio_suspender('Amil', 'x')`)));
  return { ok: (await ativo('amil')) === true && e && e.code === '42501' };
});
await caso('gerência suspende: o paciente não consegue escolher (convenio_ativo=false) e o aviso fala em "suspenso por decisão administrativa"', async () => {
  const r = (await como(GER, () => db.query(`select public.convenio_suspender('amil', 'em renegociação') r`))).rows[0].r;
  const msg = (await db.query(`select public.convenio_msg('amil', 'inativo') m`)).rows[0].m;
  return { ok: r.ok && (await ativo('Amil')) === false && /Amil/.test(msg) && /suspenso por decisão administrativa/.test(msg) && /escolher outro/.test(msg), detalhe: msg };
});
await caso('desativado comum continua com a mensagem de desativado (não vira "suspenso")', async () => {
  await db.exec(`insert into public.convenio_config (operadora, ativo) values ('BRADESCO', false)`);
  const msg = (await db.query(`select public.convenio_msg('bradesco', 'inativo') m`)).rows[0].m;
  return { ok: (await ativo('bradesco')) === false && /desativado/.test(msg) };
});
await caso('Particular não suspende; sem permissão não suspende', async () => {
  const e1 = await como(TI, () => erro(() => db.query(`select public.convenio_suspender('Particular')`)));
  const e2 = await como(AT, () => erro(() => db.query(`select public.convenio_suspender('Amil')`)));
  return { ok: e1 && e1.code === '22023' && e2 && e2.code === '42501' };
});
await caso('1 mês depois: a rotina AVISA TI e gerência uma vez, e o convênio CONTINUA suspenso (não reativa sozinho)', async () => {
  await db.exec(`update public.convenio_config set suspenso_ate = now() - interval '1 day' where operadora = 'AMIL'`);
  const n1 = (await db.query(`select public.convenios_revisar() n`)).rows[0].n, n2 = (await db.query(`select public.convenios_revisar() n`)).rows[0].n;
  const avisos = (await db.query(`select agente_id from public.equipe_notificacao where tipo = 'convenio_revisar'`)).rows.map((x) => x.agente_id);
  const lista = (await como(GER, () => db.query(`select public.convenios_suspensos() r`))).rows[0].r;
  return { ok: n1 === 1 && n2 === 0 && avisos.includes(TI) && avisos.includes(GER) && !avisos.includes(AT) && (await ativo('amil')) === false && lista[0].revisar_agora === true };
});
await caso('renovar dá mais 1 mês e rearma o aviso; reativar libera o convênio e grava no log', async () => {
  const ate = (await como(GER, () => db.query(`select public.convenio_renovar('amil') d`))).rows[0].d;
  const r = (await como(GER, () => db.query(`select public.convenio_reativar('amil') ok`))).rows[0].ok;
  const log = (await db.query(`select acao from public.org_alteracao_log order by id`)).rows.map((x) => x.acao).join(',');
  return { ok: ate > new Date(Date.now() + 25 * 86400000) && r === true && (await ativo('amil')) === true && /convenio_suspenso,convenio_suspensao_renovada,convenio_reativado/.test(log), detalhe: log };
});
console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} verificações passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
