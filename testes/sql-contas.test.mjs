// FLUXOGRAMA: entrada (supabase/contas-paciente.sql aplicado sobre o gatilho ORIGINAL do 00-base-snapshot.sql, num Postgres embutido com stubs mínimos do Auth) -> validação (aplica o arquivo duas vezes; cadastros simulados em auth.users) -> lógica (primeiro usuário vira administrador; convite de uso único cria agente inativo; sem convite e chave de transição 'nao' vira conta de paciente; chave 'sim' mantém o comportamento antigo; só administrador convida; paciente só lê a própria conta; anon não lê nada) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

import { readFileSync } from 'node:fs';
import { REPO } from './stubs-supabase.mjs';
const sql = readFileSync(`${REPO}/supabase/contas-paciente.sql`, 'utf8');

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
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table public.agentes (
    id uuid primary key references auth.users(id) on delete cascade,
    nome text not null, email text,
    papel text not null default 'atendente' check (papel in ('admin','atendente','marketing')),
    ativo boolean not null default false, criado_em timestamptz not null default now());
  create table public.config (chave text primary key, valor text not null default '');
  create table public.pacientes (id uuid primary key default gen_random_uuid(), nome text);
  ${funcao('00-base-snapshot.sql', 'papel_atual')}
  ${funcao('00-base-snapshot.sql', 'novo_usuario')}
  create trigger on_auth_user_created after insert on auth.users for each row execute function public.novo_usuario();
`);

const como = async (papel, uid, fn) => {
  await db.exec(`set request.jwt.claims = '${uid ? JSON.stringify({ sub: uid }) : ''}'; set role ${papel}`);
  try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claims'); }
};
const cadastrar = async (email, meta = {}) => (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(meta)])).rows[0].id;
const agente = async (id) => (await db.query(`select papel, ativo, nome from public.agentes where id = $1`, [id])).rows[0];
const conta = async (id) => (await db.query(`select email, paciente_id from public.contas_paciente where id = $1`, [id])).rows[0];

// ---- upgrade: banco já tem o gatilho antigo e um administrador ----
const ADM = await cadastrar('adm@clinica.test', { nome: 'Adm' });
await caso('antes da migração: o primeiro usuário vira administrador ativo (gatilho original)', async () => {
  const a = await agente(ADM); return { ok: a?.papel === 'admin' && a.ativo === true };
});
const ANTIGO = await cadastrar('antigo@clinica.test');
await caso('antes da migração: o segundo usuário vira atendente INATIVO (comportamento antigo)', async () => {
  const a = await agente(ANTIGO); return { ok: a?.papel === 'atendente' && a.ativo === false };
});

await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => {
  await db.exec(sql); await db.exec(sql);
  const v = (await db.query(`select valor from public.config where chave = 'cadastro_equipe_sem_convite'`)).rows[0]?.valor;
  return { ok: v === 'sim', detalhe: `chave de transição = ${v}` };
});

// ---- transição (chave = 'sim'): nada muda para quem usa o painel antigo ----
await caso('transição: cadastro sem convite continua gerando agente inativo (painel antigo segue funcionando)', async () => {
  const id = await cadastrar('painel-antigo@clinica.test', { nome: 'Fulana' });
  const a = await agente(id), c = await conta(id);
  return { ok: a?.papel === 'atendente' && a.ativo === false && a.nome === 'Fulana' && !c };
});

// ---- chave = 'nao': modo seguro ----
await db.exec(`update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite'`);

await caso('seguro: cadastro de paciente NÃO cria linha em agentes e cria conta_paciente', async () => {
  const id = await cadastrar('Paciente@Exemplo.com');
  const a = await agente(id), c = await conta(id);
  return { ok: !a && c?.email === 'Paciente@Exemplo.com' && c.paciente_id === null, detalhe: 'sem vínculo automático com pacientes' };
});
await caso('seguro: cadastro sem e-mail (ex.: telefone) também vira conta de paciente, nunca equipe', async () => {
  const id = (await db.query(`insert into auth.users (email) values (null) returning id`)).rows[0].id;
  return { ok: !(await agente(id)) && !!(await conta(id)) };
});
await caso('seguro: nome vindo do cadastro NÃO dá acesso (raw_user_meta_data é editável pelo usuário)', async () => {
  const id = await cadastrar('malicioso@exemplo.com', { nome: 'Administrador', papel: 'admin', ativo: true });
  return { ok: !(await agente(id)) && !!(await conta(id)) };
});

await caso('só administrador convida; atendente, paciente e anon são recusados', async () => {
  const at = await cadastrar('x@x.test'); // conta de paciente
  await db.query(`insert into public.agentes (id, nome, email, papel, ativo) select id, 'Atendente', email, 'atendente', true from auth.users where id = $1 on conflict (id) do update set ativo = true, papel = 'atendente'`, [at]);
  const falhas = [];
  for (const [papel, uid] of [['authenticated', at], ['authenticated', null], ['anon', null]]) {
    await como(papel, uid, async () => { try { await db.query(`select public.equipe_convidar('novo@clinica.test')`); falhas.push(`${papel}:${uid ? 'atendente' : 'sem login'} PASSOU`); } catch { /* esperado */ } });
  }
  return { ok: falhas.length === 0, detalhe: falhas.join('; ') || '3 recusas' };
});

await caso('convite do administrador: o cadastro vira agente INATIVO com o papel do convite e o convite é de uso único', async () => {
  const r = await como('authenticated', ADM, async () => (await db.query(`select public.equipe_convidar('  Nova.Pessoa@Clinica.test ', 'marketing') r`)).rows[0].r);
  const id = await cadastrar('nova.pessoa@clinica.test', { nome: 'Nova Pessoa' });
  const a = await agente(id);
  const usado = (await db.query(`select usado_em is not null u from public.equipe_convites where email = 'nova.pessoa@clinica.test'`)).rows[0]?.u;
  const outro = await cadastrar('nova.pessoa+2@clinica.test');
  const id2 = (await db.query(`insert into auth.users (email) values ('nova.pessoa@clinica.test') returning id`)).rows[0].id; // mesmo e-mail de novo
  return { ok: r.ok === true && a?.papel === 'marketing' && a.ativo === false && usado === true && !(await agente(id2)) && !!(await conta(id2)) && !(await agente(outro)),
           detalhe: 'convite gasto; segundo cadastro com o mesmo e-mail vira paciente' };
});

await caso('administrador pode reconvidar e cancelar; cancelar impede o acesso de equipe', async () => {
  await como('authenticated', ADM, async () => { await db.query(`select public.equipe_convidar('cancelado@clinica.test')`); await db.query(`select public.equipe_convite_cancelar('cancelado@clinica.test')`); });
  const id = await cadastrar('cancelado@clinica.test');
  return { ok: !(await agente(id)) && !!(await conta(id)) };
});

await caso('e-mail e papel inválidos são recusados', async () => {
  const erros = [];
  await como('authenticated', ADM, async () => {
    for (const q of [`select public.equipe_convidar('nao-e-email')`, `select public.equipe_convidar('ok@clinica.test', 'dono')`]) { try { await db.query(q); erros.push('passou: ' + q); } catch { /* esperado */ } }
  });
  return { ok: erros.length === 0, detalhe: erros.join('; ') || '2 recusas' };
});

// ---- privacidade das tabelas ----
const P1 = await cadastrar('paciente1@exemplo.com'), P2 = await cadastrar('paciente2@exemplo.com');
await caso('o paciente lê só a própria conta; não vê a de outro paciente', async () => {
  const n = await como('authenticated', P1, async () => (await db.query(`select count(*)::int n, bool_and(email = 'paciente1@exemplo.com') so_a_minha from public.contas_paciente`)).rows[0]);
  return { ok: n.n === 1 && n.so_a_minha === true, detalhe: `linhas visíveis = ${n.n}` };
});
await caso('o atendente ativo lê todas as contas (para vincular o cadastro)', async () => {
  const n = await como('authenticated', ADM, async () => (await db.query(`select count(*)::int n from public.contas_paciente`)).rows[0].n);
  return { ok: n >= 3, detalhe: `linhas = ${n}` };
});
await caso('o paciente NÃO consegue escrever na própria conta (nem se vincular a um cadastro)', async () => {
  const pac = (await db.query(`insert into public.pacientes (nome) values ('Fulano') returning id`)).rows[0].id;
  let escreveu = false;
  await como('authenticated', P1, async () => {
    for (const q of [`update public.contas_paciente set paciente_id = '${pac}' where id = '${P1}'`, `insert into public.contas_paciente (id) values (gen_random_uuid())`, `delete from public.contas_paciente`]) { try { await db.query(q); escreveu = true; } catch { /* esperado */ } }
  });
  const c = await conta(P1);
  return { ok: !escreveu && c.paciente_id === null, detalhe: escreveu ? 'ALGUMA ESCRITA PASSOU' : 'update, insert e delete recusados' };
});
await caso('anon não lê contas nem convites; ninguém além do administrador lê convites', async () => {
  const lidas = [];
  for (const [papel, uid, tab] of [['anon', null, 'contas_paciente'], ['anon', null, 'equipe_convites'], ['authenticated', P1, 'equipe_convites'], ['authenticated', ADM, 'equipe_convites']]) {
    await como(papel, uid, async () => { try { await db.query(`select * from public.${tab}`); lidas.push(`${papel}:${uid === ADM ? 'adm' : uid ? 'paciente' : '-'}→${tab}`); } catch { /* esperado */ } });
  }
  return { ok: lidas.length === 0, detalhe: lidas.join('; ') || '4 leituras recusadas (convites só pelas funções)' };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} casos passaram.`);
process.exit(falhas ? 1 : 0);
