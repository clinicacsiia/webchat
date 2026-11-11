-- public.convenio_suspender(p_operadora text, p_motivo text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_suspender(p_operadora text, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ch text := public.convenio_chave(p_operadora); v_ate timestamptz := now() + interval '1 month'; v_mot text := nullif(left(btrim(coalesce(p_motivo, '')), 300), '');
begin
  if coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente TI e gerência suspendem convênios.' using errcode = '42501'; end if;
  if v_ch ~ '^(|PARTICULAR.*)$' then raise exception 'O atendimento particular não pode ser suspenso.' using errcode = '22023'; end if;
  insert into public.convenio_config (operadora, ativo, suspenso_em, suspenso_ate, suspenso_por, suspenso_motivo, revisao_avisada_em)
  values (v_ch, true, now(), v_ate, (select auth.uid()), v_mot, null)
  on conflict (operadora) do update set suspenso_em = now(), suspenso_ate = v_ate, suspenso_por = (select auth.uid()), suspenso_motivo = v_mot, revisao_avisada_em = null;
  insert into public.org_alteracao_log (por, acao, alvo, depois) values ((select auth.uid()), 'convenio_suspenso', 'convenio:' || v_ch, jsonb_build_object('motivo', v_mot, 'revisar_em', v_ate));
  return jsonb_build_object('ok', true, 'operadora', v_ch, 'revisar_em', v_ate);
end $function$;

