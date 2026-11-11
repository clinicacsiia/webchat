-- public.jornada_nome_de(p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_nome_de(p_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(nullif(trim(a.nome), ''), nullif(split_part(coalesce(a.email, ''), '@', 1), ''), 'Equipe') from public.agentes a where a.id = p_id;
$function$;

