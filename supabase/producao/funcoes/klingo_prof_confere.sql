-- public.klingo_prof_confere(a text, b text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_prof_confere(a text, b text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  with t as (
    select array(select x from unnest(string_to_array(coalesce(public.norm_nome(a), ''), ' ')) x where x <> '' and x not in ('DR', 'DRA', 'DOUTOR', 'DOUTORA')) as ta,
           array(select x from unnest(string_to_array(coalesce(public.norm_nome(b), ''), ' ')) x where x <> '' and x not in ('DR', 'DRA', 'DOUTOR', 'DOUTORA')) as tb)
  select cardinality(ta) >= 2 and cardinality(tb) >= 2 and (ta <@ tb or tb <@ ta) from t
$function$;

