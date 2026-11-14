-- public.fluxo_nome_ok(p text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_nome_ok(p text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select p is not null and char_length(btrim(p)) between 5 and 120
    and btrim(p) ~ '^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''’.-]*( +[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''’.-]*)+$'
    and (select count(*) from regexp_split_to_table(btrim(p), ' +') w where char_length(regexp_replace(w, '[^A-Za-zÀ-ÖØ-öø-ÿ]', '', 'g')) >= 2) >= 2
$function$;

