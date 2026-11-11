-- public.consultas_config_listar()
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.consultas_config_listar()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'nome_klingo', x.nome, 'rotulo_automatico', x.auto, 'rotulo', x.rotulo,
      'oculta', x.oculta, 'unidades', x.unidades, 'medicos', x.meds) order by x.oculta, x.auto)
    from (
      select p.id, p.nome,
        case when p.nome ~* '^consulta( medica| médica)?$' then 'Consulta de ' || coalesce(string_agg(distinct initcap(lower(a.especialidade)), ' / '), 'clínica médica')
             when p.nome ~* 'teleconsulta' then 'Teleconsulta de ' || coalesce(string_agg(distinct initcap(lower(a.especialidade)), ' / '), 'clínica médica')
             when p.nome ~* '^atendimento ambulatorial em ' then initcap(lower(regexp_replace(p.nome, '^atendimento ambulatorial em ', '', 'i')))
             else initcap(lower(p.nome)) end as auto,
        cc.rotulo, coalesce(cc.oculta, false) as oculta,
        array_agg(distinct a.unidade) as unidades, array_agg(distinct a.profissional) as meds
      from public.catalogo_procedimento p
      join public.catalogo_agenda a on a.procedimento_id = p.id
      left join public.consulta_config cc on cc.procedimento_id = p.id
      where p.ativo and p.classe = 'CONSULTAS' and a.vig_fim >= current_date
        and a.profissional !~* '(teste|^eletro)' and not public.profissional_bloqueado(a.profissional) and coalesce(a.especialidade, '') !~* 'anestesi'
      group by p.id, p.nome, cc.rotulo, cc.oculta) x), '[]'::jsonb);
end $function$;

