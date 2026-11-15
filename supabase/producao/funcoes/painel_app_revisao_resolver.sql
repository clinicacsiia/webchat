-- public.painel_app_revisao_resolver(p_id uuid)
-- Pode executar: authenticated
CREATE OR REPLACE FUNCTION public.painel_app_revisao_resolver(p_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe resolve as revisões.' using errcode = '42501'; end if;
  update public.app_paciente set revisar_motivo = null, revisao_resolvida_em = now() where id = p_id;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

