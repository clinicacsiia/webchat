-- public.jornada_marcar_tarefa(p_tarefa bigint, p_feita boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_marcar_tarefa(p_tarefa bigint, p_feita boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t public.jornada_tarefa%rowtype;
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if not public.jornada_pode() then raise exception 'Sem permissão para a Jornada.'; end if;
  select * into t from public.jornada_tarefa where id = p_tarefa for update;
  if not found then raise exception 'Tarefa não encontrada.'; end if;
  if p_feita and t.feita_em is null then
    update public.jornada_tarefa set feita_em = now(), feita_por = auth.uid() where id = t.id;
    insert into public.jornada_evento (card_id, tipo, origem, usuario, detalhe) values (t.card_id, 'tarefa', 'pessoa', auth.uid(), jsonb_build_object('acao', 'feita', 'titulo', t.titulo));
  elsif not p_feita and t.feita_em is not null then
    update public.jornada_tarefa set feita_em = null, feita_por = null where id = t.id;
    insert into public.jornada_evento (card_id, tipo, origem, usuario, detalhe) values (t.card_id, 'tarefa', 'pessoa', auth.uid(), jsonb_build_object('acao', 'reaberta', 'titulo', t.titulo));
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

