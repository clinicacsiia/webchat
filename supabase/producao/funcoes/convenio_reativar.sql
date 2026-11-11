-- public.convenio_reativar(p_operadora text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_reativar(p_operadora text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ch text := public.convenio_chave(p_operadora); v_n integer;
begin
  if coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente TI e gerência reativam convênios.' using errcode = '42501'; end if;
  update public.convenio_config set suspenso_em = null, suspenso_ate = null, suspenso_por = null, suspenso_motivo = null, revisao_avisada_em = null where operadora = v_ch and suspenso_em is not null;
  get diagnostics v_n = row_count;
  if v_n > 0 then insert into public.org_alteracao_log (por, acao, alvo) values ((select auth.uid()), 'convenio_reativado', 'convenio:' || v_ch); end if;
  return v_n > 0;
end $function$;

