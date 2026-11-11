-- public.catalogo_cardapio(p_busca text, p_operadora text, p_filtro text, p_limite integer, p_deslocamento integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.catalogo_cardapio(p_busca text DEFAULT NULL::text, p_operadora text DEFAULT NULL::text, p_filtro text DEFAULT NULL::text, p_limite integer DEFAULT 40, p_deslocamento integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  return public.catalogo_cardapio_dados(p_busca, p_operadora, p_filtro, p_limite, p_deslocamento, 10);
end $function$;

