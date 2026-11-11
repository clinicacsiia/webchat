-- public.conta_paciente_pedir_alteracao(p_cpf text, p_email text, p_telefone text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_pedir_alteracao(p_cpf text, p_email text DEFAULT NULL::text, p_telefone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid()); v_cp record; p record; v_email text := lower(btrim(coalesce(p_email, '')));
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_dif text[] := '{}';
begin
  select * into v_cp from public.contas_paciente where id = v_uid for update;
  if v_uid is null or not found then raise exception 'Entre na sua conta para pedir a mudança.' using errcode = '42501'; end if;
  if v_email = '' then v_email := null; end if;
  if v_tel = '' then v_tel := null; end if;
  if v_email is null and v_tel is null then raise exception 'Informe o e-mail ou o telefone novo.' using errcode = '22023'; end if;
  if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 200) then raise exception 'Informe um e-mail válido.' using errcode = '22023'; end if;
  if v_tel is not null then
    if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
    if char_length(v_tel) not in (10, 11) then raise exception 'Informe um telefone válido com DDD.' using errcode = '22023'; end if;
  end if;
  if not public.cpf_valido(p_cpf) then raise exception 'Os números do CPF não conferem. Confira, por favor.' using errcode = '22023'; end if;
  if v_cp.paciente_id is null then return jsonb_build_object('resultado', 'sem_cadastro'); end if;

  if v_cp.vinculo_ultima_em is null or v_cp.vinculo_ultima_em < now() - interval '1 hour' then v_cp.vinculo_tentativas := 0; end if;
  if v_cp.vinculo_tentativas >= 5 then return jsonb_build_object('resultado', 'bloqueado'); end if;
  update public.contas_paciente set vinculo_tentativas = v_cp.vinculo_tentativas + 1, vinculo_ultima_em = now() where id = v_uid;

  select * into p from public.pacientes where id = v_cp.paciente_id;
  if not found then return jsonb_build_object('resultado', 'sem_cadastro'); end if;
  if public.cpf_digitos(p.cpf) is null then return jsonb_build_object('resultado', 'cadastro_sem_cpf'); end if;
  if public.cpf_digitos(p.cpf) <> public.cpf_digitos(p_cpf) then return jsonb_build_object('resultado', 'cpf_nao_confere'); end if;

  if v_email is not null and lower(btrim(coalesce(p.email, ''))) <> v_email then v_dif := array_append(v_dif, 'email'); else v_email := null; end if;
  if v_tel is not null and not (public.fone_chave(v_tel) = any(p.telefones)) then v_dif := array_append(v_dif, 'telefone'); else v_tel := null; end if;
  if cardinality(v_dif) = 0 then return jsonb_build_object('resultado', 'sem_mudanca'); end if;

  insert into public.vinculo_solicitacoes (conta_id, paciente_id, tipo, batem, diferem, conta_nome, conta_telefone, novo_email, novo_telefone)
  values (v_uid, p.id, 'alterar', array['cpf'], v_dif, v_cp.nome, v_cp.telefone, v_email, v_tel)
  on conflict (conta_id, tipo) where status = 'aberta' do update set paciente_id = excluded.paciente_id, diferem = excluded.diferem,
         novo_email = excluded.novo_email, novo_telefone = excluded.novo_telefone, criado_em = now();
  return jsonb_build_object('resultado', 'pedido_enviado');
end $function$;

