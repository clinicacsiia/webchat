-- FLUXOGRAMA: entrada (uma vez por dia, de madrugada) -> validação (só registros TÉCNICOS de execução das rotinas; nada de paciente, conversa ou auditoria) -> lógica (apaga o histórico de execuções do pg_cron com mais de 3 dias, guardando as falhas por 14 dias) -> saída (o banco para de crescer sem necessidade; a função devolve quantas linhas saíram)
-- Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (auditoria de 11/11/2026)
-- APLICADO NA PRODUÇÃO em 11/11/2026 (migrações auditoria_1111_*) e conferido lá. Resultado medido: docs/auditoria-2026-11-11.md.
--
-- O QUE ESTAVA ERRADO (medido na produção em 11/11/2026):
--   * cron.job_run_details guardava TODAS as execuções desde 06/11: 41.924 linhas, 20 MB em 4 dias e meio (há rotinas de 15 e 30 s:
--     cerca de 10 mil execuções por dia). Ninguém limpava. No ritmo, ~130 MB por mês num banco com limite de 500 MB no plano atual.
--
-- Não apaga nada de negócio. Aditivo e idempotente.
-- ROLLBACK: select cron.unschedule('manutencao-limpeza'); drop function public.manutencao_limpar();

create or replace function public.manutencao_limpar() returns jsonb
language plpgsql security definer set search_path to '' as $$
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
end $$;
revoke all on function public.manutencao_limpar() from public, anon, authenticated;

-- Todo dia às 04:17 de Brasília (07:17 UTC), fora do horário das outras rotinas diárias.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('manutencao-limpeza', '17 7 * * *', 'select public.manutencao_limpar()');
  end if;
end $$;
