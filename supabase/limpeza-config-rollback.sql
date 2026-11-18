-- ROLLBACK de supabase/limpeza-config-parte1.sql e parte2.sql (18/11/2026): recria as chaves apagadas com o valor que tinham e a função painel_automacao_resumo como era.
-- Os valores antigos também ficam em public.config_auditoria (operacao = 'delete'). O valor de motor_telefones_teste não é repetido aqui (era um telefone de teste): volte vazio ou use a auditoria.
-- Depois de voltar o banco, volte também o painel (painel/index.html da versão que tirou os controles) para os campos aparecerem de novo.

-- chamada 1 de 3: chaves da parte 1
insert into public.config (chave, valor) values
  ('ia_ativa', 'sim'), ('motor', 'fluxo'), ('motor_telefones_teste', ''),
  ('previsao_texto', 'Os dias e horários que mostramos aqui são sugestões para facilitar a sua escolha. Quem confirma o seu agendamento é uma pessoa da nossa equipe.')
on conflict (chave) do nothing;

-- chamada 2 de 3: chaves da parte 2
insert into public.config (chave, valor) values
  ('klingo_auto', 'sim'), ('klingo_api_horarios', 'sim'), ('klingo_api_marcar', 'sim'), ('klingo_api_pre_cadastro', 'sim'), ('klingo_api_consultar', 'sim'),
  ('klingo_api_cancelar', 'sim'), ('klingo_api_remarcar', 'sim'), ('klingo_api_pos', 'teste'), ('klingo_api_percentual', '100'), ('klingo_autogestao', 'sim'),
  ('previsao_modo', 'sim'), ('previsao_monitor_modo', 'sim'), ('notificacao_modo', 'sim')
on conflict (chave) do nothing;

-- chamada 3 de 3: a função como era (a definição está em supabase/producao/funcoes/painel_automacao_resumo.sql, no git antes deste commit):
--   git show <commit anterior>:supabase/producao/funcoes/painel_automacao_resumo.sql
