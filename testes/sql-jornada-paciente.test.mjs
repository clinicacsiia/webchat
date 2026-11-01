// FLUXOGRAMA: entrada (jornada-paciente.sql num Postgres embutido com cartões e exames simulados) -> validação (anônimo recusado; só a própria conta; Klingo só com identidade conferida, nome e telefone iguais) -> lógica (passo 1 a 6 por exame, exceções, resumo feitos/faltam, sem horário) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';
import { createHash } from 'node:crypto';

const resultados = [];
const registrar = (nome, ok, d = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, 'exceção: ' + e.message.split('\n')[0]); } };
const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
await db.exec(`
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create table public.contas_paciente (id uuid primary key references auth.users(id) on delete cascade, email text, nome text, telefone text, identidade_conferida_em timestamptz);
  alter table public.conversas add column conta_id uuid;
  create table public.jornada_paciente (prontuario text primary key, nome text, fone_chave text);
  create table public.jornada_card (id bigint generated always as identity primary key, paciente_chave text, data_ref date, unidade text, coluna text, conversa_id uuid, arquivado_em timestamptz);
  create table public.jornada_exame (id bigint generated always as identity primary key, card_id bigint, procedimento text, status text, confirm_status text);
  create function public.fila_dia(p timestamptz) returns date language sql immutable as $$ select (p at time zone 'America/Sao_Paulo')::date $$;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  insert into public.config values ('ia_segredo', 'segredo');
`);
await db.exec(readFileSync(`${REPO}/supabase/jornada-paciente.sql`, 'utf8')); await db.exec(readFileSync(`${REPO}/supabase/jornada-paciente.sql`, 'utf8'));
const q = async (s, p = []) => (await db.query(s, p)).rows;
const como = async (uid, fn) => { await db.exec(`set request.jwt.claims = '${uid ? JSON.stringify({ sub: uid }) : ''}'; set role ${uid ? 'authenticated' : 'anon'}`); try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claims'); } };
const fh = (tel) => createHash('sha256').update(tel.replace(/\D/g, '').slice(-8) + 'segredo').digest('hex');
const jor = async (uid) => (await como(uid, () => q('select public.paciente_jornada() r')))[0].r;
const hoje = new Date().toISOString().slice(0, 10);

const nova = async (email, nome, tel, conferida) => {
  const id = (await q(`insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
  await q(`insert into public.contas_paciente (id, email, nome, telefone, identidade_conferida_em) values ($1,$2,$3,$4,$5)`, [id, email, nome, tel, conferida ? new Date() : null]);
  return id;
};
const card = async (chave, coluna, exames, conv = null) => {
  const id = (await q(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna, conversa_id) values ($1, $2, 'Centro', $3, $4) returning id`, [chave, hoje, coluna, conv]))[0].id;
  for (const [p, s, c] of exames) await q(`insert into public.jornada_exame (card_id, procedimento, status, confirm_status) values ($1,$2,$3,$4)`, [id, p, s, c]);
};
const ana = await nova('ana@x.com', 'Ana Paula Souza', '(11) 98888-7777', true);
const bia = await nova('bia@x.com', 'Bia Souza', '(11) 98888-7777', true);        // mesmo telefone, outro nome
const eva = await nova('eva@x.com', 'Ana Paula Souza', '(11) 98888-7777', false);  // mesmo nome e telefone, mas não conferida
await q(`insert into public.jornada_paciente values ('1001', 'ANA PAULA SOUZA', $1)`, [fh('11988887777')]);
await q(`insert into public.jornada_paciente values ('2002', 'OUTRA PESSOA', $1)`, [fh('11911112222')]);
await card('1001', 'em_atendimento', [['RM JOELHO', 'atendido', 'Confirmado'], ['RM COLUNA', 'confirmado', 'Confirmado'], ['US ABDOME', 'agendado', 'A Confirmar'], ['TC CRANIO', 'cancelado', 'A Confirmar'], ['RX TORAX', 'faltou', 'Confirmado']]);
await card('2002', 'confirmado', [['RM OMBRO', 'confirmado', 'Confirmado']]);
const conv = (await q(`insert into public.conversas default values returning id`))[0].id;
await q(`update public.conversas set conta_id = $1 where id = $2`, [bia, conv]);
await card('conv:abc', 'orcamento', [['RM QUADRIL', 'pedido', null]], conv);

await caso('anônimo é recusado', async () => { try { await como(null, () => q('select public.paciente_jornada()')); return { ok: false }; } catch (e) { return { ok: /permission|Entre/.test(e.message), detalhe: e.message }; } });
await caso('Ana (conferida, nome e telefone iguais) vê só os exames dela, cada um com o seu passo', async () => {
  const r = await jor(ana); const ex = r.visitas[0].exames; const por = Object.fromEntries(ex.map((e) => [e.nome, e]));
  return { ok: r.visitas.length === 1 && ex.length === 5 && por['RM JOELHO'].ok === 5 && por['RM COLUNA'].ok === 4 && por['RM COLUNA'].em_atendimento === true && por['US ABDOME'].ok === 4
    && por['TC CRANIO'].excecao === 'cancelado' && por['RX TORAX'].excecao === 'faltou' && !JSON.stringify(r).includes('RM OMBRO'), detalhe: JSON.stringify(ex) };
});
await caso('resumo: 4 exames ativos, 1 feito, 3 faltam (cancelado e faltou ficam fora da conta)', async () => {
  const s = (await jor(ana)).resumo; return { ok: s.total === 3 && s.feitos === 1 && s.faltam === 2 && s.laudos === 0, detalhe: JSON.stringify(s) };
});
await caso('nada de horário, valor ou telefone na resposta', async () => {
  const t = JSON.stringify(await jor(ana)); return { ok: !/\d{2}:\d{2}/.test(t) && !/98888|7777|hora/i.test(t), detalhe: t.slice(0, 80) };
});
await caso('Bia (mesmo telefone, outro nome) não vê os exames da Ana; vê só o pedido da própria conversa (passo 1)', async () => {
  const r = await jor(bia); return { ok: r.visitas.length === 1 && r.visitas[0].exames.length === 1 && r.visitas[0].exames[0].ok === 1 && r.visitas[0].exames[0].nome === 'RM QUADRIL', detalhe: JSON.stringify(r.visitas) };
});
await caso('Eva (mesmo nome e telefone, SEM identidade conferida) não vê nada do Klingo', async () => {
  const r = await jor(eva); return { ok: r.visitas.length === 0 && r.conferida === false, detalhe: JSON.stringify(r) };
});
await caso('laudo entregue = passo 6; atendido sem laudo = passo 5', async () => {
  await q(`update public.jornada_card set coluna = 'laudo_entregue' where paciente_chave = '1001'`);
  const a = (await jor(ana)).visitas[0].exames.find((e) => e.nome === 'RM JOELHO').ok; const s = (await jor(ana)).resumo;
  await q(`update public.jornada_card set coluna = 'laudo_pendente' where paciente_chave = '1001'`);
  const b = (await jor(ana)).visitas[0].exames.find((e) => e.nome === 'RM JOELHO').ok;
  return { ok: a === 6 && b === 5 && s.laudos === 1, detalhe: `${a} ${b} ${JSON.stringify(s)}` };
});
await caso('chegou: exames marcados passam para o passo 4 sem "em atendimento"', async () => {
  await q(`update public.jornada_card set coluna = 'chegou' where paciente_chave = '1001'`);
  const e = (await jor(ana)).visitas[0].exames.find((x) => x.nome === 'RM COLUNA'); return { ok: e.ok === 4 && e.em_atendimento === false };
});
const ok = resultados.filter(Boolean).length; console.log(`\n${ok} de ${resultados.length}`); process.exit(ok === resultados.length ? 0 : 1);
