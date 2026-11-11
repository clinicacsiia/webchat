-- public.nome_confere(a text, b text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.nome_confere(a text, b text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case
    when x.na is null or x.nb is null then false
    when x.na = x.nb then true
    else coalesce((
      select count(*) >= 2 and bool_and(t = any(string_to_array(case when length(x.na) <= length(x.nb) then x.nb else x.na end, ' ')))
      from unnest(string_to_array(case when length(x.na) <= length(x.nb) then x.na else x.nb end, ' ')) t where length(t) > 2), false)
  end
  from (select public.norm_nome(a) na, public.norm_nome(b) nb) x
$function$;

