-- public.pre_pendencia_anterior(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pre_pendencia_anterior(p_conversa uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pa.conversa_id
  from public.conversas atual
  join public.contatos ca on ca.id = atual.contato_id
  join public.conversas c2 on c2.contato_id = atual.contato_id and c2.id <> atual.id
  join public.contatos cb on cb.id = c2.contato_id
  join public.pre_agendamentos pa on pa.conversa_id = c2.id
  where atual.id = p_conversa and pa.status in ('rascunho','pronto') and pa.atualizado_em > now() - interval '7 days'
    and public.nome_confere(coalesce(atual.nome_informado, ca.nome), coalesce(c2.nome_informado, cb.nome))
    and lower(coalesce(nullif(btrim(case when atual.nome_informado is not null then atual.email_informado else ca.email end), ''), ''))
      = lower(coalesce(nullif(btrim(case when c2.nome_informado is not null then c2.email_informado else cb.email end), ''), ''))
    and c2.paciente_tipo = atual.paciente_tipo
    and (atual.paciente_tipo <> 'filho' or public.nome_confere(
          coalesce((select nullif(btrim(x.paciente ->> 'nome'), '') from public.pre_agendamentos x where x.conversa_id = atual.id), atual.paciente_nome),
          coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), c2.paciente_nome)))
    and exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is not null)
  order by pa.atualizado_em desc limit 1
$function$;

