-- public.fluxo_rotulo_item(p_conversa uuid, p_proc integer, p_nome text, p_mod text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_rotulo_item(p_conversa uuid, p_proc integer, p_nome text, p_mod text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    case when p_mod = 'CONSULTA' then (select x.rotulo from public.conversas c
                                        cross join lateral public.consultas_da_unidade((select u.catalogo from public.unidade_config u where u.chave = c.unidade_inicial)) x
                                        where c.id = p_conversa and x.id = p_proc limit 1) end,
    initcap(lower(p_nome)), p_mod)
$function$;

