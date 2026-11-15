-- public.app_conta_antiga_historico_filhos(p_conta uuid)
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.app_conta_antiga_historico_filhos(p_conta uuid)
 RETURNS TABLE(nome text, chave text, nasc date, cpf text, atendimentos integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (array_agg(x.nome order by x.criado_em desc))[1], x.chave,
         (array_agg(x.nasc order by x.criado_em desc) filter (where x.nasc is not null))[1],
         (array_agg(x.cpf order by x.criado_em desc) filter (where x.cpf is not null))[1],
         count(distinct x.conversa)::integer
  from (
    select c.id as conversa, c.criado_em, btrim(regexp_replace(c.paciente_nome, '\s+', ' ', 'g')) as nome, public.app_norm(c.paciente_nome) as chave,
           coalesce(public.app_data_flex(pa.paciente ->> 'dt_nasc'), public.app_data_flex(cf.dados -> 'digitado' ->> 'dt_nasc')) as nasc,
           (select d from (values (regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g')), (regexp_replace(coalesce(cf.dados -> 'digitado' ->> 'cpf', ''), '\D', '', 'g'))) v(d)
             where d ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(d) limit 1) as cpf
    from public.conversas c
    left join public.pre_agendamentos pa on pa.conversa_id = c.id
    left join public.conversa_fluxo cf on cf.conversa_id = c.id
    where c.conta_id = p_conta and c.paciente_tipo = 'filho' and public.app_nome_ok(c.paciente_nome)
  ) x group by x.chave $function$;

