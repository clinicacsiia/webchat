// FLUXOGRAMA: entrada (contas-paciente + protecao-identidade + login-paciente + historico-conta.sql num Postgres embutido com stubs mínimos do Auth) -> validação (só conta de paciente chama; a conversa só entra na conta com o token dela E e-mail ou telefone da conta; nunca toma conversa de outra conta) -> lógica (adotar grava conta_id; listar devolve as conversas da conta, mais nova primeiro, com token) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { REPO, funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const arq = (n) => readFileSync(`${REPO}/supabase/${n}`, 'utf8');
const ARQUIVOS = ['contas-paciente.sql', 'protecao-identidade.sql', 'login-paciente.sql', 'historico-conta.sql'];

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
await db.exec(`alter table public.conversas add column criado_em timestamptz not null default now(), add column ultima_mensagem text, add column status text not null default 'aguardando';
  create table public.conversa_segredo (conversa_id uuid primary key references public.conversas(id) on delete cascade, token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));`);
const como = async (papel, uid, fn) => {
  await db.exec(`set request.jwt.claims = '${uid ? JSON.stringify({ sub: uid }) : ''}'; set role ${papel}`);
  try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claims'); }
};
const q = async (sql, p = []) => (await db.query(sql, p)).rows;

await caso('os quatro arquivos aplicam em ordem e podem ser aplicados de novo', async () => {
  for (let i = 0; i < 2; i++) for (const a of ARQUIVOS) await db.exec(arq(a));
  await db.exec(`update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite'`);
  return { ok: true };
});
const ADM = (await q(`insert into auth.users (email) values ('primeiro@clinica.test') returning id`))[0].id;
await q(`update public.config set valor = 'sim' where chave = 'cadastro_equipe_sem_convite'`);
const EQUIPE = (await q(`insert into auth.users (email) values ('equipe@clinica.test') returning id`))[0].id;
await q(`update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite'`);
const conta = async (email, tel = null) => { const id = (await q(`insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`, [email]))[0].id; if (tel) await q(`update public.contas_paciente set telefone = $2 where id = $1`, [id, tel]); return id; };
const ANA = await conta('ana@exemplo.com', '71988710544'), BIA = await conta('bia@exemplo.com', '71977776666');
// conversa de convidado (sem conta) com e-mail/telefone informados; devolve { id, token }
let n = 0;
const conversa = async ({ email = 'ana@exemplo.com', tel = '71988710544', tipo = 'proprio', filho = null, conta_id = null, minutos = 0 } = {}) => {
  const ct = (await q(`insert into public.contatos (nome, telefone, email) values ('Alguém', $1, $2) returning id`, [tel, email]))[0].id;
  const id = (await q(`insert into public.conversas (contato_id, email_informado, paciente_tipo, paciente_nome, ultima_mensagem, criado_em) values ($1, $2, $3, $4, $5, now() - ($6 || ' minutes')::interval) returning id`, [ct, email, tipo, filho, 'mensagem ' + (++n), String(minutos)]))[0].id;
  if (conta_id) await q(`update public.conversas set conta_id = $2 where id = $1`, [id, conta_id]);
  const token = (await q(`insert into public.conversa_segredo (conversa_id) values ($1) returning token`, [id]))[0].token;
  return { id, token };
};
const adotar = (uid, itens) => como('authenticated', uid, async () => (await q(`select public.conta_paciente_adotar_conversas($1::jsonb) r`, [JSON.stringify(itens)]))[0].r);
const listar = (uid) => como('authenticated', uid, async () => (await q(`select public.conta_paciente_conversas() r`))[0].r);
const dona = async (id) => (await q(`select conta_id from public.conversas where id = $1`, [id]))[0].conta_id;

await caso('adotar: conversa deste aparelho com o token e o e-mail da conta entra na conta; conversa de convidado vira conversa da conta', async () => {
  const c = await conversa({ email: 'ANA@exemplo.com', tel: '71900000000' });
  const r = await adotar(ANA, [{ id: c.id, token: c.token }]);
  return { ok: r === 1 && (await dona(c.id)) === ANA, detalhe: `adotadas=${r}` };
});
await caso('adotar: telefone da conta (com 9º dígito/DDI) também vale quando o e-mail é outro', async () => {
  const c = await conversa({ email: 'outro@exemplo.com', tel: '5571988710544' });
  return { ok: (await adotar(ANA, [{ id: c.id, token: c.token }])) === 1 && (await dona(c.id)) === ANA };
});
await caso('adotar: NÃO entra sem o token certo, com token de outra conversa ou sem token', async () => {
  const a = await conversa(), b = await conversa();
  const r = await adotar(ANA, [{ id: a.id, token: 'errado' }, { id: a.id, token: b.token }, { id: a.id }]);
  return { ok: r === 0 && (await dona(a.id)) === null, detalhe: `adotadas=${r}` };
});
await caso('adotar: NÃO entra conversa de outra pessoa (e-mail e telefone diferentes), mesmo com o token — aparelho compartilhado', async () => {
  const c = await conversa({ email: 'outra.pessoa@exemplo.com', tel: '71911112222' });
  const r = await adotar(ANA, [{ id: c.id, token: c.token }]);
  return { ok: r === 0 && (await dona(c.id)) === null, detalhe: `adotadas=${r}` };
});
await caso('adotar: NÃO toma conversa que já tem dona e não adota duas vezes', async () => {
  const c = await conversa({ email: 'bia@exemplo.com', tel: '71977776666' });
  const r1 = await adotar(BIA, [{ id: c.id, token: c.token }]), r2 = await adotar(BIA, [{ id: c.id, token: c.token }]), r3 = await adotar(ANA, [{ id: c.id, token: c.token }]);
  return { ok: r1 === 1 && r2 === 0 && r3 === 0 && (await dona(c.id)) === BIA, detalhe: `${r1},${r2},${r3}` };
});
await caso('adotar: entrada inválida (não é lista, id que não é uuid, vazio) não derruba nada', async () => {
  const a = await como('authenticated', ANA, async () => (await q(`select public.conta_paciente_adotar_conversas('{"x":1}'::jsonb) r`))[0].r);
  const b = await adotar(ANA, [{ id: 'nao-e-uuid', token: 'x' }, {}, null]);
  const c = await como('authenticated', ANA, async () => (await q(`select public.conta_paciente_adotar_conversas(null) r`))[0].r);
  return { ok: a === 0 && b === 0 && c === 0 };
});
await caso('listar: devolve só as conversas DA conta, mais nova primeiro, com token, tipo, nome da criança e última mensagem', async () => {
  const velha = await conversa({ conta_id: BIA, minutos: 600 }), nova = await conversa({ conta_id: BIA, minutos: -5, tipo: 'filho', filho: 'Pedro' });
  await conversa({ conta_id: ANA, minutos: 1 });
  const l = await listar(BIA);
  return { ok: l.length >= 2 && l[0].id === nova.id && l[0].token === nova.token && l[0].tipo === 'filho' && l[0].nomeCrianca === 'Pedro' && /mensagem/.test(l[0].ultima) && typeof l[0].criado_em === 'number' && l.some((x) => x.id === velha.id) && l.every((x) => x.id !== undefined) && !l.some((x) => x.tipo === 'proprio' && x.nomeCrianca), detalhe: `${l.length} conversas` };
});
await caso('listar: a conta da Ana não enxerga as conversas da Bia (e vice-versa)', async () => {
  const la = await listar(ANA), lb = await listar(BIA);
  const ids = new Set(la.map((x) => x.id));
  return { ok: lb.every((x) => !ids.has(x.id)) && la.length > 0 && lb.length > 0 };
});
await caso('depois de adotar, a conversa aparece na lista da conta (outro aparelho enxerga)', async () => {
  const c = await conversa({ email: 'bia@exemplo.com', tel: '71900000000' });
  await adotar(BIA, [{ id: c.id, token: c.token }]);
  return { ok: (await listar(BIA)).some((x) => x.id === c.id && x.token === c.token) };
});
await caso('anônimo não chama; equipe (não é conta de paciente) não adota e recebe lista vazia', async () => {
  const f = [];
  await como('anon', null, async () => { for (const s of [`select public.conta_paciente_conversas()`, `select public.conta_paciente_adotar_conversas('[]'::jsonb)`]) { try { await q(s); f.push('anon'); } catch { /* esperado */ } } });
  const lista = await como('authenticated', EQUIPE, async () => (await q(`select public.conta_paciente_conversas() r`))[0].r);
  let adotou = 'executou'; await como('authenticated', EQUIPE, async () => { try { await q(`select public.conta_paciente_adotar_conversas('[]'::jsonb)`); } catch { adotou = 'recusado'; } });
  return { ok: f.length === 0 && lista.length === 0 && adotou === 'recusado', detalhe: `${f.join(',') || 'anon recusado'}; equipe=${lista.length}, ${adotou}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} casos passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
