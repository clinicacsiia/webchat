-- FLUXOGRAMA: entrada (a rotina diária do pg_cron, às 03:47 de Brasília) -> validação (a função app_acesso_limpar só apaga o que tem mais de 180 dias) -> lógica (apaga o histórico de acessos antigo) -> saída (tabela app_acesso_log só com o que cabe no prazo)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (a limpeza saiu de dentro de app_acesso_gravar para não haver delete no caminho de cada entrada)
-- Já aplicada na produção em 15/11/2026 (nome da rotina: app-acesso-limpar).
--
-- Para desligar a rotina: select cron.unschedule('app-acesso-limpar');
-- Para voltar atrás: a rotina só apaga registros antigos; desligar não quebra nada.

select cron.schedule('app-acesso-limpar', '47 6 * * *', 'select public.app_acesso_limpar()');
