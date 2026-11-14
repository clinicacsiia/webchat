-- public.klingo_modo_chave(p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_modo_chave(p_chave text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when v in ('nao', 'teste', 'sombra', 'sim') then v else 'nao' end
    from (select lower(btrim(coalesce((select valor from public.config where chave = p_chave),
                                      case when p_chave in ('klingo_api_cancelar', 'klingo_api_remarcar', 'klingo_api_consultar') then (select valor from public.config where chave = 'klingo_api_pos') end,
                                      'nao'))) as v) x
$function$;

