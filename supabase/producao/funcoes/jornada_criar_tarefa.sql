-- public.jornada_criar_tarefa(p_card bigint, p_titulo text, p_vence timestamp with time zone)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_criar_tarefa(p_card bigint, p_titulo text, p_vence timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_titulo text := trim(coalesce(p_titulo, ''));
  v_id bigint;
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if not public.jornada_pode() then raise exception 'Sem permissão para a Jornada.'; end if;
  if char_length(v_titulo) < 3 or char_length(v_titulo) > 200 then raise exception 'A tarefa precisa ter de 3 a 200 letras.'; end if;
  if not exists (select 1 from public.jornada_card where id = p_card) then raise exception 'Card não encontrado.'; end if;
  insert into public.jornada_tarefa (card_id, titulo, origem, criada_por, vence_em) values (p_card, v_titulo, 'pessoa', auth.uid(), p_vence) returning id into v_id;
  insert into public.jornada_evento (card_id, tipo, origem, usuario, detalhe) values (p_card, 'tarefa', 'pessoa', auth.uid(), jsonb_build_object('acao', 'criada', 'titulo', left(v_titulo, 200)));
  return v_id;
end;
$function$;

