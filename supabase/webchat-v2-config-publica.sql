-- Fluxo: Entrada (decisão do dono de 14/11/2026: agendamento automático para TODOS os pacientes) → Validação (cada chave é gravada separada, com justificativa e origem) → Processamento (modo "sim" por capacidade, 100 % das conversas)
--        → Persistência (public.config + trilha em public.config_auditoria) → Saída (a nova versão atende o público inteiro, sem lista de telefones).
-- Versão 1.0 — 14/11/2026 / Mudança: primeira versão. NÃO APLICADA. Rodar SÓ depois de: (1) as migrações partes 1, 2, 3, 4 e 5; (2) a publicação das Edge Functions (chat-agenda-api v2, klingo-executar v1.1, disponibilidade-vigia);
--   (3) a publicação da tela; (4) o piloto com o paciente de teste. Cada linha é independente: para deixar uma capacidade de fora, apague a linha. Para voltar ao estado anterior, veja o bloco de reversão no fim.
-- Por que existe: na nova lógica de chaves o mestre `klingo_auto` NUNCA promove "teste"/"sombra" para "sim" (o comportamento antigo, em que promovia, era o risco R2). Para o público inteiro cada capacidade precisa estar em "sim".
-- O que fica de fora de propósito: klingo_api_resultado (não existe integração), klingo_webhook (o Klingo ainda não cadastrou a URL), klingo_auto (continua "sim").

select set_config('app.origem', 'config-publica:webchat-v2', false),
       set_config('app.justificativa', 'Decisão do dono (14/11/2026): agendamento automático liberado para todos os pacientes, uma capacidade por vez, depois do piloto.', false);

insert into public.config (chave, valor) values
  ('klingo_api_percentual',   '100'),   -- todas as conversas
  ('klingo_api_horarios',     'sim'),   -- calendário só com horários que a API do Klingo devolve
  ('klingo_api_marcar',       'sim'),   -- marcação automática (confirmação, idempotência e comprovante já existem)
  ('klingo_api_pre_cadastro', 'sim'),   -- paciente novo (pré-cadastro); apague esta linha para deixar paciente novo com a equipe
  ('klingo_api_consultar',    'sim'),   -- ver minhas marcações
  ('klingo_api_cancelar',     'sim'),   -- cancelar (regra de 24 h)
  ('klingo_api_remarcar',     'sim'),   -- remarcar (marcação nova com o voucher antigo; o executor confere o antigo)
  ('previsao_modo',           'sim'),   -- solicitação de disponibilidade futura
  ('previsao_monitor_modo',   'sim'),   -- motor que procura vagas na API (consome a cota; começar em "sombra" por 24 h é o recomendado)
  ('notificacao_modo',        'sim')    -- aviso de vaga no chat (só para quem autorizou)
on conflict (chave) do update set valor = excluded.valor;

select set_config('app.origem', '', false), set_config('app.justificativa', '', false);

-- REVERSÃO (volta cada capacidade para o modo de teste; o mestre klingo_auto = nao desliga tudo de uma vez):
--   update public.config set valor = 'teste' where chave in ('klingo_api_horarios','klingo_api_marcar','klingo_api_pre_cadastro','klingo_api_consultar','klingo_api_cancelar','klingo_api_remarcar','previsao_modo','notificacao_modo');
--   update public.config set valor = 'sombra' where chave = 'previsao_monitor_modo';
