-- public.jornada_imutavel()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_imutavel()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception 'Registro do histórico não pode ser alterado.';
end;
$function$;

