-- public.pmarc_itens(p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_itens(p_chave text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('quando', x.agendado_para, 'procedimento', x.procedimento, 'unidade', x.unidade,
           'tipo', public.pmarc_tipo(x.procedimento), 'status', x.status, 'confirmacao', x.confirm_status) order by x.agendado_para), '[]'::jsonb)
  from (
    select e.agendado_para, e.procedimento, e.unidade, e.status, e.confirm_status
    from public.jornada_exame e join public.jornada_card c on c.id = e.card_id
    where c.paciente_chave = p_chave and e.status in ('agendado', 'confirmado') and e.agendado_para >= now() - interval '3 hours'
    order by e.agendado_para limit 30
  ) x
$function$;

