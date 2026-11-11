-- public.consultas_da_unidade(p_catalogo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.consultas_da_unidade(p_catalogo text)
 RETURNS TABLE(id integer, rotulo text, profissionais integer, medicos text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with base as (
    select p.id, p.nome, string_agg(distinct initcap(lower(a.especialidade)), ' / ') as esp, array_agg(distinct a.profissional) as meds
    from public.catalogo_procedimento p join public.catalogo_agenda a on a.procedimento_id = p.id
    where p.ativo and p.classe = 'CONSULTAS' and a.vig_fim >= current_date
      and a.profissional !~* '(teste|^eletro)' and not public.profissional_bloqueado(a.profissional) and coalesce(a.especialidade, '') !~* 'anestesi'
      and (p_catalogo is null or a.unidade = p_catalogo)
      and not exists (select 1 from public.consulta_config cc where cc.procedimento_id = p.id and cc.oculta)
    group by p.id, p.nome),
  rot as (
    select b.*, (b.nome ~* '^consulta( medica| médica)?$') as generica,
      coalesce(nullif(btrim((select cc.rotulo from public.consulta_config cc where cc.procedimento_id = b.id)), ''), case
        when b.nome ~* '^consulta( medica| médica)?$' then 'Consulta de ' || coalesce(b.esp, 'clínica médica')
        when b.nome ~* 'teleconsulta' then 'Teleconsulta de ' || coalesce(b.esp, 'clínica médica')
        when b.nome ~* '^atendimento ambulatorial em ' then initcap(lower(regexp_replace(b.nome, '^atendimento ambulatorial em ', '', 'i')))
        else initcap(lower(b.nome)) end) as rotulo
    from base b)
  select distinct on (r.rotulo) r.id, r.rotulo, cardinality(r.meds), r.meds
  from rot r
  where not (r.generica and exists (select 1 from rot s where not s.generica and r.meds <@ s.meds))
  order by r.rotulo, cardinality(r.meds) desc, r.id;
$function$;

