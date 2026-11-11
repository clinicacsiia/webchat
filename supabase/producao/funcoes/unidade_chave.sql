-- public.unidade_chave(p text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.unidade_chave(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when p is null or btrim(p) = '' then null
    when lower(p) ~ 'desenvoar|pediatria' then 'desenvoar'
    when lower(p) ~ 'rm.?/?.?tc|csi 2' then 'rmtc'
    when lower(p) ~ 'csi' then 'csi'
    else null end
$function$;

