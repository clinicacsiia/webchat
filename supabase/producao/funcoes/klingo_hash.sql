-- public.klingo_hash(p_texto text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_hash(p_texto text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_sal text;
begin
  select decrypted_secret into v_sal from vault.decrypted_secrets where name = 'klingo_hash_sal' limit 1;
  if v_sal is null then raise exception 'klingo_hash_sal ausente no cofre'; end if;
  return encode(extensions.hmac(convert_to(coalesce(p_texto, ''), 'UTF8'), convert_to(v_sal, 'UTF8'), 'sha256'), 'hex');
end $function$;

