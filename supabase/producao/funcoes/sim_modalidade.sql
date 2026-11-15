-- public.sim_modalidade(p_proc text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.sim_modalidade(p_proc text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when p_proc is null then null
    when p_proc ~* 'histeroscop' then 'histero'
    when p_proc ~* 'densitom' then 'dmo'
    when p_proc ~* 'mamograf' then 'mamo'
    when p_proc ~* 'ecodoppler|ecocardio|eletrocardio|\mecg\M' then 'eco'
    when p_proc ~* 'histerossalping|uretrocisto|enema|clister|esofago|esôfago|escanometria|\mrx\M|radiograf' then 'rx'
    when p_proc ~* '\mrm\M|resson|angiorm' then 'rm'
    when p_proc ~* '\mtc\M|tomograf' then 'tc'
    when p_proc ~* '\mus\M|\musg\M|ultra|doppler|elastograf|transvaginal' then 'us'
    when p_proc ~* 'consulta|atendimento|preventivo|eletroencefal|\meeg' then 'consulta'
    else null end
$function$;

