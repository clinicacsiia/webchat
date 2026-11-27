-- FLUXOGRAMA: entrada (pg_cron, 1x por dia às 03h10 de Brasília = 06:10 UTC) -> validação (usa a função que já existe, consulta_atendida_disparar com datas; ela não depende do expediente quando recebe datas)
--   -> lógica (relê do Klingo os últimos 30 dias, até ontem, pelo relatório #14637; atendimentos novos entram em consulta_feita, os que já existem são ignorados)
--   -> saída (só contagens no retorno da Edge Function; nenhum dado de paciente sai do banco)
-- Versão 1.0 — 27/11/2026 / Mudança: Implementação inicial. A rotina de 10 em 10 minutos (consulta-atendida-sync) só relê anteontem, ontem e hoje; atendimento que o Klingo fecha como "Atendido" depois disso nunca entrava (em 27/11/2026 a recarga de 14 dias achou 538 atendimentos que faltavam, cerca de 27% desde 16/11). Isso fazia as travas "retorno em menos de 30 dias" e "primeira consulta com a médica" enxergarem só parte do histórico.
-- Custo: 3 leituras do Klingo por dia (faixas de 14 dias), cerca de 2 s cada. Nenhum relatório novo nem editado.
-- ROLLBACK: select cron.unschedule('consulta-atendida-recarga');
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'consulta-atendida-recarga') then
    perform cron.schedule('consulta-atendida-recarga', '10 6 * * *',
      $cmd$select public.consulta_atendida_disparar((now() at time zone 'America/Sao_Paulo')::date - 30, (now() at time zone 'America/Sao_Paulo')::date - 1)$cmd$);
  end if;
end $$;
