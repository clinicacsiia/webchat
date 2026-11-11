-- public.encerramentos_resumo(p_dias integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.encerramentos_resumo(p_dias integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_desde timestamptz := case when coalesce(p_dias, 30) <= 0 then '-infinity'::timestamptz else now() - make_interval(days => least(p_dias, 3650)) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return jsonb_build_object('dias', coalesce(p_dias, 30),
    'total', (select count(*) from public.conversa_encerramento where encerrada_em >= v_desde),
    'automaticos', (select count(*) from public.conversa_encerramento where encerrada_em >= v_desde and origem = 'inatividade'),
    'por_motivo', coalesce((select jsonb_object_agg(m, n) from (select coalesce(motivo, 'sem_motivo') m, count(*) n from public.conversa_encerramento where encerrada_em >= v_desde group by 1) x), '{}'::jsonb));
end $function$;

