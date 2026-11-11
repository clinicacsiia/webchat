-- public.pessoa_equipe()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pessoa_equipe()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só administrador e atendente.' using errcode = '42501'; end if;
end $function$;

