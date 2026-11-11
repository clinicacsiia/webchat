-- public.jornada_anotar_card(p_card bigint, p_nota text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_anotar_card(p_card bigint, p_nota text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_nota text := nullif(trim(coalesce(p_nota, '')), '');
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if not public.jornada_pode() then raise exception 'Sem permissão para a Jornada.'; end if;
  if v_nota is null then raise exception 'Escreva a observação.'; end if;
  if not exists (select 1 from public.jornada_card where id = p_card) then raise exception 'Card não encontrado.'; end if;
  insert into public.jornada_evento (card_id, tipo, origem, usuario, detalhe)
  values (p_card, 'nota', 'pessoa', auth.uid(), jsonb_build_object('nota', left(v_nota, 1000)));
  return jsonb_build_object('ok', true);
end $function$;

