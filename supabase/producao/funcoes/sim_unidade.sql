-- public.sim_unidade(p_unidade text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.sim_unidade(p_unidade text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case lower(btrim(coalesce(p_unidade, '')))
    when 'csi 1' then 'csi1' when 'csi 2' then 'csi2' when 'csi pediatria' then 'ped' else null end
$function$;

