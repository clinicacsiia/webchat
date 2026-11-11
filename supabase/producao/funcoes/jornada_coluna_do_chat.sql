-- public.jornada_coluna_do_chat(p_pre_status text, p_pre_etapa text, p_conv_status text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.jornada_coluna_do_chat(p_pre_status text, p_pre_etapa text, p_conv_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when p_pre_status = 'agendado' then 'agendado'
    when p_pre_status = 'cancelado' then 'perdido'
    when p_pre_status = 'pronto' or p_pre_etapa = 'pronto' then 'orcamento'
    when p_conv_status = 'encerrada' then 'perdido'
    else 'contato'
  end;
$function$;

