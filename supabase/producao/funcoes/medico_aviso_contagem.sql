-- public.medico_aviso_contagem()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_aviso_contagem()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('novos', case when (select public.papel_atual()) = 'admin'
    then (select count(*) from public.medico_aviso where status = 'pendente') + (select count(distinct profissional) from public.medico_proc_aviso where status = 'pendente') else 0 end)
$function$;

