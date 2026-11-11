-- public.agendamento_reconhecer_alvos(p_dias integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_reconhecer_alvos(p_dias integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', pa.id, 'conv_criada', c.criado_em, 'conv_status', c.status,
      'nome', coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), ct.nome),
      'fones', array(select distinct right(d, 8) from (select regexp_replace(coalesce(x, ''), '\D', '', 'g') as d
                                                        from unnest(array[ct.telefone, pa.paciente ->> 'celular', pa.paciente ->> 'telefone']) x) q where length(d) >= 8),
      'itens', coalesce((select jsonb_agg(i.procedimento order by i.id) from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and nullif(btrim(i.procedimento), '') is not null),
                        case when nullif(btrim(pa.procedimento), '') is not null then jsonb_build_array(pa.procedimento) else '[]'::jsonb end),
      'prontuarios', array(select distinct pr from (
          select v.prontuario as pr from public.paciente_klingo_vinculo v where v.conversa_id = any (public.pessoa_membros(pa.conversa_id)) and v.situacao = 'confere' and nullif(btrim(v.prontuario), '') is not null
          union all
          select pv.prontuario from public.pessoa_klingo_vinculo pv where pv.conversa_id = any (public.pessoa_membros(pa.conversa_id)) and nullif(btrim(pv.prontuario), '') is not null
            and pv.prontuario not like 'n:%') q))), '[]'::jsonb)
    from public.pre_agendamentos pa
    join public.conversas c on c.id = pa.conversa_id
    join public.contatos ct on ct.id = c.contato_id
   where pa.criado_em > now() - make_interval(days => least(greatest(coalesce(p_dias, 14), 1), 30))
     and pa.klingo_marcacoes is null
     and pa.status in ('pronto', 'rascunho')
     and (c.status in ('em_atendimento', 'encerrada') or (c.status = 'aguardando' and pa.status = 'pronto'))
     and (exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and nullif(btrim(i.procedimento), '') is not null) or nullif(btrim(pa.procedimento), '') is not null)
$function$;

