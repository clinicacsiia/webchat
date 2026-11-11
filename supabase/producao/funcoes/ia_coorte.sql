-- public.ia_coorte(p_ini timestamp with time zone)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ia_coorte(p_ini timestamp with time zone)
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.id from public.pre_agendamentos p
   where p.criado_em >= p_ini and exists (select 1 from public.ia_evento c where c.pre_agendamento_id = p.id and c.tipo = 'criado')
$function$;

