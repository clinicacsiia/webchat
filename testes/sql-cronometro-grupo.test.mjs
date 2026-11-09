// FLUXOGRAMA: entrada (supabase/cronometro-grupo.sql num Postgres embutido, com conversas unidas por grupo e por contato) -> validação (aplica o arquivo duas vezes) -> lógica (resposta de pessoa zera o relógio das outras conversas abertas da mesma pessoa; paciente de outra pessoa, conversa encerrada e resposta do assistente NÃO mexem; a Parte 2 conserta relógio que já ficou para trás) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const arquivo = readFileSync(`${REPO}/supabase/cronometro-grupo.sql`, 'utf8');
const parte1 = arquivo.match(/create or replace function public\.mensagem_inserida\(\)[\s\S]*?end \$\$;/)[0];
const parte2 = arquivo.match(/update public\.conversas c set cliente_aguarda_desde = null\s+where c\.status[\s\S]*?\)\);\s*$/m)[0];

const db = new PGlite();
await db.exec(`
  create schema realtime; create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void language sql as $$ select 1 $$;
  create table public.agentes (id uuid primary key default gen_random_uuid(), nome text);
  create table public.contatos (id uuid primary key default gen_random_uuid(), ultimo_contato_em timestamptz);
  create table public.conversas (id uuid primary key default gen_random_uuid(), contato_id uuid, status text default 'em_atendimento', ia_ativa boolean default false,
    ultima_mensagem text, atualizado_em timestamptz, nao_lidas_agente int default 0, cliente_aguarda_desde timestamptz, agente_id uuid);
  create table public.conversa_grupo (conversa_id uuid primary key, grupo_id uuid not null);
  create table public.conversa_segredo (conversa_id uuid primary key, token text);
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, agente_id uuid, texto text, opcoes jsonb, criado_em timestamptz default now());
`);

await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(parte1); await db.exec(parte1); await db.exec(parte2); await db.exec(parte2); return { ok: true }; });
await db.exec(`create trigger t after insert on public.mensagens for each row execute function public.mensagem_inserida()`);

const humano = (await db.query(`insert into public.agentes (nome) values ('Aimê') returning id`)).rows[0].id;
const contato = async () => (await db.query(`insert into public.contatos default values returning id`)).rows[0].id;
const nova = async (contatoId, status = 'em_atendimento') => (await db.query(`insert into public.conversas (contato_id, status) values ($1, $2) returning id`, [contatoId, status])).rows[0].id;
const msg = (c, autor, agente = null, em = null) => db.query(`insert into public.mensagens (conversa_id, autor, agente_id, texto, criado_em) values ($1, $2, $3, 'oi', coalesce($4::timestamptz, now()))`, [c, autor, agente, em]);
const desde = async (c) => (await db.query(`select cliente_aguarda_desde d from public.conversas where id = $1`, [c])).rows[0].d;
const unir = async (...ids) => { const g = (await db.query(`select gen_random_uuid() g`)).rows[0].g; for (const id of ids) await db.query(`insert into public.conversa_grupo values ($1, $2)`, [id, g]); };

await caso('caso da tela: resposta na conversa nova (unida por grupo) zera o relógio da conversa antiga', async () => {
  const antiga = await nova(await contato()), nova1 = await nova(await contato()); await unir(antiga, nova1);
  await msg(antiga, 'cliente'); await msg(nova1, 'cliente');
  const antes = await desde(antiga);
  await msg(nova1, 'agente', humano);
  return { ok: antes !== null && (await desde(nova1)) === null && (await desde(antiga)) === null };
});
await caso('mesmo contato, sem grupo: também zera', async () => {
  const ct = await contato(); const a = await nova(ct), b = await nova(ct);
  await msg(a, 'cliente'); await msg(b, 'cliente'); await msg(b, 'agente', humano);
  return { ok: (await desde(a)) === null && (await desde(b)) === null };
});
await caso('outra pessoa (sem grupo, outro contato) NÃO é afetada', async () => {
  const a = await nova(await contato()), outra = await nova(await contato());
  await msg(a, 'cliente'); await msg(outra, 'cliente'); const antes = await desde(outra);
  await msg(a, 'agente', humano);
  return { ok: (await desde(a)) === null && (await desde(outra))?.getTime() === antes.getTime() };
});
await caso('conversa encerrada do mesmo grupo não é mexida', async () => {
  const ct = await contato(); const a = await nova(ct), enc = await nova(ct, 'encerrada');
  await msg(a, 'cliente');
  await db.query(`update public.conversas set cliente_aguarda_desde = now() - interval '1 day' where id = $1`, [enc]);
  const antes = await desde(enc);
  await msg(a, 'agente', humano);
  return { ok: (await desde(enc))?.getTime() === antes.getTime() };
});
await caso('mensagem do assistente virtual (sem agente_id) NÃO zera nenhuma conversa do grupo', async () => {
  const ct = await contato(); const a = await nova(ct), b = await nova(ct);
  await msg(a, 'cliente'); await msg(b, 'cliente'); const antes = await desde(b);
  await msg(a, 'agente');
  return { ok: (await desde(a))?.getTime() !== undefined && (await desde(b))?.getTime() === antes.getTime() };
});
await caso('mensagem do paciente continua iniciando o relógio (e não o reinicia)', async () => {
  const a = await nova(await contato()); await msg(a, 'cliente'); const t1 = await desde(a); await msg(a, 'cliente');
  return { ok: t1 !== null && (await desde(a)).getTime() === t1.getTime() };
});
await caso('Parte 2: conserta o relógio que ficou para trás (resposta de pessoa posterior em outra conversa da pessoa)', async () => {
  const ct = await contato(); const antiga = await nova(ct), nova1 = await nova(ct), sozinha = await nova(await contato());
  await db.query(`update public.conversas set cliente_aguarda_desde = now() - interval '5 hours' where id in ($1, $2)`, [antiga, sozinha]);
  await msg(nova1, 'agente', humano, new Date().toISOString());
  await db.exec(parte2);
  return { ok: (await desde(antiga)) === null && (await desde(sozinha)) !== null };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length}`);
process.exit(falhas ? 1 : 0);
