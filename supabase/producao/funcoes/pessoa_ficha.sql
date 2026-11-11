-- public.pessoa_ficha(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_ficha(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'nome', case when c.paciente_tipo = 'filho' then coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), nullif(btrim(c.paciente_nome), ''))
                 else coalesce(nullif(btrim(c.nome_informado), ''), nullif(btrim(ct.nome), '')) end,
    'tipo', coalesce(c.paciente_tipo, 'proprio'),
    'fone', public.fone_chave(ct.telefone),
    'email', lower(nullif(btrim(coalesce(nullif(btrim(c.email_informado), ''), ct.email)), '')),
    'nasc', public.data_ou_nula(pa.paciente ->> 'dt_nasc'),
    'conta', c.conta_id)
  from public.conversas c join public.contatos ct on ct.id = c.contato_id
  left join public.pre_agendamentos pa on pa.conversa_id = c.id
  where c.id = p_conversa
$function$;

