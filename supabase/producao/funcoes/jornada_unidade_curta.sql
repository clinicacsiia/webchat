-- public.jornada_unidade_curta(p text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.jornada_unidade_curta(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when upper(coalesce(p, '')) like '%RM/TC%' or lower(coalesce(p, '')) = 'rmtc' then 'CSI 2'
    when upper(coalesce(p, '')) like '%- CSI' or lower(coalesce(p, '')) = 'csi' then 'CSI 1'
    when upper(coalesce(p, '')) like 'DESENVOAR%' then 'CSI Pediatria'
    else coalesce(nullif(trim(p), ''), '')
  end;
$function$;

