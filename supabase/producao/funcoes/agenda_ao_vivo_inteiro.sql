-- public.agenda_ao_vivo_inteiro(p_chave text, p_padrao integer, p_min integer, p_max integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_ao_vivo_inteiro(p_chave text, p_padrao integer, p_min integer, p_max integer)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select case when valor ~ '^[0-9]{1,6}$' and valor::int between p_min and p_max then valor::int end from public.config where chave = p_chave), p_padrao)
$function$;

