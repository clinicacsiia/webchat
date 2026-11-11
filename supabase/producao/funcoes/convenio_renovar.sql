-- public.convenio_renovar(p_operadora text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_renovar(p_operadora text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ch text := public.convenio_chave(p_operadora); v_ate timestamptz := now() + interval '1 month'; v_n integer;
begin
  if coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente TI e gerência renovam a suspensão.' using errcode = '42501'; end if;
  update public.convenio_config set suspenso_ate = v_ate, revisao_avisada_em = null where operadora = v_ch and suspenso_em is not null;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Este convênio não está suspenso.' using errcode = '22023'; end if;
  insert into public.org_alteracao_log (por, acao, alvo, depois) values ((select auth.uid()), 'convenio_suspensao_renovada', 'convenio:' || v_ch, jsonb_build_object('revisar_em', v_ate));
  return v_ate;
end $function$;

