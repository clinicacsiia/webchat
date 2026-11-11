-- public.medico_excecao_remover(p_id bigint)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_excecao_remover(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.medico_admin();
  delete from public.medico_excecao where id = p_id;
  return jsonb_build_object('ok', true);
end $function$;

