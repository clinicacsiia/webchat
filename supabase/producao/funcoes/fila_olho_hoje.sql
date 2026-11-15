-- public.fila_olho_hoje()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_olho_hoje()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.fila_exige_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', t.fila_id, 'marcacoes', t.m))
      from (
        select fila_id,
               jsonb_agg(jsonb_build_object('marcacao', marcacao_id, 'atendimento', atendimento_id, 'status', status_agora, 'situacao', situacao_jornada, 'exame', procedimento)) filter (where marcacao_id is not null) as m
          from public.v_olho_fila
         where fila_status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) = public.fila_dia(now())
         group by fila_id
      ) t
     where t.m is not null), '[]'::jsonb);
end $function$;

