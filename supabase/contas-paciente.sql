-- FLUXOGRAMA: entrada (todo usuário novo do Supabase Auth, via gatilho on_auth_user_created) -> validação (primeiro usuário do banco? e-mail convidado pelo administrador? chave config.cadastro_equipe_sem_convite?) -> lógica (equipe vira linha INATIVA em agentes; paciente vira linha em contas_paciente; convite é de uso único) -> saída (agentes, contas_paciente e equipe_convites; RPCs equipe_convidar e equipe_convite_cancelar só para administrador)
-- Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
--
-- POR QUE: o gatilho original (novo_usuario) criava uma linha em public.agentes para QUALQUER cadastro novo. Com o login do paciente
-- (cadastro público por código no e-mail), cada paciente apareceria como "atendente aguardando liberação" no painel, e um clique errado
-- do administrador daria acesso de equipe a um paciente. Agora:
--   1. primeiro usuário do banco -> administrador ativo (igual ao anterior; só vale para um banco vazio);
--   2. e-mail convidado por um administrador (equipe_convidar) -> agente INATIVO com o papel do convite (o painel libera em seguida);
--   3. config.cadastro_equipe_sem_convite = 'sim' (TRANSIÇÃO, valor inicial) -> comportamento antigo: agente inativo sem convite;
--   4. qualquer outro cadastro -> public.contas_paciente (sem nenhum acesso de equipe).
-- DEPOIS de publicar o painel novo (que convida antes de cadastrar) e ANTES de ligar o login do paciente:
--     update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite';
--
-- ROLLBACK (definição anterior do gatilho, copiada da produção em 31/10/2026):
--   create or replace function public.novo_usuario() returns trigger language plpgsql security definer set search_path to '' as $f$
--   declare v_primeiro boolean;
--   begin
--     select not exists (select 1 from public.agentes) into v_primeiro;
--     insert into public.agentes (id, nome, email, papel, ativo)
--     values (new.id, coalesce(nullif(btrim(new.raw_user_meta_data->>'nome'), ''), split_part(new.email, '@', 1)), new.email,
--             case when v_primeiro then 'admin' else 'atendente' end, v_primeiro);
--     return new;
--   end $f$;
--   (as tabelas e funções novas podem ficar; ou: drop function public.equipe_convidar(text, text), public.equipe_convite_cancelar(text);
--    drop table public.equipe_convites, public.contas_paciente;)
-- Nenhum comando destrutivo neste arquivo. Pode ser aplicado mais de uma vez.

-- 1. Contas de paciente (login opcional). Só o gatilho escreve; o próprio paciente lê a sua linha; a equipe lê para vincular o cadastro.
create table if not exists public.contas_paciente (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  paciente_id uuid references public.pacientes(id) on delete set null,   -- vínculo feito pela equipe, nunca automático
  criado_em timestamptz not null default now(),
  ultimo_acesso_em timestamptz
);
comment on table public.contas_paciente is 'Conta de login do paciente (Supabase Auth). Criada pelo gatilho novo_usuario. paciente_id só é preenchido pela equipe depois de validar a identidade: e-mail digitado antes sem verificação não vincula histórico sozinho.';
create index if not exists contas_paciente_paciente on public.contas_paciente (paciente_id);
alter table public.contas_paciente enable row level security;
revoke all on table public.contas_paciente from anon, authenticated;
grant select on table public.contas_paciente to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contas_paciente' and policyname = 'contas_paciente_select') then
    create policy contas_paciente_select on public.contas_paciente for select
      using (id = (select auth.uid()) or (select public.papel_atual()) = any (array['admin','atendente']));
  end if;
end $$;

-- 2. Convites da equipe. Sem acesso direto: só as funções abaixo (administrador) e o gatilho.
create table if not exists public.equipe_convites (
  email text primary key check (email = lower(btrim(email)) and email <> ''),
  papel text not null default 'atendente' check (papel in ('admin','atendente','marketing')),
  criado_por uuid references auth.users(id) on delete set null,
  criado_em timestamptz not null default now(),
  usado_em timestamptz
);
comment on table public.equipe_convites is 'E-mails que podem virar equipe ao se cadastrar. Uso único (usado_em). Criado por equipe_convidar (administrador).';
alter table public.equipe_convites enable row level security;
revoke all on table public.equipe_convites from anon, authenticated;

create or replace function public.equipe_convidar(p_email text, p_papel text default 'atendente') returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só administrador convida pessoas para a equipe.' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if coalesce(p_papel, '') not in ('admin','atendente','marketing') then raise exception 'Papel inválido.' using errcode = '22023'; end if;
  insert into public.equipe_convites (email, papel, criado_por) values (v_email, p_papel, (select auth.uid()))
  on conflict (email) do update set papel = excluded.papel, criado_por = excluded.criado_por, criado_em = now(), usado_em = null;
  return jsonb_build_object('ok', true, 'email', v_email, 'papel', p_papel);
end $$;

create or replace function public.equipe_convite_cancelar(p_email text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_n int;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só administrador cancela convites.' using errcode = '42501'; end if;
  delete from public.equipe_convites where email = lower(btrim(coalesce(p_email, '')));
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'removidos', v_n);
end $$;
revoke all on function public.equipe_convidar(text, text), public.equipe_convite_cancelar(text) from public, anon;
grant execute on function public.equipe_convidar(text, text), public.equipe_convite_cancelar(text) to authenticated;

-- 3. Chave de transição: enquanto o painel antigo estiver no ar, cadastro sem convite continua gerando agente inativo (comportamento anterior).
insert into public.config (chave, valor) values ('cadastro_equipe_sem_convite', 'sim') on conflict (chave) do nothing;

-- 4. Gatilho: decide para onde vai cada cadastro novo.
create or replace function public.novo_usuario() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_primeiro boolean; v_email text := lower(btrim(coalesce(new.email, ''))); v_papel text; v_nome text;
begin
  v_nome := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'nome'), ''), nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'Sem nome');
  select not exists (select 1 from public.agentes) into v_primeiro;
  if v_primeiro then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, 'admin', true);
    return new;
  end if;
  if v_email <> '' then
    update public.equipe_convites set usado_em = now() where email = v_email and usado_em is null returning papel into v_papel;
  end if;
  if v_papel is not null then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, v_papel, false);
  elsif coalesce((select valor from public.config where chave = 'cadastro_equipe_sem_convite'), 'nao') = 'sim' then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, 'atendente', false);
  else
    insert into public.contas_paciente (id, email) values (new.id, new.email) on conflict (id) do nothing;
  end if;
  return new;
end $$;
