-- public.fluxo_norm_exame(t text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.fluxo_norm_exame(t text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    coalesce(public.norm_nome(t), ''),
    '\m(RESSONANCIA|RESONANCIA|RESSONANSIA|RNM|RMN)( MAGNETICA)?\M', 'RM', 'g'),
    '\m(TOMOGRAFIA|TOMO)( COMPUTADORIZADA)?\M', 'TC', 'g'),
    '\m(ULTRASSONOGRAFIA|ULTRASONOGRAFIA|ULTRASSOM|ULTRASOM|ULTRA SOM|ECOGRAFIA|USG|ULTRA)\M', 'US', 'g'),
    '\m(RAIO X|RAIOX|RAIO|RADIOGRAFIA|RAIOS X)\M', 'RX', 'g'),
    '\m(DE|DO|DA|DOS|DAS|E|EM|COM|SEM|PARA|P)\M', ' ', 'g')
$function$;

