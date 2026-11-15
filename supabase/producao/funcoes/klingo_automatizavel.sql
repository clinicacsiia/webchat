-- public.klingo_automatizavel(p_proc integer, p_tipo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_automatizavel(p_proc integer, p_tipo text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when p_tipo = 'consulta' then exists (select 1 from public.klingo_especialidade e where e.liberada_api and p_proc = any (e.procedimentos))
              when p_tipo = 'exame' then p_proc is not null and public.klingo_exame_oferecido(p_proc)
              else false end
$function$;

