-- public.manutencao_limpar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.manutencao_limpar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n_ok bigint := 0; n_falha bigint := 0; v jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('manutencao_limpar')) then return jsonb_build_object('pulou', true); end if;
  -- Execuções que deram certo: 3 dias bastam para investigar. As que falharam ficam 14 dias.
  delete from cron.job_run_details where status = 'succeeded' and start_time < now() - interval '3 days';
  get diagnostics n_ok = row_count;
  delete from cron.job_run_details where status is distinct from 'succeeded' and start_time < now() - interval '14 days';
  get diagnostics n_falha = row_count;
  v := jsonb_build_object('em', now(), 'execucoes_apagadas', n_ok, 'falhas_antigas_apagadas', n_falha);
  return v;
end $function$;

