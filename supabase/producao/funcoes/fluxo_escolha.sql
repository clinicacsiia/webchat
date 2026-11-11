-- public.fluxo_escolha(p_passo text, p_itens jsonb, p_extra jsonb)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.fluxo_escolha(p_passo text, p_itens jsonb, p_extra jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('tipo', 'escolha', 'passo', p_passo, 'itens', p_itens, 'multipla', false,
                            'filtro', jsonb_array_length(p_itens) > 7) || coalesce(p_extra, '{}'::jsonb)
$function$;

