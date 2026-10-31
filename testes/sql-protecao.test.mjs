// FLUXOGRAMA: entrada (supabase/protecao-identidade.sql sobre as funções reais de pacientes.sql, num Postgres embutido com tabelas mínimas) -> validação (aplica o arquivo duas vezes; chave config.reaproveitar_cadastro_convidado ausente, 'nao' e 'sim') -> lógica (convidado nunca é reconhecido mesmo acertando nome, telefone, e-mail e data; com a chave 'sim' vale a regra anterior: nome E telefone (e e-mail, se o cadastro tem) + data; cadastro em revisão é ignorado; validado desempata) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { REPO, funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const sql = readFileSync(`${REPO}/supabase/protecao-identidade.sql`, 'utf8');

const db = new PGlite();
await db.exec(`
  create schema extensions;
  create function extensions.unaccent(t text) returns text language sql immutable as $$
    select translate(t, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC') $$;
  create table public.config (chave text primary key, valor text not null default '');
  create table public.contatos (id uuid primary key default gen_random_uuid(), nome text, telefone text, email text);
  create table public.conversas (id uuid primary key default gen_random_uuid(), contato_id uuid references public.contatos(id),
    nome_informado text, email_informado text, paciente_tipo text default 'proprio', paciente_nome text);
  create table public.pre_agendamentos (conversa_id uuid primary key references public.conversas(id), paciente jsonb default '{}'::jsonb);
  create table public.pacientes (
    id uuid primary key default gen_random_uuid(), nome text not null, nome_norm text not null default '',
    telefones text[] not null default '{}', email text, dt_nasc date, cpf text,
    dados jsonb not null default '{}'::jsonb, validado boolean not null default false,
    revisar boolean not null default false, origem_conversa uuid,
    criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(), ultima_visita_em timestamptz not null default now());
  ${['norm_nome', 'fone_chave', 'data_ou_nula', 'nome_confere'].map((n) => funcao('pacientes.sql', n)).join('\n')}
`);

// uma conversa nova de alguém que digita nome, telefone, e-mail e uma data de nascimento
const conversa = async ({ nome = 'Maria da Silva', tel = '71988710544', email = 'maria@exemplo.com', dt = '1980-03-25' } = {}) => {
  const ct = (await db.query(`insert into public.contatos (nome, telefone, email) values ($1, $2, $3) returning id`, [nome, tel, email])).rows[0].id;
  const cv = (await db.query(`insert into public.conversas (contato_id, nome_informado, email_informado) values ($1, $2, $3) returning id`, [ct, nome, email])).rows[0].id;
  await db.query(`insert into public.pre_agendamentos (conversa_id, paciente) values ($1, $2::jsonb)`, [cv, JSON.stringify(dt ? { dt_nasc: dt } : {})]);
  return cv;
};
const conferir = async (cv) => (await db.query(`select public.paciente_conferir($1) r`, [cv])).rows[0].r;
const novoPaciente = async (o = {}) => (await db.query(`insert into public.pacientes (nome, telefones, email, dt_nasc, validado, revisar, atualizado_em) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
  [o.nome ?? 'Maria da Silva', o.telefones ?? ['7188710544'], o.email ?? 'maria@exemplo.com', o.dt ?? '1980-03-25', o.validado ?? false, o.revisar ?? false, o.em ?? new Date().toISOString()])).rows[0].id;

await novoPaciente({ validado: true });

await caso('o arquivo aplica sem erro e pode ser aplicado de novo; a chave nasce fechada', async () => {
  // a função original ainda não existe neste banco: o arquivo a cria (create or replace)
  await db.exec(sql); await db.exec(sql);
  const v = (await db.query(`select valor from public.config where chave = 'reaproveitar_cadastro_convidado'`)).rows[0]?.valor;
  return { ok: v === 'nao', detalhe: `chave = ${v}` };
});

await caso('FECHADO: convidado que acerta nome, telefone, e-mail E data de nascimento continua "novo" (sem paciente_id, sem conferência)', async () => {
  const r = await conferir(await conversa());
  return { ok: r.situacao === 'novo' && !r.paciente_id && r.dt_nasc_conferida === undefined, detalhe: JSON.stringify(r) };
});
await caso('FECHADO: chave ausente também fecha (falha fechada)', async () => {
  await db.exec(`delete from public.config where chave = 'reaproveitar_cadastro_convidado'`);
  const r = await conferir(await conversa());
  await db.exec(`insert into public.config values ('reaproveitar_cadastro_convidado', 'nao')`);
  return { ok: r.situacao === 'novo' && !r.paciente_id };
});
await caso('FECHADO: qualquer valor diferente de "sim" fecha ("SIM", "true", vazio)', async () => {
  const lidos = [];
  for (const v of ['SIM', 'true', '', ' sim']) {
    await db.query(`update public.config set valor = $1 where chave = 'reaproveitar_cadastro_convidado'`, [v]);
    const r = await conferir(await conversa()); if (r.paciente_id) lidos.push(JSON.stringify(v));
  }
  await db.exec(`update public.config set valor = 'nao' where chave = 'reaproveitar_cadastro_convidado'`);
  return { ok: lidos.length === 0, detalhe: lidos.length ? 'abriu com ' + lidos.join(', ') : '4 valores recusados' };
});

// ---- chave aberta: regra anterior preservada ----
await db.exec(`update public.config set valor = 'sim' where chave = 'reaproveitar_cadastro_convidado'`);

await caso('ABERTO: nome + telefone + e-mail + data certa = completo e data conferida', async () => {
  const r = await conferir(await conversa());
  return { ok: r.situacao === 'completo' && r.dt_nasc_conferida === true && !!r.paciente_id, detalhe: JSON.stringify(r.batem) };
});
await caso('ABERTO: data errada = completo, mas data NÃO conferida (false); sem data = null (nunca libera)', async () => {
  const errada = await conferir(await conversa({ dt: '1981-03-25' })), sem = await conferir(await conversa({ dt: null }));
  return { ok: errada.dt_nasc_conferida === false && sem.dt_nasc_conferida === null, detalhe: `errada=${errada.dt_nasc_conferida}, sem=${sem.dt_nasc_conferida}` };
});
await caso('ABERTO: só telefone igual (nome ou e-mail diferentes) = novo; nome e telefone certos com e-mail errado = novo', async () => {
  const a = await conferir(await conversa({ nome: 'Joana Pereira' })), b = await conferir(await conversa({ email: 'outro@exemplo.com' }));
  return { ok: a.situacao === 'novo' && b.situacao === 'novo', detalhe: `outro nome=${a.situacao}, outro e-mail=${b.situacao}` };
});
await caso('ABERTO: telefone com e sem o 9º dígito é o mesmo telefone', async () => {
  const r = await conferir(await conversa({ tel: '7188710544' }));
  return { ok: r.situacao === 'completo' };
});

// ---- cadastro duplicado / em revisão ----
await caso('cadastro em REVISÃO é ignorado, mesmo sendo o mais novo e o único que bate (não vira base de ninguém)', async () => {
  await db.exec(`delete from public.pacientes`);
  await novoPaciente({ revisar: true, nome: 'Maria da Silva' });
  const r = await conferir(await conversa());
  return { ok: r.situacao === 'novo' && !r.paciente_id, detalhe: JSON.stringify(r) };
});
await caso('desempate: cadastro VALIDADO vence um duplicado mais recente que ainda não foi validado', async () => {
  await db.exec(`delete from public.pacientes`);
  const velho = await novoPaciente({ validado: true, em: '2026-01-01T00:00:00Z', dt: '1980-03-25' });
  await novoPaciente({ validado: false, em: '2026-10-30T00:00:00Z', dt: '1999-09-09' });   // duplicado digitado por outra pessoa
  const r = await conferir(await conversa());
  return { ok: r.paciente_id === velho && r.dt_nasc_conferida === true, detalhe: `escolheu o validado: ${r.paciente_id === velho}` };
});
await caso('sem validado em nenhum dos dois, o mais recente continua desempatando (comportamento anterior)', async () => {
  await db.exec(`delete from public.pacientes`);
  await novoPaciente({ em: '2026-01-01T00:00:00Z', dt: '1980-03-25' });
  const novo = await novoPaciente({ em: '2026-10-30T00:00:00Z', dt: '1999-09-09' });
  const r = await conferir(await conversa());
  return { ok: r.paciente_id === novo };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} casos passaram.`);
process.exit(falhas ? 1 : 0);
