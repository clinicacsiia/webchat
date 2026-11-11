-- public.fila_estado(p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_estado(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_claims jsonb := public.fila_jwt_validar(p_token);
  a public.atendimentos%rowtype;
  v_a_frente integer := null;
  v_aguardando integer;
begin
  if v_claims is null then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  select * into a from public.atendimentos where id = (v_claims ->> 'atendimento_id')::uuid;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  select count(*) into v_aguardando from public.atendimentos where status = 'aguardando';
  if a.status = 'aguardando' then
    select count(*) into v_a_frente from public.atendimentos x
     where x.status = 'aguardando' and (x.created_at, x.id) < (a.created_at, a.id);
  end if;
  return jsonb_build_object(
    'ok', true,
    'status', a.status,
    'a_frente', v_a_frente,
    'aguardando', v_aguardando,
    'bloqueado', a.bloqueado_em is not null,
    'tentativas_restantes', greatest(3 - a.tentativas_falhas, 0),
    'documento', case when a.status = 'assinatura_pendente' and a.bloqueado_em is null then a.documento_texto end,
    'expira_em', to_timestamp((v_claims ->> 'exp')::bigint));
end $function$;

