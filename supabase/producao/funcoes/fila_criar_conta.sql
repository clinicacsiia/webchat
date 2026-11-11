-- public.fila_criar_conta(p_id uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_criar_conta(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if not v_ok then raise exception 'Não foi possível criar a conta de paciente.' using errcode = 'P0001'; end if;
  update public.contas_paciente set nome = r.nome, telefone = r.telefone, senha_provisoria = true, identidade_conferida_em = now() where id = v_uid;
  update public.fila_chegada set conta_id = v_uid, pede_senha = false where id = r.id;
  return jsonb_build_object('ok', true, 'email', lower(r.email), 'senha', 'csi');
end $function$;

