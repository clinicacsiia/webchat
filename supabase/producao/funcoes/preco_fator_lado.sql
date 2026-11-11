-- public.preco_fator_lado(p_lado text, p_nome text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.preco_fator_lado(p_lado text, p_nome text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when p_lado is distinct from 'A' then 1
    when public.norm_chave(p_nome) ~ 'BILATERAL' then 1
    when public.norm_chave(p_nome) ~ 'UNILATERAL|POR ARTICULACAO' then 2
    else null end
$function$;

