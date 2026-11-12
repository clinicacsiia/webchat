-- public.klingo_segredo()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_segredo()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'klingo_interno_segredo' limit 1;
  return v;
exception when others then return null;
end $function$;

