-- public.convenio_inativos()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_inativos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('chave', c.operadora, 'ativo', c.ativo, 'um_por_vez', c.um_por_vez, 'motivo', c.motivo)) from public.convenio_config c where not c.ativo or c.um_por_vez), '[]'::jsonb);
end $function$;

