-- public.klingo_segredo_ok(p_valor text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_segredo_ok(p_valor text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v text := public.klingo_segredo();
begin
  return v is not null and p_valor is not null and length(p_valor) = length(v) and p_valor = v;
end $function$;

