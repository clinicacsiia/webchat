-- public.app_erro_json(p_erro text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_erro_json(p_erro text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('ok', false, 'erro', p_erro, 'mensagem', case p_erro
    when 'indisponivel' then 'O acesso rápido ainda não está disponível. Fale com a clínica.'
    when 'sessao' then 'Entre de novo com seu celular e PIN.'
    when 'bloqueado' then 'Digite seu PIN para continuar.'
    else 'Não foi possível concluir.' end) $function$;

