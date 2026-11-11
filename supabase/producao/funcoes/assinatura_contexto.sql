-- public.assinatura_contexto(p_segredo text, p_token text, p_hash text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.assinatura_contexto(p_segredo text, p_token text, p_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_claims jsonb;
  a public.atendimentos%rowtype;
  v_perfil jsonb;
begin
  if not public.fila_segredo_ok(p_segredo) then
    raise exception 'Não autorizado.' using errcode = '42501';
  end if;
  v_claims := public.fila_jwt_validar(p_token);
  if v_claims is null then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  select * into a from public.atendimentos where id = (v_claims ->> 'atendimento_id')::uuid;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  if a.bloqueado_em is not null then
    return jsonb_build_object('ok', false, 'erro', 'bloqueado');
  end if;
  if a.status <> 'assinatura_pendente' then
    return jsonb_build_object('ok', false, 'erro', 'fora_de_assinatura');
  end if;
  if a.documento_hash is distinct from p_hash then
    return jsonb_build_object('ok', false, 'erro', 'documento_diferente');
  end if;
  select perfil_biometrico_historico into v_perfil from public.pacientes where id = a.paciente_id;
  return jsonb_build_object('ok', true, 'perfil', coalesce(v_perfil, '{}'::jsonb), 'tentativas_falhas', a.tentativas_falhas);
end $function$;

