-- FLUXOGRAMA: entrada (o v2 já está sempre ligado: supabase/webchat-v2-sempre-ligado.sql aplicada) -> validação (nenhuma função ou tela chama as peças abaixo: conferido no retrato 1.9) -> processamento (apaga as funções de promoção, de recuo/recomendação e os apoios de "modo"; apaga as chaves de config sem efeito)
--   -> persistência (cada chave apagada fica na trilha config_auditoria, com origem e justificativa) -> saída (banco só com o que ainda tem uso)
-- Versão 1.0 — 14/11/2026 / Mudança: primeira versão. É uma LIMPEZA: não muda o comportamento (as portas já estão abertas). Contém "drop" e "delete", então o conector do Supabase pede confirmação e expira em 60 s: rodar PELO PAINEL (SQL Editor), inteiro, de uma vez.
-- Como voltar atrás: as funções apagadas estão em git no commit 17d6bc8 (supabase/producao/funcoes/<nome>.sql); as chaves apagadas ficam registradas em config_auditoria (valor_antes). Nada disso é necessário para o sistema funcionar.
--
-- O que NÃO é apagado de propósito: klingo_api_resultado (laudo, sem integração), klingo_webhook, agendamento_externo_modo e os limites agendamento_* (proteção da página pública), klingo_pos_prazo_horas, klingo_api_exame_convenio e as demais regras de negócio.

select set_config('app.origem', 'limpeza:webchat-v2-sempre-ligado', false), set_config('app.justificativa', 'Limpeza: o v2 ficou sempre ligado em 14/11/2026; as chaves de modo e a lista de teste deixaram de ter efeito.', false);

drop function if exists public.klingo_promover(text, text, text);
drop function if exists public.klingo_decidir(text, text, jsonb, text);
drop function if exists public.klingo_recomendar(text, text, jsonb, text);
drop function if exists public.klingo_chave_de_modo(text);
drop function if exists public.klingo_modo_nivel(text);
drop function if exists public.klingo_aceita_sombra(text);
drop function if exists public.klingo_modo_chave(text);
drop function if exists public.klingo_autogestao();

delete from public.config where chave in (
  'klingo_auto', 'klingo_autogestao', 'klingo_so_liberados', 'klingo_api_percentual', 'klingo_api_telefones_teste',
  'klingo_api_horarios', 'klingo_api_marcar', 'klingo_api_pre_cadastro', 'klingo_api_pos', 'klingo_api_cancelar', 'klingo_api_remarcar', 'klingo_api_consultar',
  'previsao_modo', 'previsao_monitor_modo', 'notificacao_modo');

select set_config('app.origem', '', false), set_config('app.justificativa', '', false);
