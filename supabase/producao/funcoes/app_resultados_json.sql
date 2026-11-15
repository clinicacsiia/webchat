-- public.app_resultados_json(p_pac uuid)
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.app_resultados_json(p_pac uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'pessoa', ac.pessoa_nome, 'eu', ac.eu, 'nome', e.procedimento, 'data_exame', to_char(e.agendado_para at time zone 'America/Bahia', 'YYYY-MM-DD'),
           'entregue_em', r.entregue_em, 'tem_arquivo', r.anexo_id is not null, 'arquivo_nome', x.nome, 'conversa', r.conversa_resultado_id) order by r.entregue_em desc), '[]'::jsonb)
    from public.app_resultado r
    join public.app_conversa ac on ac.paciente_id = r.paciente_id and ac.conversa_id = r.conversa_id
    left join public.jornada_exame e on e.id = r.exame_id
    left join public.conversa_anexo x on x.id = r.anexo_id
   where r.paciente_id = p_pac and r.estado = 'entregue'
$function$;

