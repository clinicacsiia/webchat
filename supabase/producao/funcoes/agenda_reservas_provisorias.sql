-- public.agenda_reservas_provisorias(p_ignorar uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_reservas_provisorias(p_ignorar uuid DEFAULT NULL::uuid)
 RETURNS TABLE(inicio timestamp without time zone, fim timestamp without time zone, profissional text, unidade text, local text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (e ->> 'data')::date + (e ->> 'hora')::time,
         (e ->> 'data')::date + (e ->> 'hora')::time + make_interval(mins => coalesce((e ->> 'min')::int, 30)),
         public.norm_nome(e ->> 'profissional'), public.norm_nome(e ->> 'unidade'), e ->> 'local'
  from public.pre_agendamentos pa, jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e
  where pa.conversa_id is distinct from p_ignorar
    and ((pa.status = 'pronto' and pa.atualizado_em > now() - interval '48 hours')
      or (pa.status = 'rascunho' and pa.atualizado_em > now() - interval '90 minutes')
      or (pa.status = 'agendado' and pa.atualizado_em > now() - interval '20 minutes'))
    and coalesce((e ->> 'chegada')::boolean, false) = false
$function$;

