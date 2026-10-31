// FLUXOGRAMA: entrada (contas-paciente + protecao-identidade + login-paciente + vincular-cadastro.sql num Postgres embutido com stubs mínimos do Auth) -> validação (aplica duas vezes; só conta de paciente logada chama; e-mail precisa estar confirmado; limite de 5 tentativas por hora) -> lógica (liga a conta ao cadastro SÓ quando e-mail confirmado, telefone, nome e data de nascimento batem juntos com UM cadastro livre e fora de revisão; qualquer divergência não liga) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { REPO, funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const arq = (n) => readFileSync(`${REPO}/supabase/${n}`, 'utf8');
const ARQUIVOS = ['contas-paciente.sql', 'protecao-identidade.sql', 'login-paciente.sql', 'vincular-cadastro.sql'];

async function banco() {
  const db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
    create schema extensions;
    create function extensions.unaccent(t text) returns text language sql immutable as $$
      select translate(t, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC') $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    create table public.agentes (id uuid primary key references auth.users(id) on delete cascade, nome text not null, email text,
      papel text not null default 'atendente' check (papel in ('admin','atendente','marketing')), ativo boolean not null default false, criado_em timestamptz not null default now());
    create table public.config (chave text primary key, valor text not null default '');
    create table public.contatos (id uuid primary key default gen_random_uuid(), nome text, telefone text, email text);
    create table public.conversas (id uuid primary key default gen_random_uuid(), contato_id uuid references public.contatos(id),
      nome_informado text, email_informado text, paciente_tipo text not null default 'proprio', paciente_nome text);
    create table public.pacientes (
      id uuid primary key default gen_random_uuid(), nome text not null, nome_norm text not null default '',
      telefones text[] not null default '{}', email text, dt_nasc date, cpf text, dados jsonb not null default '{}'::jsonb,
      validado boolean not null default false, revisar boolean not null default false, origem_conversa uuid references public.conversas(id) on delete set null,
      criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(), ultima_visita_em timestamptz not null default now());
    create table public.pre_agendamentos (conversa_id uuid primary key references public.conversas(id) on delete cascade, paciente jsonb default '{}'::jsonb,
      paciente_id uuid references public.pacientes(id) on delete set null);
    ${funcao('00-base-snapshot.sql', 'papel_atual')}
    ${funcao('00-base-snapshot.sql', 'novo_usuario')}
    create trigger on_auth_user_created after insert on auth.users for each row execute function public.novo_usuario();
    ${['norm_nome', 'fone_chave', 'data_ou_nula', 'nome_confere'].map((n) => funcao('pacientes.sql', n)).join('\n')}
  `);
  return db;
}

const db = await banco();
const como = async (papel, uid, fn) => {
  await db.exec(`set request.jwt.claims = '${uid ? JSON.stringify({ sub: uid }) : ''}'; set role ${papel}`);
  try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claims'); }
};
const q = async (sql, p = []) => (await db.query(sql, p)).rows;

await caso('os quatro arquivos aplicam em ordem e podem ser aplicados de novo', async () => {
  for (let i = 0; i < 2; i++) for (const a of ARQUIVOS) await db.exec(arq(a));
  await db.exec(`update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite'`);
  return { ok: true, detalhe: '4 arquivos x 2 aplicações' };
});

const ADM = (await q(`insert into auth.users (email) values ('primeiro@clinica.test') returning id`))[0].id;   // primeiro usuário: administrador
await q(`update public.config set valor = 'sim' where chave = 'cadastro_equipe_sem_convite'`);
const EQUIPE = (await q(`insert into auth.users (email) values ('equipe@clinica.test') returning id`))[0].id;   // vira agente (inativo) pelo caminho de transição
await q(`update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite'`);

let n = 0;
// conta de paciente como o chat cria: e-mail confirmado ou não, com os dados digitados no cadastro em user_metadata
const conta = async ({ email, nome = 'Maria da Silva', tel = '71988710544', nasc = '1980-03-25', confirmado = true } = {}) => {
  email = email ?? `maria${++n}@exemplo.com`;
  const meta = JSON.stringify({ nome, telefone: tel, ...(nasc ? { dt_nasc: nasc } : {}) });
  const id = (await q(`insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, ${confirmado ? 'now()' : 'null'}, $2::jsonb) returning id`, [email, meta]))[0].id;
  return { id, email };
};
const paciente = async ({ nome = 'Maria da Silva', tels = ['7188710544'], email = null, nasc = '1980-03-25', revisar = false } = {}) =>
  (await q(`insert into public.pacientes (nome, telefones, email, dt_nasc, revisar) values ($1, $2, $3, $4, $5) returning id`, [nome, tels, email, nasc, revisar]))[0].id;
const vincular = (uid) => como('authenticated', uid, async () => (await q(`select public.conta_paciente_vincular() r`))[0].r.resultado);
const ligado = async (uid) => (await q(`select paciente_id from public.contas_paciente where id = $1`, [uid]))[0].paciente_id;
const nascNoLogin = async (uid) => (await q(`select raw_user_meta_data ->> 'dt_nasc' v from auth.users where id = $1`, [uid]))[0].v;

await caso('liga a conta ao cadastro quando e-mail confirmado, telefone, nome e nascimento batem; apaga a data digitada', async () => {
  const c = await conta(), p = await paciente({ email: c.email });
  const r = await vincular(c.id), lin = (await q(`select vinculado_em, vinculo_metodo from public.contas_paciente where id = $1`, [c.id]))[0];
  return { ok: r === 'vinculado' && (await ligado(c.id)) === p && !!lin.vinculado_em && /nascimento/.test(lin.vinculo_metodo) && (await nascNoLogin(c.id)) === null, detalhe: r };
});
await caso('aceita variações reais: telefone com 9º dígito e 55, nome mais curto, e-mail em outra caixa', async () => {
  const c = await conta({ email: 'Joana.Lima@Exemplo.com', nome: 'Joana Lima', tel: '5571988710544' }), p = await paciente({ nome: 'Joana Souza de Lima', email: 'joana.lima@exemplo.com', tels: ['7188710544'] });
  return { ok: (await vincular(c.id)) === 'vinculado' && (await ligado(c.id)) === p };
});
await caso('depois de ligada, a conversa da conta é reconhecida como paciente conhecido (paciente_conferir)', async () => {
  const c = await conta(), p = await paciente({ email: c.email });
  await vincular(c.id);
  const cv = await como('authenticated', c.id, async () => {
    const ct = (await q(`insert into public.contatos (nome, telefone, email) values ('Maria', '71988710544', $1) returning id`, [c.email]))[0].id;
    return (await q(`insert into public.conversas (contato_id, paciente_tipo) values ($1, 'proprio') returning id`, [ct]))[0].id;
  });
  const r = (await q(`select public.paciente_conferir($1) r`, [cv]))[0].r;
  return { ok: r.situacao === 'completo' && r.conta === true && r.paciente_id === p, detalhe: JSON.stringify(r.batem) };
});

await caso('NÃO liga: e-mail ainda não confirmado (e a data digitada é mantida para quando confirmar)', async () => {
  const c = await conta({ confirmado: false }), p = await paciente({ email: c.email });
  const r1 = await vincular(c.id), guardada = await nascNoLogin(c.id);
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [c.id]);
  const r2 = await vincular(c.id);
  return { ok: r1 === 'email_nao_confirmado' && guardada === '1980-03-25' && r2 === 'vinculado' && (await ligado(c.id)) === p, detalhe: `${r1} -> ${r2}` };
});
const naoLiga = async (nome, conta_, cad) => caso(nome, async () => {
  const c = await conta(conta_), p = await paciente({ email: c.email, ...cad });
  const r = await vincular(c.id);
  return { ok: r === 'nao_encontrado' && (await ligado(c.id)) === null && (await nascNoLogin(c.id)) === null, detalhe: r };
});
await naoLiga('NÃO liga: data de nascimento diferente', { nasc: '1980-03-26' }, {});
await naoLiga('NÃO liga: telefone diferente', { tel: '71977776666' }, {});
await naoLiga('NÃO liga: nome diferente', { nome: 'Carla Pereira' }, {});
await naoLiga('NÃO liga: cadastro marcado para revisão', {}, { revisar: true });
await naoLiga('NÃO liga: cadastro sem data de nascimento', {}, { nasc: null });
await caso('NÃO liga: e-mail da conta diferente do e-mail do cadastro, ou cadastro sem e-mail', async () => {
  const c1 = await conta(), c2 = await conta();
  await paciente({ email: 'outra.pessoa@exemplo.com' }); await paciente({ email: null });
  const r1 = await vincular(c1.id), r2 = await vincular(c2.id);
  return { ok: r1 === 'nao_encontrado' && r2 === 'nao_encontrado' && (await ligado(c1.id)) === null && (await ligado(c2.id)) === null, detalhe: `${r1}, ${r2}` };
});
await caso('NÃO liga: cadastro já ligado a outra conta (a segunda conta não toma o cadastro)', async () => {
  const dono = await conta(), p = await paciente({ email: dono.email });
  await vincular(dono.id);
  const intruso = await conta({ email: dono.email.toUpperCase() + '.x' });   // outro e-mail confirmado qualquer
  await q(`update public.pacientes set email = $1 where id = $2`, [intruso.email, p]);   // mesmo se o e-mail do cadastro fosse trocado, o cadastro já tem dono
  const r = await vincular(intruso.id);
  return { ok: r === 'nao_encontrado' && (await ligado(intruso.id)) === null && (await ligado(dono.id)) === p, detalhe: r };
});
await caso('NÃO liga: dois cadastros iguais (ambíguo) — a equipe decide', async () => {
  const c = await conta(); await paciente({ email: c.email }); await paciente({ email: c.email });
  const r = await vincular(c.id);
  return { ok: r === 'nao_encontrado' && (await ligado(c.id)) === null, detalhe: r };
});
await caso('NÃO revela nem muda nada do cadastro: a resposta traz só o resultado', async () => {
  const c = await conta(), p = await paciente({ email: c.email, nome: 'Maria da Silva' });
  const r = await como('authenticated', c.id, async () => (await q(`select public.conta_paciente_vincular() r`))[0].r);
  const dep = (await q(`select nome, email, dt_nasc::text from public.pacientes where id = $1`, [p]))[0];
  return { ok: JSON.stringify(Object.keys(r)) === '["resultado"]' && dep.nome === 'Maria da Silva' && dep.dt_nasc === '1980-03-25', detalhe: JSON.stringify(r) };
});

await caso('sem data pendente: "nada_pendente"; já ligada: "ja_vinculado" e nada muda', async () => {
  const c = await conta({ nasc: null }), a = await vincular(c.id);
  const d = await conta(), p = await paciente({ email: d.email }); await vincular(d.id);
  await q(`update auth.users set raw_user_meta_data = raw_user_meta_data || '{"dt_nasc":"1990-01-01"}'::jsonb where id = $1`, [d.id]);
  const b = await vincular(d.id);
  return { ok: a === 'nada_pendente' && b === 'ja_vinculado' && (await ligado(d.id)) === p, detalhe: `${a}, ${b}` };
});
await caso('limite: depois de 5 tentativas na hora a 6ª é "bloqueado" (não dá para adivinhar a data)', async () => {
  const c = await conta({ nasc: '1999-01-01' }); await paciente({ email: c.email });
  const rs = [];
  for (let i = 0; i < 6; i++) {
    await q(`update auth.users set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('dt_nasc', $2::text) where id = $1`, [c.id, `1980-03-${String(20 + i).padStart(2, '0')}`]);
    rs.push(await vincular(c.id));
  }
  return { ok: rs.slice(0, 5).every((x) => x === 'nao_encontrado') && rs[5] === 'bloqueado' && (await ligado(c.id)) === null, detalhe: rs.join(',') };
});
await caso('limite: passada 1 hora volta a permitir', async () => {
  const c = await conta({ nasc: '1980-03-25' }); const p = await paciente({ email: c.email });
  await q(`update public.contas_paciente set vinculo_tentativas = 5, vinculo_ultima_em = now() - interval '2 hours' where id = $1`, [c.id]);
  return { ok: (await vincular(c.id)) === 'vinculado' && (await ligado(c.id)) === p };
});

await caso('equipe e anônimo não conseguem chamar (só conta de paciente)', async () => {
  const falhas = [];
  for (const [papel, uid] of [['authenticated', EQUIPE], ['authenticated', ADM], ['anon', null]]) await como(papel, uid, async () => { try { await q(`select public.conta_paciente_vincular()`); falhas.push(papel); } catch { /* esperado */ } });
  return { ok: falhas.length === 0, detalhe: falhas.join(', ') || '3 recusas' };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} casos passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
