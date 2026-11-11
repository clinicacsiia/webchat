-- public.convenio_aviso_contagem()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_aviso_contagem()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when (select public.papel_atual()) = 'admin'
    then jsonb_build_object('novos', (select count(*) from public.convenio_evento where visto_em is null), 'relevantes', (select count(*) from public.convenio_evento where visto_em is null and relevante))
    else jsonb_build_object('novos', 0, 'relevantes', 0) end
$function$;

