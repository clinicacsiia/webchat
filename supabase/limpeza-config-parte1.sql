-- FLUXOGRAMA: entrada (4 chaves da tabela config que NENHUMA função, rotina, Edge Function ou tela lê) -> validação (conferido na produção em 18/11/2026: nenhuma função cita a chave, `cron.job` não cita, a única função que escreve 'motor' é o gatilho que grava sempre 'fluxo')
--   -> lógica (apaga as 4 linhas; o gatilho config_auditar_trg guarda o valor antigo em config_auditoria) -> saída (a tela Configurações deixa de mostrar "Assistente automático ligado", "Motor" e "Telefones de teste")
-- Versão 1.0 — 18/11/2026 / Mudança: Implementação inicial. Pedido do dono: apagar o que não é usado nas Configurações.
-- Chaves apagadas: ia_ativa (a tela dizia "desligado: tudo vai para a equipe", mas nada lia a chave), motor (o gatilho conversas_motor_trg grava sempre 'fluxo'), motor_telefones_teste (ninguém lê), previsao_texto (texto que nenhuma tela usa mais).
-- NÃO apagada de propósito: base_antes_programa (números do Klingo medidos em 17/11/2026; ainda sem leitor, mas é dado, não configuração velha) e klingo_exames_* (são lidas por klingo_exame_oferecido e klingo_exames_sondar, e a rotina klingo-sondar-exames roda a cada 5 min).
-- Sem "drop": só delete de linhas. Idempotente (rodar de novo não faz nada).
-- ROLLBACK: supabase/limpeza-config-rollback.sql (valores antigos também ficam em public.config_auditoria).

delete from public.config
 where chave in ('ia_ativa', 'motor', 'motor_telefones_teste', 'previsao_texto');
