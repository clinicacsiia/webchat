-- public.klingo_modo(p_conversa uuid, p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_modo(p_conversa uuid, p_chave text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when p_chave = 'klingo_api_resultado' then case when public.klingo_cfg('klingo_api_resultado', 'nao') = 'sim' then 'sim' else 'nao' end
    when p_conversa is not null and exists (select 1 from public.conversas c where c.id = p_conversa) then 'sim'
    else 'nao' end
$function$;

