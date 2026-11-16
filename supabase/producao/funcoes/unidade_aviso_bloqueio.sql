-- public.unidade_aviso_bloqueio()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.unidade_aviso_bloqueio()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select 'No momento, o agendamento automático está disponível só para ' ||
    coalesce((select string_agg(u.rotulo, ' e ' order by u.ordem) from public.unidade_config u where u.ativo and public.unidade_marca_auto(u.catalogo)), 'a equipe') ||
    '. Para as outras unidades, a nossa equipe faz o agendamento com você.'
$function$;

