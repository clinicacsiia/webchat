// FLUXOGRAMA: entrada (supabase/agendado-autoria.sql num Postgres embutido) -> validação (quem muda o status: pessoa da equipe, ou o sistema sem identidade) -> lógica (guarda quando virou agendado e quem foi; só na virada; nunca atrapalha a gravação) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (Q-15)
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
const EQUIPE = '22222222-2222-2222-2222-222222222222';
await db.exec(`
  create table public.pre_agendamentos (id uuid primary key default gen_random_uuid(), status text not null default 'rascunho', agendado_auto_em timestamptz, observacao text);
  insert into public.agentes (id, papel) values ('${EQUIPE}', 'atendente');
`);
const sql = readFileSync(`${REPO}/supabase/agendado-autoria.sql`, 'utf8');
await caso('o arquivo aplica sem erro e pode ser aplicado de novo (sem "drop")', async () => { await db.exec(sql); await db.exec(sql); return { ok: !/\bdrop\b/i.test(sql.replace(/--.*$/gm, '')) }; });
const jwt = (uid) => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(uid ? { sub: uid } : {})]);
const novo = async () => (await db.query(`insert into public.pre_agendamentos (status) values ('pronto') returning id`)).rows[0].id;
const ler = async (id) => (await db.query(`select status, agendado_em, agendado_por from public.pre_agendamentos where id = $1`, [id])).rows[0];

await caso('a atendente marca como agendado: guarda quando e quem', async () => {
  await jwt(EQUIPE); const id = await novo();
  await db.query(`update public.pre_agendamentos set status = 'agendado' where id = $1`, [id]);
  const x = await ler(id);
  return { ok: x.agendado_em && x.agendado_por === EQUIPE };
});
await caso('o sistema (sem identidade de equipe) marca: guarda quando, mas ninguém em "quem"', async () => {
  await jwt(null); const id = await novo();
  await db.query(`update public.pre_agendamentos set status = 'agendado', agendado_auto_em = now() where id = $1`, [id]);
  const x = await ler(id);
  return { ok: x.agendado_em && x.agendado_por === null };
});
await caso('só na virada: outra gravação no mesmo status não muda quando nem quem; voltar para pronto e agendar de novo grava de novo', async () => {
  await jwt(EQUIPE); const id = await novo();
  await db.query(`update public.pre_agendamentos set status = 'agendado' where id = $1`, [id]);
  const a = (await ler(id)).agendado_em;
  await new Promise((r) => setTimeout(r, 30));
  await db.query(`update public.pre_agendamentos set status = 'agendado', observacao = 'x' where id = $1`, [id]);
  const b = (await ler(id)).agendado_em;
  await db.query(`update public.pre_agendamentos set status = 'pronto' where id = $1`, [id]);
  await new Promise((r) => setTimeout(r, 30));
  await db.query(`update public.pre_agendamentos set status = 'agendado' where id = $1`, [id]);
  const c = (await ler(id)).agendado_em;
  return { ok: a.getTime() === b.getTime() && c.getTime() > a.getTime() };
});
await caso('gatilho com defeito não atrapalha a gravação (a função de papel some e o status muda mesmo assim)', async () => {
  await jwt(EQUIPE); const id = await novo();
  await db.exec(`alter function public.papel_atual() rename to papel_atual_x`);
  let erro = null;
  try { await db.query(`update public.pre_agendamentos set status = 'agendado' where id = $1`, [id]); } catch (e) { erro = e; }
  await db.exec(`alter function public.papel_atual_x() rename to papel_atual`);
  return { ok: !erro && (await ler(id)).status === 'agendado', detalhe: erro && erro.message };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
