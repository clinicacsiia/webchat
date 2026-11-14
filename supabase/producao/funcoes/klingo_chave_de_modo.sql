-- public.klingo_chave_de_modo(p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_chave_de_modo(p_chave text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$ select p_chave in ('klingo_auto', 'klingo_api_horarios', 'klingo_api_marcar', 'klingo_api_pre_cadastro', 'klingo_api_pos', 'klingo_api_cancelar', 'klingo_api_remarcar', 'klingo_api_consultar',
                                  'klingo_api_resultado', 'klingo_webhook', 'previsao_modo', 'previsao_monitor_modo', 'notificacao_modo', 'pedido_horario_modo') $function$;

