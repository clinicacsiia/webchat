// FLUXOGRAMA: entrada (supabase/etapa-b-estrutura.sql num Postgres embutido com equipes, contas e conversas inventadas, usando as policies RLS de verdade) -> validação (modo desligado/observação não bloqueia nada; ligado bloqueia pela API direta; ninguém concede mais do que tem; log imutável) -> lógica (quem vê o quê por unidade, Call Center transversal, triagem sem unidade, conversa própria) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (Etapa B)
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
const TI = '11111111-1111-1111-1111-111111111111', SUP = '22222222-2222-2222-2222-222222222222', AT1 = '33333333-3333-3333-3333-333333333333', AT2 = '44444444-4444-4444-4444-444444444444', MKT = '55555555-5555-5555-5555-555555555555', CC = '66666666-6666-6666-6666-666666666666', GER = '77777777-7777-7777-7777-777777777777', LZ = '88888888-8888-8888-8888-888888888888';
await db.exec(`
  alter table public.agentes add column nome text;
  create table public.unidade_config (chave text primary key, rotulo text, ordem int default 0, ativo boolean default true);
  insert into public.unidade_config (chave, rotulo) values ('desenvoar', 'Desenvoar'), ('csi', 'CSI'), ('rmtc', 'RM/TC');
  alter table public.conversas add column agente_id uuid, add column unidade_inicial text, add column teste boolean not null default false, add column status text not null default 'aguardando';
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid references public.conversas(id), texto text);
  alter table public.conversas enable row level security; alter table public.mensagens enable row level security;
  create policy conversas_select on public.conversas for select to authenticated using ((select public.papel_atual()) is not null);
  create policy mensagens_select on public.mensagens for select to authenticated using ((select public.papel_atual()) = any (array['admin','atendente']));
  grant select on public.conversas, public.mensagens to authenticated;
  insert into public.agentes (id, papel, nome) values ('${TI}', 'admin', 'Alisson'), ('${SUP}', 'atendente', 'Carla Adrielle'), ('${AT1}', 'atendente', 'Ana'), ('${AT2}', 'atendente', 'Bia'), ('${MKT}', 'marketing', 'Mara'), ('${CC}', 'atendente', 'Cris'), ('${GER}', 'atendente', 'Gabi'), ('${LZ}', 'atendente', 'Luzia');
`);
const sql = readFileSync(`${REPO}/supabase/etapa-b-estrutura.sql`, 'utf8');
await caso('o arquivo aplica sem erro e pode ser aplicado de novo (sem duplicar a estrutura)', async () => {
  await db.exec(sql); await db.exec(sql);
  const n = (await db.query(`select (select count(*) from public.org_equipe)::int e, (select count(*) from public.org_membro where funcao = 'atendente')::int a, (select count(*) from public.org_membro where funcao = 'ti')::int t`)).rows[0];
  return { ok: n.e === 4 && n.a === 16 && n.t === 1, detalhe: JSON.stringify(n) };
});
await db.exec(`
  create function public.como(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid)::text, false) $$;
`);
const eq = async (nome) => (await db.query(`select id from public.org_equipe where nome = $1`, [nome])).rows[0].id;
const como = async (uid, fn) => { await db.query(`select public.como($1)`, [uid]); await db.exec(`set role authenticated`); try { return await fn(); } finally { await db.exec(`reset role`); } };
const visiveis = (uid) => como(uid, async () => (await db.query(`select count(*)::int n from public.conversas`)).rows[0].n);
const erro = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
// conversas: 3 desenvoar, 2 csi, 1 sem unidade, 1 da Ana (desenvoar, dona)
await db.exec(`insert into public.conversas (unidade_inicial) select 'desenvoar' from generate_series(1,3); insert into public.conversas (unidade_inicial) select 'csi' from generate_series(1,2); insert into public.conversas (unidade_inicial) values (null);`);
await db.query(`insert into public.conversas (unidade_inicial, agente_id) values ('rmtc', $1)`, [AT1]);
const CAR = await eq('Equipe Carla Adrielle'), LUZ = await eq('Equipe Luzia'), CCE = await eq('Call Center');
await db.exec(`update public.org_equipe set unidade = 'desenvoar' where id = ${CAR}`);
await db.query(`select public.como($1)`, [TI]);
await db.query(`insert into public.org_membro (equipe_id, agente_id, funcao) values ($1, $2, 'atendente'), ($1, $3, 'atendente'), ($4, $5, 'atendente'), ($6, $7, 'atendente')`, [CAR, AT1, AT2, LUZ, LZ, CCE, CC]);
await db.query(`insert into public.org_membro (equipe_id, agente_id, funcao) values (null, $1, 'gerente')`, [GER]);

await caso('modo OBSERVAÇÃO (padrão): ninguém perde acesso — atendente da Luzia ainda vê as 7 conversas', async () => ({ ok: (await visiveis(LZ)) === 7 && (await visiveis(AT2)) === 7 }));
await caso('simulação: mostra, por pessoa, quantas ela deixaria de ver se o modo fosse "ligado" (e só o administrador lê)', async () => {
  const r = await como(TI, async () => (await db.query(`select public.permissao_simular() r`)).rows[0].r);
  const sup = r.pessoas.find((p) => p.nome === 'Carla Adrielle'), ana = r.pessoas.find((p) => p.nome === 'Ana');
  const e = await como(AT1, () => erro(() => db.query(`select public.permissao_simular()`)));
  return { ok: r.modo === 'observacao' && sup.total_visiveis === 3 && ana.total_visiveis === 4 && e && e.code === '42501', detalhe: `Carla vê ${sup.total_visiveis}/${sup.total}, Ana ${ana.total_visiveis}/${ana.total}` };
});
await db.query(`select public.como($1)`, [TI]);
await como(TI, () => db.query(`select public.permissao_modo_definir('ligado')`));
await caso('modo LIGADO pela API direta: atendente da Luzia (CSI) vê só CSI; da equipe sem unidade vê as do desenvoar + as próprias', async () => {
  const [luz, ana, bia] = [await visiveis(LZ), await visiveis(AT1), await visiveis(AT2)];
  return { ok: luz === 2 && ana === 4 && bia === 3, detalhe: `Luzia=${luz} Ana=${ana} Bia=${bia}` };
});
await caso('mensagens seguem a mesma regra (mensagem de conversa de outra unidade não vem)', async () => {
  await db.exec(`insert into public.mensagens (conversa_id, texto) select id, 'oi' from public.conversas`);
  const bia = await como(AT2, async () => (await db.query(`select count(*)::int n from public.mensagens`)).rows[0].n);
  const ti = await como(TI, async () => (await db.query(`select count(*)::int n from public.mensagens`)).rows[0].n);
  return { ok: bia === 3 && ti === 7, detalhe: `Bia=${bia} TI=${ti}` };
});
await caso('Call Center (transversal) vê todas as unidades e a triagem sem unidade; gerência vê tudo; marketing e TI como hoje', async () => {
  const [cc, ger, mkt, ti] = [await visiveis(CC), await visiveis(GER), await visiveis(MKT), await visiveis(TI)];
  return { ok: cc === 7 && ger === 7 && mkt === 7 && ti === 7, detalhe: `CC=${cc} Ger=${ger} Mkt=${mkt} TI=${ti}` };
});
await caso('conversa transferida para outra unidade (unidade_responsavel) muda quem vê', async () => {
  await db.exec(`update public.conversas set unidade_responsavel = 'csi' where unidade_inicial = 'desenvoar' and id = (select id from public.conversas where unidade_inicial = 'desenvoar' limit 1)`);
  const [luz, bia] = [await visiveis(LZ), await visiveis(AT2)];
  return { ok: luz === 3 && bia === 2, detalhe: `Luzia=${luz} Bia=${bia}` };
});
await como(TI, () => db.query(`select public.permissao_modo_definir('observacao')`));
await caso('voltar para observação devolve o acesso na hora', async () => ({ ok: (await visiveis(AT2)) === 7 }));

await caso('supervisão só cria atendente na PRÓPRIA equipe e não concede função maior (nem gerente, nem TI)', async () => {
  const ok1 = await como(SUP, () => db.query(`select public.org_membro_salvar(null, $1, null, 'Atendente 9', 'atendente', true) r`, [CAR]));
  const e1 = await como(SUP, () => erro(() => db.query(`select public.org_membro_salvar(null, $1, null, 'Atendente 9', 'atendente', true)`, [LUZ])));
  const e2 = await como(SUP, () => erro(() => db.query(`select public.org_membro_salvar(null, null, $1, null, 'gerente', true)`, [AT1])));
  const e3 = await como(SUP, () => erro(() => db.query(`select public.org_membro_salvar(null, $1, $2, null, 'supervisor', true)`, [CAR, AT1])));
  return { ok: ok1.rows[0].r > 0 && e1 && e1.code === '42501' && e2 && e2.code === '42501' && e3 && e3.code === '42501', detalhe: [e1 && e1.message, e2 && e2.message].join(' | ') };
});
await caso('atendente comum não vê nem edita a estrutura; gerência cria equipe; só TI concede TI', async () => {
  const a = await como(AT1, () => erro(() => db.query(`select public.org_estrutura()`)));
  const b = await como(GER, () => db.query(`select public.org_equipe_salvar(null, 'Equipe Nova', 'rmtc', false, true) id`));
  const c = await como(GER, () => erro(() => db.query(`select public.org_membro_salvar(null, null, $1, null, 'ti', true)`, [AT1])));
  const d = await como(TI, () => db.query(`select public.org_membro_salvar(null, null, $1, null, 'ti', true) id`, [AT2]));
  return { ok: a && a.code === '42501' && b.rows[0].id > 0 && c && c.code === '42501' && d.rows[0].id > 0 };
});
await caso('vincular "Atendente 1" a uma conta real mantém a função e grava no log', async () => {
  const m = (await db.query(`select id from public.org_membro where equipe_id = $1 and rotulo = 'Atendente 1'`, [CCE])).rows[0].id;
  await como(TI, () => db.query(`select public.org_membro_vincular($1, $2)`, [m, MKT]));
  const r = (await db.query(`select agente_id, funcao, rotulo from public.org_membro where id = $1`, [m])).rows[0];
  const l = (await db.query(`select count(*)::int n from public.org_alteracao_log where alvo = 'membro:' || $1`, [m])).rows[0].n;
  return { ok: r.agente_id === MKT && r.funcao === 'atendente' && r.rotulo === null && l === 1 };
});
await caso('o log de alterações não se apaga nem se altera', async () => {
  const e1 = await erro(() => db.query(`delete from public.org_alteracao_log`)), e2 = await erro(() => db.query(`update public.org_alteracao_log set acao = 'x'`));
  return { ok: e1 && e2 && e1.code === '42501' };
});
await caso('a estrutura inicial usa nomes provisórios: 4 equipes, "Atendente 1..4" em cada, nenhum papel de conta mudou', async () => {
  const papel = (await db.query(`select papel from public.agentes where id = $1`, [SUP])).rows[0].papel;
  const r = (await db.query(`select count(*)::int n from public.org_membro where rotulo like 'Atendente %'`)).rows[0].n;
  return { ok: papel === 'atendente' && r >= 14 };
});

console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} verificações passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
