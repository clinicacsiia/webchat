-- public.chat_saude()
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_saude()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_api boolean; v_rel boolean;
begin
  select coalesce((select s.ok and s.em > now() - interval '6 minutes' from public.klingo_saude s where s.tipo = 'api'), false) into v_api;
  select coalesce((select e.klingo_em > now() - interval '10 minutes' and e.klingo_erro is null from public.jornada_sync_estado e limit 1), false) into v_rel;
  return jsonb_build_object('estado', case when v_api then 'verde' when v_rel then 'laranja' else 'vermelho' end, 'api', v_api, 'relatorio', v_rel);
end $function$;

