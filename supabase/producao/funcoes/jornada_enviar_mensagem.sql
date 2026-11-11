-- public.jornada_enviar_mensagem(p_card bigint, p_texto text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_enviar_mensagem(p_card bigint, p_texto text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_texto text := trim(coalesce(p_texto, ''));
  v_id bigint;
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if not public.jornada_pode() then raise exception 'Sem permissão para a Jornada.'; end if;
  if char_length(v_texto) < 1 or char_length(v_texto) > 2000 then raise exception 'A mensagem precisa ter de 1 a 2000 letras.'; end if;
  if not exists (select 1 from public.jornada_card where id = p_card) then raise exception 'Card não encontrado.'; end if;
  insert into public.jornada_mensagem (card_id, autor, autor_nome, texto) values (p_card, auth.uid(), public.jornada_nome_de(auth.uid()), v_texto) returning id into v_id;
  return v_id;
end;
$function$;

