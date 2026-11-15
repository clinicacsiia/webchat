-- public.app_nome_ok(t text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_nome_ok(t text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select length(btrim(coalesce(t, ''))) between 5 and 120
     and btrim(t) ~ '^[A-Za-zÀ-ÿ''. -]+$'
     and (select count(*) from regexp_split_to_table(btrim(t), '\s+') as w where length(w) >= 2) >= 2 $function$;

