-- FLUXOGRAMA: entrada (a tela de entrada do chat lê `chat_config()` ao abrir) -> validação (duas chaves novas em `config`: `entrada_webchat_modo` e `entrada_previsao_modo`; ausentes ou erro de rede = como antes)
--   -> lógica (webchat ligado = formulário e botão "Começar" como sempre; previsão ligada = aparece o botão "Previsão de marcação" que leva a `previsao/`; webchat desligado + previsão ligada = SÓ o botão Previsão; os dois desligados = o webchat volta sozinho)
--   -> saída (chat_config devolve também as duas chaves) | ROLLBACK: o bloco no fim deste arquivo
-- Versão 1.0 — 17/11/2026 / Mudança: primeira versão (escolher na tela de Configurações para onde vai o paciente: webchat padrão, Previsão de marcação ou os dois botões).
--
-- Só muda o que o paciente VÊ na primeira tela. Conversa já aberta no aparelho continua abrindo direto.

insert into public.config (chave, valor) values ('entrada_webchat_modo', 'sim'), ('entrada_previsao_modo', 'nao') on conflict (chave) do nothing;

create or replace function public.chat_config() returns jsonb
language sql stable security definer set search_path = '' as $function$
  select coalesce(jsonb_object_agg(chave, valor), '{}'::jsonb)
  from public.config where chave in ('nome_empresa', 'boas_vindas', 'entrada_webchat_modo', 'entrada_previsao_modo')
$function$;

-- ROLLBACK (volta a função ao que era e apaga as chaves):
--   create or replace function public.chat_config() returns jsonb language sql stable security definer set search_path = '' as $function$
--     select coalesce(jsonb_object_agg(chave, valor), '{}'::jsonb) from public.config where chave in ('nome_empresa', 'boas_vindas') $function$;
--   delete from public.config where chave in ('entrada_webchat_modo', 'entrada_previsao_modo');
