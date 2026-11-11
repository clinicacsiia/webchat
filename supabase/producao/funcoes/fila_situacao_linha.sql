-- public.fila_situacao_linha(r fila_chegada)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_situacao_linha(r fila_chegada)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_total int; v_extra jsonb;
begin
  select count(*)::int into v_total from public.fila_chegada where status = 'aguardando' and public.fila_dia(chegou_em) = public.fila_dia(now());
  v_extra := jsonb_build_object('conta_pronta', r.conta_id is not null, 'email', case when r.conta_id is not null then r.email end, 'pede_senha', r.pede_senha);
  if r.status = 'chamado' and public.fila_dia(r.chegou_em) = public.fila_dia(now()) then
    return jsonb_build_object('situacao', 'chamado', 'senha', r.senha, 'total', v_total) || v_extra;
  elsif r.status = 'aguardando' and public.fila_dia(r.chegou_em) = public.fila_dia(now()) then
    return jsonb_build_object('situacao', 'aguardando', 'senha', r.senha, 'posicao', public.fila_posicao(r.id), 'a_frente', public.fila_posicao(r.id) - 1, 'total', v_total) || v_extra;
  elsif r.status = 'atendido' and r.concluido_em > now() - interval '3 hours' then
    return jsonb_build_object('situacao', 'atendido', 'total', v_total) || v_extra;
  end if;
  return jsonb_build_object('situacao', 'fora', 'total', v_total);
end $function$;

