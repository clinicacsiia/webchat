-- public.ocr_lado(t text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ocr_lado(t text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case when n ~ '\mBILATERA|\mAMBOS\M|\mDOIS LADOS' then 'A' when n ~ '\mDIREIT|\mDIR\M| D$' then 'D' when n ~ '\mESQUERD|\mESQ\M| E$' then 'E' end
  from (select coalesce(public.norm_nome(t), '') n) q
$function$;

