-- public.fila_minha_vez()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_minha_vez()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); r public.fila_chegada%rowtype; v_total int;
begin
  if v_uid is null then raise exception 'Entre na sua conta para ver a fila.' using errcode = '28000'; end if;
  select * into r from public.fila_chegada where conta_id = v_uid and status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) = public.fila_dia(now())
   order by chegou_em desc limit 1;
  select count(*)::int into v_total from public.fila_chegada where status = 'aguardando' and public.fila_dia(chegou_em) = public.fila_dia(now());
  if r.id is null then
    if exists (select 1 from public.fila_chegada where conta_id = v_uid and status = 'atendido' and concluido_em > now() - interval '3 hours') then
      return jsonb_build_object('situacao', 'atendido', 'total', v_total);
    end if;
    return jsonb_build_object('situacao', 'fora', 'total', v_total,
      'pode_chegar', coalesce((select valor from public.config where chave = 'fila_autochegada'), 'sim') = 'sim');
  end if;
  if r.status = 'chamado' then
    return jsonb_build_object('situacao', 'chamado', 'senha', r.senha, 'total', v_total);
  end if;
  return jsonb_build_object('situacao', 'aguardando', 'senha', r.senha, 'posicao', public.fila_posicao(r.id), 'a_frente', public.fila_posicao(r.id) - 1, 'total', v_total);
end $function$;

