-- public.medico_admin()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medico_admin()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
end $function$;

