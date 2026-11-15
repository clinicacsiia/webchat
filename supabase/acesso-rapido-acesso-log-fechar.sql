-- FLUXOGRAMA: entrada (a tabela app_acesso_log, criada pela acesso-rapido-pin-obrigatorio.sql com as permissões padrão do Supabase para anon e authenticated) -> validação (nenhuma tela lê app_* direto, só as funções SECURITY DEFINER; as outras 8 tabelas app_* já estão fechadas) -> lógica (tira todas as permissões de anon e authenticated sobre a tabela; o RLS sem regra continua) -> saída (só o dono das funções lê e grava; painel_app_acessos segue funcionando para a equipe)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial. Responde ao alerta de segurança do painel do Supabase sobre app_acesso_log (aviso informativo "RLS ativo sem regra"): além do RLS sem regra, a tabela agora também não tem permissão de tabela para o público, igual às outras tabelas app_*.
--
-- POR QUE: a tabela guarda IP, aparelho e posição aproximada do paciente. O RLS já barrava a leitura, mas as permissões padrão (SELECT, INSERT, UPDATE, DELETE, TRUNCATE...) ficaram abertas por esquecimento; as outras 8 tabelas app_* não têm nenhuma. Fechar é uma segunda trava, sem mudar nenhum comportamento.
--
-- NÃO MUDA: app_acesso_gravar (grava), app_acesso_limpar (apaga os de 180 dias), painel_app_acessos (a equipe lê). Todas são SECURITY DEFINER e rodam como o dono.
--
-- ROLLBACK (só se algum dia uma tela precisar ler a tabela direto, o que não é o plano):
--   grant select on table public.app_acesso_log to authenticated;   -- e uma regra de RLS para a equipe

revoke all on table public.app_acesso_log from anon, authenticated;
