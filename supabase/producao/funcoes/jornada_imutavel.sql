-- public.jornada_imutavel()
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.jornada_imutavel()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception 'Registro do histórico não pode ser alterado.';
end;
$function$;

