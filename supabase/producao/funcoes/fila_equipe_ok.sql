-- public.fila_equipe_ok()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_equipe_ok()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Só a equipe de atendimento pode mexer na fila.' using errcode = '42501';
  end if;
end $function$;

