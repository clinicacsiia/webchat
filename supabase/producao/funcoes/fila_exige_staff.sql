-- public.fila_exige_staff()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_exige_staff()
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()) in ('admin', 'atendente'), false) is false then
    raise exception 'Sem permissão para a fila.' using errcode = '42501';
  end if;
end $function$;

