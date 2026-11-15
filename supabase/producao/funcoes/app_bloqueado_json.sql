-- public.app_bloqueado_json(p_seg integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_bloqueado_json(p_seg integer)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('ok', false, 'erro', 'bloqueado', 'segundos', p_seg,
    'mensagem', 'Muitas tentativas. Aguarde ' || case when p_seg <= 60 then '1 minuto' else ceil(p_seg / 60.0)::int || ' minutos' end || '.') $function$;

