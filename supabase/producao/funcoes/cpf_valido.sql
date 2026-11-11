-- public.cpf_valido(t text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.cpf_valido(t text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare d text := public.cpf_digitos(t); soma int := 0; r int; i int;
begin
  if d is null or length(d) <> 11 or d ~ '^(\d)\1{10}$' then return false; end if;
  for i in 1..9 loop soma := soma + substr(d, i, 1)::int * (11 - i); end loop;
  r := (soma * 10) % 11; if r = 10 then r := 0; end if;
  if r <> substr(d, 10, 1)::int then return false; end if;
  soma := 0;
  for i in 1..10 loop soma := soma + substr(d, i, 1)::int * (12 - i); end loop;
  r := (soma * 10) % 11; if r = 10 then r := 0; end if;
  return r = substr(d, 11, 1)::int;
end $function$;

