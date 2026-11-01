// FLUXOGRAMA: entrada (fila de chegada com pessoas que bipararam o QR code; pacientes, conversas, exames em aberto e cartões do Klingo simulados) -> validação (só a equipe identifica; nome tem de bater junto com telefone ou e-mail) -> lógica (novo / cadastrado / talvez, conversas da pessoa, exame em aberto com "pendente", exames do Klingo de hoje) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { criarBanco, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, d = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, 'exceção: ' + e.message.split('\n')[0]); } };
const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
await db.exec(`
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create table public.contas_paciente (id uuid primary key references auth.users(id) on delete cascade, email text, paciente_id uuid references public.pacientes(id), nome text, telefone text);
  create table public.contatos (id uuid primary key default gen_random_uuid(), nome text, telefone text, email text);
  alter table public.conversas add column contato_id uuid, add column status text default 'aguardando', add column atualizado_em timestamptz default now(), add column nome_informado text;
  create function public.pessoa_ficha(p uuid) returns jsonb language sql stable as $$ select jsonb_build_object('nome', (select nome_informado from public.conversas where id = p)) $$;
  create table public.agendamento_aberto_stub (conversa_id uuid, quando timestamptz, exames text, passou boolean);
  create view public.v_agendamento_aberto as select * from public.agendamento_aberto_stub;
  create table public.jornada_paciente (prontuario text primary key, nome text, fone_chave text);
  create table public.jornada_card (id bigint generated always as identity primary key, paciente_chave text, data_ref date, coluna text, arquivado_em timestamptz, conversa_id uuid);
  create table public.jornada_exame (id bigint generated always as identity primary key, card_id bigint, procedimento text, status text);
  grant select, insert, update, delete on all tables in schema public to authenticated;
  insert into public.config values ('ia_segredo', 'segredo');
`);
await db.exec(readFileSync(`${REPO}/supabase/fila-chegada.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/checkin-sem-login.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/automacao-sistema.sql`, 'utf8'));
const q = async (s, p = []) => (await db.query(s, p)).rows;
const como = async (uid, fn) => { await db.exec(`set request.jwt.claims = '${uid ? JSON.stringify({ sub: uid }) : ''}'; set role ${uid ? 'authenticated' : 'anon'}`); try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claims'); } };
const staff = (await q(`insert into auth.users (email) values ('eq@x.com') returning id`))[0].id;
await q(`insert into public.agentes (id, papel, ativo) values ($1, 'atendente', true)`, [staff]);
const fh = (tel) => createHash('sha256').update(tel.replace(/\D/g, '').slice(-8) + 'segredo').digest('hex');
const fila = async (nome, email, tel) => (await como(staff, () => q(`select public.fila_registrar_completo($1,$2,$3,false) r`, [nome, email, tel])))[0].r.id;
const ident = async () => { const r = (await como(staff, () => q('select public.fila_identificar_todos() r')))[0].r; return Object.fromEntries(r.map((x) => [x.id, x])); };

// pessoas no sistema
await q(`insert into public.pacientes (nome, nome_norm, telefones, email) values ('Maria da Silva Santos', 'MARIA DA SILVA SANTOS', array['1188887777'], 'maria@x.com')`);
const contato = (await q(`insert into public.contatos (nome, telefone) values ('Maria', '11988887777') returning id`))[0].id;
const conv = (await q(`insert into public.conversas (contato_id, nome_informado, status) values ($1, 'Maria da Silva Santos', 'aguardando') returning id`, [contato]))[0].id;
await q(`insert into public.agendamento_aberto_stub values ($1, now() - interval '3 hours', 'RM JOELHO', true)`, [conv]);
const card = (await q(`insert into public.jornada_card (paciente_chave, data_ref, coluna) values ('9001', public.fila_dia(now()), 'confirmado') returning id`))[0].id;
await q(`insert into public.jornada_paciente values ('9001', 'MARIA DA SILVA SANTOS', $1)`, [fh('11988887777')]);
await q(`insert into public.jornada_exame (card_id, procedimento, status) values ($1, 'RM JOELHO', 'agendado'), ($1, 'US ABDOME', 'confirmado')`, [card]);

const maria = await fila('Maria Silva Santos', 'maria@x.com', '(11) 98888-7777');
const familia = await fila('Joao Pereira', 'outro@x.com', '(11) 98888-7777');   // mesmo telefone, outra pessoa
const novo = await fila('Carlos Novo Teste', 'carlos@x.com', '(21) 97777-6666');
const semDados = await fila('Pessoa Sem Dados', '', '');

await caso('só a equipe identifica', async () => { try { await como(null, () => q('select public.fila_identificar_todos()')); return { ok: false }; } catch (e) { return { ok: /permission|equipe/.test(e.message), detalhe: e.message }; } });
await caso('paciente já cadastrado (telefone + nome batem): "cadastrado", com o nome do cadastro', async () => {
  const r = (await ident())[maria]; return { ok: r.situacao === 'cadastrado' && r.paciente_nome === 'Maria da Silva Santos', detalhe: JSON.stringify(r).slice(0, 120) };
});
await caso('mesmo telefone, nome diferente (família): "talvez", nunca "cadastrado"', async () => { const r = (await ident())[familia]; return { ok: r.situacao === 'talvez' }; });
await caso('nada bate: "novo"; sem telefone e sem e-mail também é "novo"', async () => { const m = await ident(); return { ok: m[novo].situacao === 'novo' && m[semDados].situacao === 'novo' && m[novo].conversas.length === 0 }; });
await caso('acha a conversa da pessoa e o exame EM ABERTO, avisando que está pendente (horário já passou)', async () => {
  const r = (await ident())[maria];
  return { ok: r.conversas.length === 1 && r.conversas[0].id === conv && r.abertos.length === 1 && r.abertos[0].pendente === true && r.abertos[0].exames === 'RM JOELHO', detalhe: JSON.stringify([r.conversas, r.abertos]) };
});
await caso('a família não herda a conversa nem o exame de outra pessoa', async () => { const r = (await ident())[familia]; return { ok: r.conversas.length === 0 && r.abertos.length === 0 && r.klingo.length === 0 }; });
await caso('mostra os exames de hoje no Klingo (nome + status), só para quem bate nome e telefone', async () => {
  const r = (await ident())[maria]; return { ok: r.klingo.length === 2 && r.klingo[0].status === 'agendado', detalhe: JSON.stringify(r.klingo) };
});
await caso('quem já saiu da fila (atendido) deixa de ser identificado', async () => {
  await q(`update public.fila_chegada set status = 'atendido' where id = $1`, [novo]); const m = await ident(); return { ok: !m[novo] && !!m[maria] };
});
const ok = resultados.filter(Boolean).length; console.log(`\n${ok} de ${resultados.length}`); process.exit(ok === resultados.length ? 0 : 1);
