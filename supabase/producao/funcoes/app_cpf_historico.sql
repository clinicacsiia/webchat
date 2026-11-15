-- public.app_cpf_historico(p_tel text, p_nome text, p_nasc date, p_tipo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_cpf_historico(p_tel text, p_nome text, p_nasc date, p_tipo text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select t.cpf from (
    select regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g') as cpf, 1 as ord
      from public.pacientes p
     where p_tipo = 'proprio' and p.dt_nasc = p_nasc and p.telefones && array[p_tel, '55' || p_tel] and public.app_norm(p.nome) = public.app_norm(p_nome)
    union all
    select d.cpf, 2
      from public.conversas c
      join public.contatos ct on ct.id = c.contato_id
      left join public.pre_agendamentos pa on pa.conversa_id = c.id
      left join public.conversa_fluxo cf on cf.conversa_id = c.id
      cross join lateral (values
        (regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g'), coalesce(public.app_data_flex(pa.paciente ->> 'dt_nasc'), public.app_data_flex(cf.dados -> 'digitado' ->> 'dt_nasc'))),
        (regexp_replace(coalesce(cf.dados -> 'digitado' ->> 'cpf', ''), '\D', '', 'g'), coalesce(public.app_data_flex(cf.dados -> 'digitado' ->> 'dt_nasc'), public.app_data_flex(pa.paciente ->> 'dt_nasc')))
      ) d(cpf, nasc)
     where regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g') in (p_tel, '55' || p_tel)
       and c.paciente_tipo = p_tipo
       and public.app_norm(coalesce(c.paciente_nome, ct.nome)) = public.app_norm(p_nome)
       and d.nasc = p_nasc
  ) t
  where t.cpf ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(t.cpf)
  order by t.ord limit 1 $function$;

