-- public.convenio_eventos_visto(p_operadora text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_eventos_visto(p_operadora text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n int;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  update public.convenio_evento set visto_em = now(), visto_por = (select auth.uid())
   where visto_em is null and (p_operadora is null or operadora = public.convenio_chave(p_operadora));
  get diagnostics n = row_count;
  return n;
end $function$;

