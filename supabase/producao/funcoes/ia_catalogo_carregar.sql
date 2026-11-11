-- public.ia_catalogo_carregar(p_segredo text, p_tipo text, p_linhas jsonb, p_anexar boolean)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.ia_catalogo_carregar(p_segredo text, p_tipo text, p_linhas jsonb, p_anexar boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_seg text;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then
    raise exception 'Não autorizado.' using errcode = '28000';
  end if;
  return public.catalogo_substituir(p_tipo, p_linhas, p_anexar);
end $function$;

