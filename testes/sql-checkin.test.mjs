// FLUXOGRAMA: entrada (fila-chegada.sql + checkin-sem-login.sql num Postgres embutido com stubs do Supabase) -> validação (anônimo, paciente e equipe via JWT simulado) -> lógica (check-in sem login, conta existente, ticket, criar conta "csi", redefinir senha, troca obrigatória) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, d = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, 'exceção: ' + e.message.split('\n')[0]); } };
const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
await db.exec(`
  alter table public.agentes add column email text;
  create table auth.users (id uuid primary key default gen_random_uuid(), instance_id uuid, aud text, role text, email text, encrypted_password text, email_confirmed_at timestamptz,
    raw_app_meta_data jsonb, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz, updated_at timestamptz,
    confirmation_token text, recovery_token text, email_change_token_new text, email_change text, email_change_token_current text, reauthentication_token text, phone_change text, phone_change_token text);
  create table auth.identities (id uuid primary key default gen_random_uuid(), provider_id text, user_id uuid, identity_data jsonb, provider text, created_at timestamptz, updated_at timestamptz);
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid, not_after timestamptz);
  create function extensions.crypt(p text, s text) returns text language sql as $$ select 'h:' || p $$;
  create function extensions.gen_salt(t text) returns text language sql as $$ select 'x' $$;
  create table public.contas_paciente (id uuid primary key references auth.users(id) on delete cascade, email text, paciente_id uuid references public.pacientes(id), nome text, telefone text);
  create table public.equipe_convites (email text primary key, usado_em timestamptz);
  create function public.novo_usuario() returns trigger language plpgsql security definer as $$ begin insert into public.contas_paciente (id, email) values (new.id, new.email); return new; end $$;
  create trigger on_auth_user_created after insert on auth.users for each row execute function public.novo_usuario();
  grant select, insert, update, delete on all tables in schema public to authenticated;
`);
await db.exec(readFileSync(`${REPO}/supabase/fila-chegada.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/checkin-sem-login.sql`, 'utf8');
await db.exec(sql); await db.exec(sql);   // idempotente
const q = async (s, p = []) => (await db.query(s, p)).rows;
const como = async (uid, fn) => { await db.exec(`set request.jwt.claims = '${uid ? JSON.stringify({ sub: uid }) : ''}'; set role ${uid ? 'authenticated' : 'anon'}`); try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claims'); } };
const staff = (await q(`insert into auth.users (email) values ('eq@x.com') returning id`))[0].id;
await q(`insert into public.agentes (id, papel, ativo, email) values ($1, 'atendente', true, 'eq@x.com')`, [staff]);
const erro = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const ck = async (n, e, t, aj = false) => (await como(null, () => q('select public.checkin_publico($1,$2,$3,$4) r', [n, e, t, aj])))[0].r;

let tk, filaId;
await caso('check-in sem login entra na fila e devolve o ticket', async () => {
  const r = await ck('Maria da Silva', 'Maria@X.com', '(11) 98888-7777');
  tk = r.ticket; filaId = (await q(`select id from public.fila_chegada where ticket = $1`, [tk]))[0].id;
  return { ok: r.situacao === 'aguardando' && r.posicao === 1 && !!tk && r.conta_pronta === false, detalhe: JSON.stringify(r) };
});
await caso('repetir os mesmos dados não duplica e devolve o mesmo ticket', async () => {
  const r = await ck('Maria da Silva', 'maria@x.com', '11988887777');
  return { ok: r.ticket === tk && (await q('select count(*)::int n from public.fila_chegada'))[0].n === 1 };
});
await caso('nome sem sobrenome, e-mail ruim e telefone curto são recusados', async () => {
  const a = await erro(() => ck('Maria', 'a@b.com', '11988887777')), b = await erro(() => ck('Maria Souza', 'xx', '11988887777')), c = await erro(() => ck('Maria Souza', 'a@b.com', '123'));
  return { ok: !!a && !!b && !!c, detalhe: [a, b, c].join(' | ') };
});
await caso('o ticket mostra a posição; ticket errado = fora', async () => {
  const r = (await como(null, () => q('select public.fila_minha_vez_ticket($1) r', [tk])))[0].r;
  const x = (await como(null, () => q(`select public.fila_minha_vez_ticket('00000000-0000-4000-8000-000000000000') r`)))[0].r;
  return { ok: r.situacao === 'aguardando' && x.situacao === 'fora' };
});
await caso('anônimo e paciente não criam conta nem redefinem senha', async () => {
  const a = await erro(() => como(null, () => q('select public.fila_criar_conta($1)', [filaId])));
  return { ok: !!a, detalhe: a };
});
let conta;
await caso('equipe cria a conta: senha csi, provisória, ligada à fila, telefone e nome salvos', async () => {
  const r = (await como(staff, () => q('select public.fila_criar_conta($1) r', [filaId])))[0].r;
  const u = (await q(`select u.id, u.encrypted_password p, cp.senha_provisoria sp, cp.telefone t, cp.nome n from auth.users u join public.contas_paciente cp on cp.id = u.id where u.email = 'maria@x.com'`))[0];
  conta = u.id;
  const f = (await q(`select conta_id from public.fila_chegada where id = $1`, [filaId]))[0];
  const t = (await como(null, () => q('select public.fila_minha_vez_ticket($1) r', [tk])))[0].r;
  return { ok: r.senha === 'csi' && u.p === 'h:csi' && u.sp && u.t === '11988887777' && u.n === 'Maria da Silva' && f.conta_id === u.id && t.conta_pronta && t.email === 'maria@x.com' && !!(await q(`select 1 from auth.identities where user_id = $1`, [u.id])).length, detalhe: JSON.stringify([r, t]) };
});
await caso('criar conta de novo é recusado (já tem conta)', async () => ({ ok: /já tem conta/.test(await erro(() => como(staff, () => q('select public.fila_criar_conta($1)', [filaId]))) || '') }));
await caso('mesmo e-mail + telefone de conta existente: oferece login (sem entrar na fila)', async () => {
  const r = await ck('Maria da Silva', 'maria@x.com', '11 98888-7777');
  return { ok: r.situacao === 'conta_existente' };
});
await caso('só o e-mail igual (telefone diferente) não revela que existe conta', async () => {
  const r = await ck('Outra Pessoa', 'maria@x.com', '21977776666');
  return { ok: r.situacao === 'aguardando', detalhe: JSON.stringify(r) };
});
await q(`update public.fila_chegada set status = 'atendido', concluido_em = now()`);
await caso('esqueci a senha: entra na fila marcado "pede senha"; equipe redefine; senha nova e sessões derrubadas', async () => {
  await q(`insert into auth.sessions (user_id) values ($1)`, [conta]);
  const r = await ck('Maria da Silva', 'maria@x.com', '11988887777', true);
  const id = (await q(`select id from public.fila_chegada where ticket = $1`, [r.ticket]))[0].id;
  const f0 = (await q(`select pede_senha, conta_id from public.fila_chegada where id = $1`, [id]))[0];
  const s = (await como(staff, () => q('select public.fila_redefinir_senha($1) r', [id])))[0].r;
  const u = (await q(`select encrypted_password p from auth.users where id = $1`, [conta]))[0];
  const f1 = (await q(`select pede_senha, conta_id from public.fila_chegada where id = $1`, [id]))[0];
  return { ok: f0.pede_senha && f0.conta_id === null && /^csi\d{4}$/.test(s.senha) && u.p === 'h:' + s.senha && f1.conta_id === conta && !f1.pede_senha && (await q(`select count(*)::int n from auth.sessions where user_id = $1 and (not_after is null or not_after > now())`, [conta]))[0].n === 0, detalhe: JSON.stringify(s) };
});
await caso('troca obrigatória: marca, e some depois de trocar', async () => {
  const a = (await como(conta, () => q('select public.conta_precisa_trocar_senha() r')))[0].r;
  await como(conta, () => q('select public.conta_senha_trocada()'));
  const b = (await como(conta, () => q('select public.conta_precisa_trocar_senha() r')))[0].r;
  return { ok: a === true && b === false };
});
await caso('redefinir sem conta é recusado; e-mail de equipe nunca vira conta de paciente', async () => {
  const r = await ck('Joao Pereira', 'joao@x.com', '11955554444');
  const id = (await q(`select id from public.fila_chegada where ticket = $1`, [r.ticket]))[0].id;
  const a = await erro(() => como(staff, () => q('select public.fila_redefinir_senha($1)', [id])));
  await q(`update public.fila_chegada set email = 'eq@x.com' where id = $1`, [id]);
  const b = await erro(() => como(staff, () => q('select public.fila_criar_conta($1)', [id])));
  return { ok: /ainda não tem conta/.test(a || '') && /Já existe|da equipe/.test(b || ''), detalhe: [a, b].join(' | ') };
});
await caso('recepção registra com e-mail/telefone e já cria a conta', async () => {
  const r = (await como(staff, () => q(`select public.fila_registrar_completo('Pedro Alves', 'pedro@x.com', '(31) 99999-1111', true) r`)))[0].r;
  const u = (await q(`select cp.telefone, cp.senha_provisoria sp from public.contas_paciente cp where email = 'pedro@x.com'`))[0];
  return { ok: r.senha === 'csi' && u.telefone === '31999991111' && u.sp, detalhe: JSON.stringify(r) };
});
await caso('teto diário de check-ins sem conta', async () => {
  await q(`update public.config set valor = '1' where chave = 'checkin_sem_login_max_dia'`);
  const e = await erro(() => ck('Teste Teto', 'teto@x.com', '11911112222'));
  return { ok: /Muitos check-ins/.test(e || ''), detalhe: e };
});
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length}`); process.exit(ok === resultados.length ? 0 : 1);
