-- public.valores_em_reais(p_texto text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.valores_em_reais(p_texto text)
 RETURNS numeric[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select coalesce(array_agg(v order by ord), '{}'::numeric[]) from (
    select ord, replace(replace(m[1], '.', ''), ',', '.')::numeric as v
    from regexp_matches(coalesce(p_texto, ''), 'R\$\s*([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?|[0-9]+(?:,[0-9]{1,2})?)', 'g') with ordinality as t(m, ord)
    union all
    select 1000 + ord, replace(replace(m[1], '.', ''), ',', '.')::numeric
    from regexp_matches(coalesce(p_texto, ''), '([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?|[0-9]+(?:,[0-9]{1,2})?)\s*reais', 'gi') with ordinality as t(m, ord)
  ) x
$function$;

