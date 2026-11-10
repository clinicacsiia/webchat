// FLUXOGRAMA: entrada (supabase/etapa-e-vinculo-manual.sql num Postgres embutido com pessoas e cadastros inventados) -> validação (dois prontuários na mesma pessoa e um prontuário em duas pessoas voltam como conflito; só a supervisão troca; modo "supervisao" barra atendente) -> lógica (log com antes/depois/quem/quando por gatilho; o desfazer também é registrado) -> saída (PASS/FAIL)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (AGE-02)
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
const TI = '11111111-1111-1111-1111-111111111111', SUP = '22222222-2222-2222-2222-222222222222', AT = '33333333-3333-3333-3333-333333333333';
await db.exec(`
  alter table public.agentes add column nome text;
  alter table public.conversas add column nome text;
  create table public.jornada_paciente (prontuario text primary key, nome text);
  insert into public.jornada_paciente values ('P1', 'Ana'), ('P2', 'Ana B'), ('P3', 'Carla');
  create table public.pessoa_klingo_vinculo (prontuario text primary key, conversa_id uuid not null references public.conversas(id) on delete cascade, por uuid, em timestamptz not null default now());
  create table public.org_membro (id bigint generated always as identity primary key, agente_id uuid, funcao text, ativo boolean default true);
  create function public.org_nivel() returns text language sql stable as $$ select case when (select papel from public.agentes where id = (select auth.uid())) = 'admin' then 'ti' else (select funcao from public.org_membro where agente_id = (select auth.uid()) limit 1) end $$;
  create function public.org_log_imutavel_trg() returns trigger language plpgsql as $$ begin raise exception 'imutavel' using errcode = '42501'; end $$;
  create function public.pessoa_equipe() returns void language plpgsql as $$ begin if (select papel from public.agentes where id = (select auth.uid())) is null then raise exception 'equipe' using errcode = '42501'; end if; end $$;
  create function public.pessoa_membros(c uuid) returns uuid[] language sql as $$ select array[c] $$;
  insert into public.agentes (id, papel, nome) values ('${TI}', 'admin', 'Alisson'), ('${SUP}', 'atendente', 'Sandra'), ('${AT}', 'atendente', 'Ana');
  insert into public.org_membro (agente_id, funcao) values ('${SUP}', 'supervisor'), ('${AT}', 'atendente');
  create function public.como(uid uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid)::text, false) $$;
`);
const sql = readFileSync(`${REPO}/supabase/etapa-e-vinculo-manual.sql`, 'utf8');
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
const conv = async () => (await db.query(`insert into public.conversas default values returning id`)).rows[0].id;
const [c1, c2] = [await conv(), await conv()];
const como = async (u, fn) => { await db.query(`select public.como($1)`, [u]); return fn(); };
const conf = (u, p, c, s = false) => como(u, async () => (await db.query(`select public.pessoa_klingo_confirmar_sup($1, $2, $3) r`, [p, c, s])).rows[0].r);
const erro = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const log = async () => (await db.query(`select acao, prontuario, por, antes, depois from public.vinculo_log order by id`)).rows;
await caso('modo padrão ("equipe"): atendente confirma o primeiro vínculo e fica no log com quem/quando', async () => {
  const r = await conf(AT, 'P1', c1); const l = await log();
  return { ok: r.ok === true && l.length === 1 && l[0].acao === 'vinculado' && l[0].por === AT && l[0].prontuario === 'P1' && l[0].depois.conversa_id === c1 };
});
await caso('dois prontuários na mesma pessoa: volta CONFLITO (nada muda) para a tela perguntar', async () => {
  const r = await conf(AT, 'P2', c1); const n = (await db.query(`select count(*)::int n from public.pessoa_klingo_vinculo`)).rows[0].n;
  return { ok: r.ok === false && r.conflito === 'pessoa_ja_tem_outro_prontuario' && r.atual === 'P1' && n === 1 };
});
await caso('o mesmo prontuário em outra pessoa: CONFLITO; atendente não consegue forçar com p_substituir', async () => {
  const r = await conf(AT, 'P1', c2); const e = await erro(() => conf(AT, 'P1', c2, true));
  return { ok: r.ok === false && r.conflito === 'prontuario_ja_ligado_a_outra_pessoa' && e && e.code === '42501' };
});
await caso('a supervisão pode trocar (p_substituir): o antigo sai, o novo entra, e o log guarda antes e depois', async () => {
  const r = await conf(SUP, 'P2', c1, true); const v = (await db.query(`select prontuario from public.pessoa_klingo_vinculo`)).rows.map((x) => x.prontuario);
  const l = await log();
  return { ok: r.ok === true && v.length === 1 && v[0] === 'P2' && l.some((x) => x.acao === 'desfeito' && x.prontuario === 'P1' && x.antes.conversa_id === c1) && l.some((x) => x.acao === 'vinculado' && x.prontuario === 'P2' && x.por === SUP) };
});
await caso('modo "supervisao": atendente é barrado; supervisão e TI passam', async () => {
  await db.query(`update public.config set valor = 'supervisao' where chave = 'vinculo_manual_quem'`);
  const e = await erro(() => conf(AT, 'P3', c2)); const ok1 = await conf(SUP, 'P3', c2); const ok2 = await conf(TI, 'P3', c2);
  await db.query(`update public.config set valor = 'equipe' where chave = 'vinculo_manual_quem'`);
  return { ok: e && e.code === '42501' && ok1.ok && ok2.ok };
});
await caso('o desfazer (apagar o vínculo por qualquer caminho) também é registrado; o log não se apaga', async () => {
  await db.query(`delete from public.pessoa_klingo_vinculo where prontuario = 'P3'`);
  const l = await log(); const e = await erro(() => db.query(`delete from public.vinculo_log`));
  return { ok: l[l.length - 1].acao === 'desfeito' && l[l.length - 1].prontuario === 'P3' && e && e.code === '42501' };
});
await caso('prontuário inexistente e conversa inexistente são recusados', async () => {
  const e1 = await erro(() => conf(AT, 'XXX', c1)), e2 = await erro(() => conf(AT, 'P1', '99999999-9999-9999-9999-999999999999'));
  return { ok: e1 && e1.code === '22023' && e2 && e2.code === '22023' };
});
console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} verificações passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
