-- public.chat_exames(p_conversa uuid, p_token text, p_modalidade text, p_regiao text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_exames(p_conversa uuid, p_token text, p_modalidade text, p_regiao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_modalidade not in ('RM','TC','US','RX','MAMO','DENSITO') then raise exception 'Modalidade inválida.' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'unilateral', e.unilateral, 'bilateral', e.bilateral))
                   from public.catalogo_exames_regiao(p_modalidade, coalesce(nullif(p_regiao, ''), 'todos')) e), '[]'::jsonb);
end $function$;

