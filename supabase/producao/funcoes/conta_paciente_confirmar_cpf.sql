-- public.conta_paciente_confirmar_cpf(p_cpf text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_confirmar_cpf(p_cpf text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_cp record; s record; p record;
begin
  select * into v_cp from public.contas_paciente where id = v_uid for update;
  if v_uid is null or not found then raise exception 'Entre na sua conta para confirmar com o CPF.' using errcode = '42501'; end if;
  if not public.cpf_valido(p_cpf) then raise exception 'Os números do CPF não conferem. Confira, por favor.' using errcode = '22023'; end if;
  if v_cp.paciente_id is not null then return jsonb_build_object('resultado', 'ja_vinculado'); end if;
  select * into s from public.vinculo_solicitacoes where conta_id = v_uid and tipo = 'verificar' and status = 'aberta' for update;
  if not found then return jsonb_build_object('resultado', 'sem_pedido'); end if;

  if v_cp.vinculo_ultima_em is null or v_cp.vinculo_ultima_em < now() - interval '1 hour' then v_cp.vinculo_tentativas := 0; end if;
  if v_cp.vinculo_tentativas >= 5 then return jsonb_build_object('resultado', 'bloqueado'); end if;
  update public.contas_paciente set vinculo_tentativas = v_cp.vinculo_tentativas + 1, vinculo_ultima_em = now() where id = v_uid;

  select * into p from public.pacientes where id = s.paciente_id and not revisar;
  if not found or exists (select 1 from public.contas_paciente o where o.paciente_id = p.id and o.id <> v_uid) then return jsonb_build_object('resultado', 'sem_pedido'); end if;
  if public.cpf_digitos(p.cpf) is null then return jsonb_build_object('resultado', 'cadastro_sem_cpf'); end if;
  if public.cpf_digitos(p.cpf) <> public.cpf_digitos(p_cpf) then return jsonb_build_object('resultado', 'cpf_nao_confere'); end if;

  update public.contas_paciente set paciente_id = p.id, vinculado_em = now(), vinculo_tentativas = 0, vinculo_metodo = 'cpf' where id = v_uid;
  update public.vinculo_solicitacoes set tipo = 'atualizar', batem = array_append(batem, 'cpf'), criado_em = now() where id = s.id;
  return jsonb_build_object('resultado', 'vinculado_conferir');
end $function$;

