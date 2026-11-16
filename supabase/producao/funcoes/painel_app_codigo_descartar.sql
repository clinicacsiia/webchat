-- public.painel_app_codigo_descartar(p_id uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_app_codigo_descartar(p_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe descarta códigos.' using errcode = '42501'; end if;
  update public.app_codigo_email set descartado_em = now() where id = p_id and usado_em is null and descartado_em is null;
  get diagnostics n = row_count; return n;
end $function$;

