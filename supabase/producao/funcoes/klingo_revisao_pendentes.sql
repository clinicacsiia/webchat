-- public.klingo_revisao_pendentes(p_limite integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_revisao_pendentes(p_limite integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with fontes as (
    select regexp_replace(coalesce(paciente ->> 'cpf', ''), '\D', '', 'g') as cpf, public.fluxo_ler_data(paciente ->> 'dt_nasc') as nasc from public.pre_agendamentos
    union
    select regexp_replace(coalesce(cpf, ''), '\D', '', 'g'), dt_nasc from public.pacientes
  ), validos as (
    select distinct cpf, nasc from fontes where nasc between date '1900-01-01' and current_date and public.fluxo_cpf_ok(cpf)
  ), pend as (
    select v.cpf, v.nasc from validos v left join public.klingo_identidade i on i.chave = public.klingo_hash(v.cpf || '|' || v.nasc::text)
     where i.id is null or (i.situacao = 'erro' and i.conferido_em < now() - interval '30 minutes')
     order by v.nasc, v.cpf limit least(greatest(coalesce(p_limite, 25), 1), 100)
  )
  select coalesce(jsonb_agg(jsonb_build_object('cpf', cpf, 'nascimento', nasc)), '[]'::jsonb) from pend
$function$;

