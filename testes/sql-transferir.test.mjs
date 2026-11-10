// FLUXOGRAMA: entrada (etapa-b-estrutura.sql + etapa-d-transferencias.sql num Postgres embutido, conversas e pessoas inventadas) -> validação (tudo ou nada no lote; encerrada, mesma pessoa e inexistente recusam; modo ligado recusa sem permissão e modo observação só registra) -> lógica (pessoa x unidade, evento "transferencia", notificação única por destinatário, indicadores por pessoa/equipe sem duplicar o total, silêncio do push) -> saída (PASS/FAIL)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (Etapa D)
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
const TI = '11111111-1111-1111-1111-111111111111', A1 = '33333333-3333-3333-3333-333333333333', A2 = '44444444-4444-4444-4444-444444444444', LZ = '88888888-8888-8888-8888-888888888888';
await db.exec(`
  create role service_role nologin;
  alter table public.agentes add column nome text;
  create table public.unidade_config (chave text primary key, rotulo text, ordem int default 0, ativo boolean default true);
  insert into public.unidade_config (chave, rotulo) values ('desenvoar', 'Desenvoar'), ('csi', 'CSI'), ('rmtc', 'RM/TC');
  alter table public.conversas add column agente_id uuid, add column unidade_inicial text, add column teste boolean not null default false, add column status text not null default 'aguardando', add column criado_em timestamptz default now();
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid references public.conversas(id), autor text, agente_id uuid, texto text default 'x', criado_em timestamptz not null default now());
  create table public.conversa_evento (id bigint generated always as identity primary key, conversa_id uuid, tipo text, em timestamptz not null default now(), de_agente uuid, para_agente uuid, por uuid, motivo text, detalhe jsonb not null default '{}'::jsonb);
  create table public.conversa_encerramento (id bigint generated always as identity primary key, conversa_id uuid, encerrada_em timestamptz, motivo text, origem text, por uuid);
  create table public.pre_agendamentos (id bigint generated always as identity primary key, conversa_id uuid, agendado_em timestamptz, agendado_por uuid, agendado_auto_em timestamptz);
  create table public.equipe_notificacao (id bigint generated always as identity primary key, agente_id uuid, tipo text not null, conversa_id uuid, detalhe jsonb not null default '{}'::jsonb, criado_em timestamptz not null default now(), lida_em timestamptz);
  create table public.chat_push_inscricao (conversa_id uuid);
  create table public.conversa_segredo (conversa_id uuid primary key, token text not null default md5(random()::text));
  create function public.fila_aviso_segredo() returns text language sql as $$ select 'seg' $$;
  alter table public.conversas enable row level security; alter table public.mensagens enable row level security;
  create policy conversas_select on public.conversas for select to authenticated using ((select public.papel_atual()) is not null);
  create policy mensagens_select on public.mensagens for select to authenticated using ((select public.papel_atual()) = any (array['admin','atendente']));
  grant select on public.conversas, public.mensagens to authenticated;
  insert into public.agentes (id, papel, nome) values ('${TI}', 'admin', 'Alisson'), ('${A1}', 'atendente', 'Ana'), ('${A2}', 'atendente', 'Bia'), ('${LZ}', 'atendente', 'Luzia');
  create function public.como(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid)::text, false) $$;
`);
await db.exec(readFileSync(`${REPO}/supabase/etapa-b-estrutura.sql`, 'utf8'));
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { const s = readFileSync(`${REPO}/supabase/etapa-d-transferencias.sql`, 'utf8'); await db.exec(s); await db.exec(s); return { ok: true }; });

const eqId = async (n) => (await db.query(`select id from public.org_equipe where nome = $1`, [n])).rows[0].id;
const [CAR, LUZ] = [await eqId('Equipe Carla Adrielle'), await eqId('Equipe Luzia')];
await db.exec(`update public.org_equipe set unidade = 'desenvoar' where id = ${CAR}`);
await db.query(`insert into public.org_membro (equipe_id, agente_id, funcao) values ($1, $2, 'atendente'), ($1, $3, 'atendente'), ($4, $5, 'atendente')`, [CAR, A1, A2, LUZ, LZ]);
const como = async (uid, fn) => { await db.query(`select public.como($1)`, [uid]); await db.exec(`set role authenticated`); try { return await fn(); } finally { await db.exec(`reset role`); } };
const conv = async (un, status = 'em_atendimento', dono = null) => (await db.query(`insert into public.conversas (unidade_inicial, status, agente_id) values ($1, $2, $3) returning id`, [un, status, dono])).rows[0].id;
const lin = async (id) => (await db.query(`select * from public.conversas where id = $1`, [id])).rows[0];
const T = (ids, ag, un, mot) => como(TI, async () => (await db.query(`select public.conversa_transferir($1::uuid[], $2, $3, $4) r`, [ids, ag, un, mot])).rows[0].r);
const erro = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

await caso('transferir para PESSOA: troca o responsável, grava o evento (de/para/quem/motivo) e avisa a pessoa uma vez', async () => {
  const c = await conv('desenvoar', 'em_atendimento', A1); const r = await T([c], A2, null, 'Pediu a Bia');
  const e = (await db.query(`select * from public.conversa_evento where conversa_id = $1 and tipo = 'transferencia'`, [c])).rows;
  const n = (await db.query(`select tipo, detalhe from public.equipe_notificacao where agente_id = $1 and conversa_id = $2`, [A2, c])).rows;
  return { ok: r.ok && (await lin(c)).agente_id === A2 && e.length === 1 && e[0].de_agente === A1 && e[0].para_agente === A2 && e[0].por === TI && e[0].motivo === 'Pediu a Bia' && n.length === 1 && n[0].tipo === 'transferida_para_voce' };
});
await caso('transferir para UNIDADE: devolve à fila (sem dono, aguardando) e muda unidade_responsavel; os membros da unidade são avisados', async () => {
  const c = await conv('desenvoar', 'em_atendimento', A1); const r = await T([c], null, 'csi', null); const x = await lin(c);
  const n = (await db.query(`select agente_id from public.equipe_notificacao where tipo = 'transferida_para_unidade' and conversa_id = $1`, [c])).rows.map((y) => y.agente_id);
  return { ok: r.ok && x.agente_id === null && x.status === 'aguardando' && x.unidade_responsavel === 'csi' && n.includes(LZ) && !n.includes(A1) };
});
await caso('LOTE de 10: tudo ou nada — uma encerrada no meio recusa o lote inteiro e diz qual', async () => {
  const ids = []; for (let i = 0; i < 9; i++) ids.push(await conv('desenvoar', 'em_atendimento', A1)); const enc = await conv('desenvoar', 'encerrada'); ids.push(enc);
  const r = await T(ids, A2, null, null); const trocou = (await db.query(`select count(*)::int n from public.conversas where id = any($1::uuid[]) and agente_id = $2`, [ids, A2])).rows[0].n;
  return { ok: r.ok === false && r.transferidas === 0 && trocou === 0 && r.recusadas.length === 1 && r.recusadas[0].id === enc, detalhe: r.mensagem };
});
await caso('LOTE de 10 válido: as 10 vão, com UMA notificação para o destinatário (resumo), e eventos individuais', async () => {
  const ids = []; for (let i = 0; i < 10; i++) ids.push(await conv('desenvoar', 'em_atendimento', A1));
  const r = await T(ids, A2, null, null);
  const ev = (await db.query(`select count(*)::int n from public.conversa_evento where tipo = 'transferencia' and conversa_id = any($1::uuid[])`, [ids])).rows[0].n;
  const nt = (await db.query(`select detalhe from public.equipe_notificacao where agente_id = $1 and (detalhe->>'quantidade')::int = 10`, [A2])).rows;
  return { ok: r.ok && r.transferidas === 10 && ev === 10 && nt.length === 1 };
});
await db.query(`insert into public.agentes (id, papel, nome) values ('55555555-5555-5555-5555-555555555555', 'marketing', 'Mara')`);
await caso('recusas: para a mesma pessoa, destino inválido, mais de 50, sem escolher destino, e por quem não é da equipe', async () => {
  const c = await conv('desenvoar', 'em_atendimento', A1);
  const mesma = await T([c], A1, null, null);
  const e1 = await erro(() => T([c], '99999999-9999-9999-9999-999999999999', null, null)), e2 = await erro(() => T([c], A2, 'csi', null)), e3 = await erro(() => T([c], null, null, null));
  const e4 = await erro(() => T(Array.from({ length: 51 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`), A2, null, null));
  const e5 = await como(MKT_OU(), () => erro(() => db.query(`select public.conversa_transferir($1::uuid[], $2, null, null)`, [[c], A2])));
  return { ok: mesma.ok === false && e1 && e2 && e3 && e4 && e5 && e5.code === '42501' };
});
function MKT_OU() { return '55555555-5555-5555-5555-555555555555'; }
await caso('modo OBSERVAÇÃO: transferência fora da própria unidade passa, mas fica REGISTRADA como "seria recusada"; modo LIGADO recusa', async () => {
  const c = await conv('rmtc', 'em_atendimento', null);
  const antes = (await db.query(`select count(*)::int n from public.permissao_observacao`)).rows[0].n;
  await db.query(`select public.como($1)`, [A1]); await db.exec(`set role authenticated`);
  const r1 = (await db.query(`select public.conversa_transferir($1::uuid[], $2, null, null) r`, [[c], A2])).rows[0].r;
  await db.exec(`reset role`);
  const depois = (await db.query(`select count(*)::int n from public.permissao_observacao where acao = 'transferir'`)).rows[0].n;
  await db.exec(`update public.config set valor = 'ligado' where chave = 'permissao_modo'`);
  const c2 = await conv('rmtc', 'em_atendimento', null);
  await db.query(`select public.como($1)`, [A1]); await db.exec(`set role authenticated`);
  const r2 = (await db.query(`select public.conversa_transferir($1::uuid[], $2, null, null) r`, [[c2], A2])).rows[0].r;
  await db.exec(`reset role`); await db.exec(`update public.config set valor = 'observacao' where chave = 'permissao_modo'`);
  return { ok: r1.ok === true && depois > antes && r2.ok === false && (await lin(c2)).agente_id === null, detalhe: r2.mensagem };
});
await caso('indicadores por pessoa e equipe: contam o que cada um fez; a gestão vê todos, o atendente só ele; teste fica fora', async () => {
  const c = await conv('desenvoar', 'em_atendimento', A1);
  await db.query(`insert into public.mensagens (conversa_id, autor, agente_id) values ($1, 'agente', $2), ($1, 'agente', $2), ($1, 'agente', $3)`, [c, A1, A2]);
  await db.query(`insert into public.conversa_encerramento (conversa_id, encerrada_em, por) values ($1, now(), $2)`, [c, A1]);
  await db.query(`insert into public.pre_agendamentos (conversa_id, agendado_em, agendado_por) values ($1, now(), $2), ($1, now(), null)`, [c, A1]);
  await db.query(`insert into public.pre_agendamentos (conversa_id, agendado_auto_em) values ($1, now())`, [c]);
  const t = await conv('desenvoar', 'em_atendimento', A1); await db.query(`update public.conversas set teste = true where id = $1`, [t]); await db.query(`insert into public.mensagens (conversa_id, autor, agente_id) values ($1, 'agente', $2)`, [t, A1]);
  const ti = await como(TI, async () => (await db.query(`select public.painel_indicadores_equipe(current_date - 1, current_date) r`)).rows[0].r);
  const ana = ti.pessoas.find((p) => p.nome === 'Ana'), bia = ti.pessoas.find((p) => p.nome === 'Bia');
  const so = await como(A1, async () => (await db.query(`select public.painel_indicadores_equipe(current_date - 1, current_date) r`)).rows[0].r);
  const eq = ti.equipes.find((x) => x.equipe === 'Equipe Carla Adrielle');
  return { ok: ana.mensagens === 2 && bia.mensagens === 1 && ana.encerradas === 1 && ana.agendados === 1 && ti.agendados_pelo_sistema === 1 && so.pessoas.length === 1 && so.pessoas[0].nome === 'Ana' && eq.mensagens >= 3, detalhe: JSON.stringify(ana) };
});
await caso('sino do paciente: silenciar e reativar; o gatilho de push respeita o silêncio', async () => {
  const c = await conv('desenvoar'); await db.query(`insert into public.conversa_segredo (conversa_id) values ($1)`, [c]); await db.query(`insert into public.chat_push_inscricao values ($1)`, [c]);
  const tk = (await db.query(`select token from public.conversa_segredo where conversa_id = $1`, [c])).rows[0].token;
  const e0 = (await db.query(`select public.chat_push_estado($1, $2) r`, [c, tk])).rows[0].r;
  await db.query(`select public.chat_push_silenciar($1, $2, true)`, [c, tk]); const e1 = (await db.query(`select public.chat_push_estado($1, $2) r`, [c, tk])).rows[0].r;
  const errTk = await erro(() => db.query(`select public.chat_push_silenciar($1, 'errado', true)`, [c]));
  await db.query(`select public.chat_push_silenciar($1, $2, false)`, [c, tk]); const e2 = (await db.query(`select public.chat_push_estado($1, $2) r`, [c, tk])).rows[0].r;
  return { ok: e0.inscrito && !e0.silenciado && e1.silenciado && !e2.silenciado && errTk && /não encontrada/.test(errTk.message) };
});

console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} verificações passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
