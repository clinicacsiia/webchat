-- public.preco_brl(v numeric)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.preco_brl(v numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select 'R$ ' || regexp_replace(trunc(round(v, 2))::text, '(\d)(?=(\d{3})+$)', '\1.', 'g') || ',' || lpad((round((round(v, 2) - trunc(round(v, 2))) * 100))::int::text, 2, '0')
$function$;

