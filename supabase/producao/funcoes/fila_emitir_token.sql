-- public.fila_emitir_token(p_segredo text, p_atendimento uuid)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_emitir_token(p_segredo text, p_atendimento uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.atendimentos%rowtype;
  v_nome text;
  v_agora bigint := floor(extract(epoch from now()))::bigint;
  v_exp bigint := floor(extract(epoch from now()))::bigint + 4 * 3600;
begin
  if not public.fila_segredo_ok(p_segredo) then
    raise exception 'Não autorizado.' using errcode = '42501';
  end if;
  select * into a from public.atendimentos where id = p_atendimento for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'atendimento_inexistente');
  end if;
  if a.status not in ('aguardando', 'assinatura_pendente') then
    return jsonb_build_object('ok', false, 'erro', 'fora_da_fila');
  end if;
  if a.links_enviados >= 10 then
    return jsonb_build_object('ok', false, 'erro', 'limite_de_envios');
  end if;
  select nome into v_nome from public.pacientes where id = a.paciente_id;
  update public.atendimentos set links_enviados = links_enviados + 1 where id = a.id;
  return jsonb_build_object(
    'ok', true,
    'token', public.fila_jwt_assinar(jsonb_build_object(
      'aud', 'fila', 'atendimento_id', a.id, 'email_informado', a.email_informado,
      'iat', v_agora, 'exp', v_exp, 'jti', gen_random_uuid())),
    'nome', v_nome,
    'email', a.email_informado,
    'expira_em', to_timestamp(v_exp));
end $function$;

