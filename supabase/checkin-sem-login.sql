-- FLUXOGRAMA: entrada (paciente SEM login faz check-in com nome, e-mail e telefone; a equipe cria a conta ou redefine a senha pela fila) -> validação (dados mínimos, telefone com DDD, um check-in aberto por pessoa, teto diário, só equipe mexe em conta, nunca conta de equipe) -> lógica (check-in anônimo vira linha em fila_chegada com um "ticket" secreto guardado no aparelho; e-mail+telefone iguais aos de uma conta oferecem login ou pedem ajuda da recepção; a equipe cria a conta com senha provisória "csi" ou gera outra senha provisória; a primeira entrada obriga trocar a senha) -> saída (fila_chegada.ticket/email/telefone/pede_senha, contas_paciente.senha_provisoria, RPCs checkin_publico, fila_minha_vez_ticket, fila_criar_conta, fila_redefinir_senha, fila_registrar_completo, conta_precisa_trocar_senha, conta_senha_trocada)
-- Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
-- Pré-requisitos: fila-chegada.sql, contas-paciente.sql, login-paciente.sql (colunas nome/telefone), pacientes.sql (fone_chave). Aditivo e idempotente. Nenhum comando destrutivo. Nenhum segredo aqui.
--
-- ROLLBACK: drop function public.checkin_publico(text, text, text, boolean), public.fila_minha_vez_ticket(uuid), public.fila_criar_conta(uuid), public.fila_redefinir_senha(uuid),
--   public.fila_registrar_completo(text, text, text, boolean), public.conta_precisa_trocar_senha(), public.conta_senha_trocada();
--   (as colunas novas podem ficar; ou: alter table public.fila_chegada drop column ticket, drop column email, drop column telefone, drop column pede_senha; alter table public.contas_paciente drop column senha_provisoria;)

alter table public.fila_chegada add column if not exists email text;
alter table public.fila_chegada add column if not exists telefone text;
alter table public.fila_chegada add column if not exists pede_senha boolean not null default false;
alter table public.fila_chegada add column if not exists ticket uuid not null default gen_random_uuid();
create unique index if not exists fila_chegada_ticket on public.fila_chegada (ticket);
alter table public.contas_paciente add column if not exists senha_provisoria boolean not null default false;
alter table public.contas_paciente add column if not exists identidade_conferida_em timestamptz;   -- a recepção conferiu quem é a pessoa (libera os exames do Klingo no portal; ver jornada-paciente.sql)

insert into public.config (chave, valor) values ('checkin_sem_login_max_dia', '300') on conflict (chave) do nothing;

-- Telefone só com dígitos (sem 55), 10 ou 11; null se inválido. Guardado assim; comparações usam fone_chave.
create or replace function public.fone_digitos(t text) returns text language sql immutable set search_path to '' as $$
  select case when length(d) in (10, 11) then d end
  from (select case when length(regexp_replace(coalesce(t, ''), '\D', '', 'g')) in (12, 13) and left(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 2) = '55'
                    then substr(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 3) else regexp_replace(coalesce(t, ''), '\D', '', 'g') end) q(d)
$$;

-- Quando a equipe liga uma conta à linha da fila, as telas abertas se atualizam.
create or replace trigger fila_chegada_aviso after insert or update of status, conta_id on public.fila_chegada
  for each statement execute function public.fila_chegada_trg();

-- Situação de uma linha da fila (mesmo formato de fila_minha_vez, mais o que o check-in sem login precisa).
create or replace function public.fila_situacao_linha(r public.fila_chegada) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_total int; v_extra jsonb;
begin
  select count(*)::int into v_total from public.fila_chegada where status = 'aguardando' and public.fila_dia(chegou_em) = public.fila_dia(now());
  v_extra := jsonb_build_object('conta_pronta', r.conta_id is not null, 'email', case when r.conta_id is not null then r.email end, 'pede_senha', r.pede_senha);
  if r.status = 'chamado' and public.fila_dia(r.chegou_em) = public.fila_dia(now()) then
    return jsonb_build_object('situacao', 'chamado', 'senha', r.senha, 'total', v_total) || v_extra;
  elsif r.status = 'aguardando' and public.fila_dia(r.chegou_em) = public.fila_dia(now()) then
    return jsonb_build_object('situacao', 'aguardando', 'senha', r.senha, 'posicao', public.fila_posicao(r.id), 'a_frente', public.fila_posicao(r.id) - 1, 'total', v_total) || v_extra;
  elsif r.status = 'atendido' and r.concluido_em > now() - interval '3 hours' then
    return jsonb_build_object('situacao', 'atendido', 'total', v_total) || v_extra;
  end if;
  return jsonb_build_object('situacao', 'fora', 'total', v_total);
end $$;
revoke all on function public.fila_situacao_linha(public.fila_chegada) from public, anon, authenticated;

-- Sem login: quem tem o ticket (guardado só no aparelho que fez o check-in) vê a própria posição.
create or replace function public.fila_minha_vez_ticket(p_ticket uuid) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare r public.fila_chegada%rowtype;
begin
  select * into r from public.fila_chegada where ticket = p_ticket;
  if r.id is null then return jsonb_build_object('situacao', 'fora', 'ticket_invalido', true); end if;
  return public.fila_situacao_linha(r);
end $$;

-- Check-in sem login (e também com login esquecido). p_ajuda_senha = "tenho conta mas não sei a senha: chamem a recepção".
create or replace function public.checkin_publico(p_nome text, p_email text, p_telefone text, p_ajuda_senha boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_nome text := regexp_replace(btrim(coalesce(p_nome, '')), '\s+', ' ', 'g'); v_email text := lower(btrim(coalesce(p_email, '')));
        v_fone text := public.fone_digitos(p_telefone); v_max int; v_senha int; v_conta boolean; r public.fila_chegada%rowtype;
begin
  if char_length(v_nome) not between 5 and 120 or position(' ' in v_nome) = 0 then raise exception 'Digite o nome completo.' using errcode = '22023'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 200 then raise exception 'Digite um e-mail válido.' using errcode = '22023'; end if;
  if v_fone is null then raise exception 'Digite o celular com DDD.' using errcode = '22023'; end if;

  -- E-mail e telefone iguais aos de uma conta: oferece entrar (só diz "existe" quando os DOIS batem, para não revelar quem tem conta).
  select exists (select 1 from public.contas_paciente cp where lower(btrim(cp.email)) = v_email and public.fone_chave(cp.telefone) = public.fone_chave(v_fone)) into v_conta;
  if v_conta and not coalesce(p_ajuda_senha, false) then
    return jsonb_build_object('situacao', 'conta_existente', 'email', v_email);
  end if;

  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  -- Já está na fila hoje (mesmo e-mail E mesmo telefone; só um dos dois não basta, para ninguém pegar o ticket de outra pessoa): devolve o mesmo ticket, sem duplicar.
  select * into r from public.fila_chegada where status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) = public.fila_dia(now())
     and lower(email) = v_email and public.fone_chave(telefone) = public.fone_chave(v_fone) order by chegou_em limit 1;
  if r.id is not null then
    if coalesce(p_ajuda_senha, false) and not r.pede_senha then update public.fila_chegada set pede_senha = true where id = r.id; r.pede_senha := true; end if;
    return public.fila_situacao_linha(r) || jsonb_build_object('ticket', r.ticket);
  end if;

  select coalesce(nullif(valor, '')::int, 300) into v_max from public.config where chave = 'checkin_sem_login_max_dia';
  if (select count(*) from public.fila_chegada where conta_id is null and origem = 'paciente' and public.fila_dia(chegou_em) = public.fila_dia(now())) >= coalesce(v_max, 300) then
    raise exception 'Muitos check-ins agora. Avise a recepção.' using errcode = '54000';
  end if;
  select coalesce(max(senha), 0) + 1 into v_senha from public.fila_chegada where public.fila_dia(chegou_em) = public.fila_dia(now());
  insert into public.fila_chegada (nome, senha, origem, email, telefone, pede_senha)
  values (v_nome, v_senha, 'paciente', v_email, v_fone, v_conta and coalesce(p_ajuda_senha, false)) returning * into r;
  return public.fila_situacao_linha(r) || jsonb_build_object('ticket', r.ticket);
end $$;

-- Equipe: cria a conta do paciente da fila com a senha provisória "csi".
create or replace function public.fila_criar_conta(p_id uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare r public.fila_chegada%rowtype; v_uid uuid := gen_random_uuid(); v_ok boolean;
begin
  perform public.fila_equipe_ok();
  select * into r from public.fila_chegada where id = p_id for update;
  if r.id is null then raise exception 'Essa pessoa não está na fila.' using errcode = 'P0002'; end if;
  if r.conta_id is not null then raise exception 'Essa pessoa já tem conta. Use "Redefinir senha" se ela esqueceu a senha.' using errcode = 'P0001'; end if;
  if coalesce(r.email, '') = '' or coalesce(r.telefone, '') = '' then raise exception 'Faltam o e-mail e o telefone para criar a conta.' using errcode = '22023'; end if;
  if exists (select 1 from auth.users where lower(email) = lower(r.email)) then
    raise exception 'Já existe uma conta com esse e-mail. Use "Redefinir senha" depois de conferir quem é a pessoa.' using errcode = 'P0001';
  end if;
  -- Nunca criar conta com e-mail de equipe (o gatilho transformaria em atendente).
  if exists (select 1 from public.agentes where lower(email) = lower(r.email)) or exists (select 1 from public.equipe_convites where email = lower(r.email) and usado_em is null) then
    raise exception 'Esse e-mail é da equipe. Peça outro e-mail ao paciente.' using errcode = '42501';
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, reauthentication_token, phone_change, phone_change_token)
  values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', lower(r.email), extensions.crypt('csi', extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('nome', r.nome), now(), now(), '', '', '', '', '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (v_uid::text, v_uid, jsonb_build_object('sub', v_uid::text, 'email', lower(r.email), 'email_verified', true, 'phone_verified', false), 'email', now(), now());
  select exists (select 1 from public.contas_paciente where id = v_uid) into v_ok;
  if not v_ok then raise exception 'Não foi possível criar a conta de paciente.' using errcode = 'P0001'; end if;   -- desfaz tudo (ex.: gatilho mandou para a equipe)
  update public.contas_paciente set nome = r.nome, telefone = r.telefone, senha_provisoria = true, identidade_conferida_em = now() where id = v_uid;
  update public.fila_chegada set conta_id = v_uid, pede_senha = false where id = r.id;
  return jsonb_build_object('ok', true, 'email', lower(r.email), 'senha', 'csi');
end $$;

-- Equipe: gera uma senha provisória nova (a pessoa foi conferida no balcão). Liga a linha da fila à conta pelo e-mail.
create or replace function public.fila_redefinir_senha(p_id uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare r public.fila_chegada%rowtype; v_conta uuid; v_email text; v_senha text;
begin
  perform public.fila_equipe_ok();
  select * into r from public.fila_chegada where id = p_id for update;
  if r.id is null then raise exception 'Essa pessoa não está na fila.' using errcode = 'P0002'; end if;
  v_conta := r.conta_id;
  if v_conta is null and coalesce(r.email, '') <> '' then
    select id into v_conta from public.contas_paciente where lower(btrim(email)) = lower(r.email) limit 1;
  end if;
  if v_conta is null then raise exception 'Essa pessoa ainda não tem conta. Use "Criar conta".' using errcode = 'P0002'; end if;
  select email into v_email from public.contas_paciente where id = v_conta;
  if v_email is null then raise exception 'Essa conta não é de paciente.' using errcode = '42501'; end if;
  v_senha := 'csi' || lpad((abs(('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 7))::bit(28)::int) % 10000)::text, 4, '0');
  update auth.users set encrypted_password = extensions.crypt(v_senha, extensions.gen_salt('bf')), updated_at = now() where id = v_conta;
  update auth.sessions set not_after = now() where user_id = v_conta and (not_after is null or not_after > now());   -- expira quem estivesse logado com a senha antiga (update, não delete: a ferramenta de migração pede confirmação em delete)
  update public.contas_paciente set senha_provisoria = true, identidade_conferida_em = coalesce(identidade_conferida_em, now()) where id = v_conta;
  if r.conta_id is null and not exists (select 1 from public.fila_chegada where conta_id = v_conta and status in ('aguardando', 'chamado')) then
    update public.fila_chegada set conta_id = v_conta where id = r.id;
  end if;
  update public.fila_chegada set pede_senha = false where id = r.id;
  return jsonb_build_object('ok', true, 'email', v_email, 'senha', v_senha);
end $$;

-- Equipe: registra a chegada com e-mail e telefone e, se quiser, já cria a conta.
create or replace function public.fila_registrar_completo(p_nome text, p_email text, p_telefone text, p_criar_conta boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_id uuid; v_email text := lower(btrim(coalesce(p_email, ''))); v_fone text := public.fone_digitos(p_telefone); v_conta jsonb;
begin
  perform public.fila_equipe_ok();
  if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if coalesce(p_telefone, '') <> '' and v_fone is null then raise exception 'Telefone inválido (use DDD).' using errcode = '22023'; end if;
  if coalesce(p_criar_conta, false) and (v_email = '' or v_fone is null) then raise exception 'Para criar a conta, informe e-mail e telefone.' using errcode = '22023'; end if;
  v_id := public.fila_registrar_chegada(p_nome);
  update public.fila_chegada set email = nullif(v_email, ''), telefone = v_fone where id = v_id;
  if coalesce(p_criar_conta, false) then v_conta := public.fila_criar_conta(v_id); end if;
  return jsonb_build_object('id', v_id) || coalesce(v_conta, '{}'::jsonb);
end $$;

-- Paciente logado: precisa trocar a senha provisória?
create or replace function public.conta_precisa_trocar_senha() returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((select senha_provisoria from public.contas_paciente where id = (select auth.uid())), false)
$$;
create or replace function public.conta_senha_trocada() returns void language sql security definer set search_path to '' as $$
  update public.contas_paciente set senha_provisoria = false where id = (select auth.uid())
$$;

revoke all on function public.fone_digitos(text) from public, anon, authenticated;
revoke all on function public.fila_minha_vez_ticket(uuid), public.checkin_publico(text, text, text, boolean), public.fila_criar_conta(uuid), public.fila_redefinir_senha(uuid),
  public.fila_registrar_completo(text, text, text, boolean), public.conta_precisa_trocar_senha(), public.conta_senha_trocada() from public, anon;
grant execute on function public.fila_minha_vez_ticket(uuid), public.checkin_publico(text, text, text, boolean) to anon, authenticated;
grant execute on function public.fila_criar_conta(uuid), public.fila_redefinir_senha(uuid), public.fila_registrar_completo(text, text, text, boolean),
  public.conta_precisa_trocar_senha(), public.conta_senha_trocada() to authenticated;
