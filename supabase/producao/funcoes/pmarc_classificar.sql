-- public.pmarc_classificar(p_texto text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_classificar(p_texto text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  with t as (
    select ' ' || regexp_replace(lower(translate(btrim(coalesce(p_texto, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn')), '[^a-z0-9]+', ' ', 'g') || ' ' as x)
  select case
    when x ~ ' (nao sei|n sei|nn sei|sei la|nao lembro|nao tenho certeza|nao tenho ideia|nao faco ideia|seguimos|segue|seguir|pode seguir|vamos seguir|tanto faz|talvez|depois vejo) ' then 'nao_sei'
    when x ~ ' (nao|errado|errada|incorreto|incorreta|diferente|outro|outra) ' then 'nao'
    when x ~ ' (sim|certo|certa|correto|correta|isso|confirmo|confirmado|ok|exato|exatamente) ' then 'sim'
  end
  from t
$function$;

