-- public.medico_detalhe(p_prof text, p_unid text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_detalhe(p_prof text, p_unid text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k record; r public.medico_regra; v_origem text; v_turnos jsonb; pn text := public.norm_nome(p_prof); v_pm integer[]; v_pu integer[];
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = pn and public.norm_nome(m.unidade) = public.norm_nome(p_unid);
  if not found then raise exception 'Médico ou unidade não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  select * into r from public.medico_regra x where public.norm_nome(x.profissional) = pn and public.norm_nome(x.unidade) = public.norm_nome(p_unid);
  select coalesce(jsonb_agg(jsonb_build_object('dia', t.dia, 'hora_ini', t.hora_ini, 'hora_fim', t.hora_fim) order by t.dia, t.hora_ini), '[]'::jsonb) into v_turnos
    from public.medico_turno t where public.norm_nome(t.profissional) = pn and public.norm_nome(t.unidade) = public.norm_nome(p_unid);
  -- Exames ligados ao médico e à unidade na agenda do Klingo: base dos filtros "deste médico" e "da unidade" na lista de convênios.
  select coalesce(array_agg(distinct a.procedimento_id), '{}') into v_pm from public.catalogo_agenda a
    where public.norm_nome(a.profissional) = pn and a.vig_fim >= current_date and a.procedimento_id is not null;
  select coalesce(array_agg(distinct a.procedimento_id), '{}') into v_pu from public.catalogo_agenda a
    where public.norm_nome(a.unidade) = public.norm_nome(p_unid) and a.vig_fim >= current_date and a.procedimento_id is not null;
  if jsonb_array_length(v_turnos) > 0 then v_origem := 'turnos';
  else
    v_origem := case when r.profissional is null then 'klingo' else 'regra' end;
    select coalesce(jsonb_agg(jsonb_build_object('dia', d, 'hora_ini', coalesce(r.hora_ini, k.hora_ini), 'hora_fim', coalesce(r.hora_fim, k.hora_fim)) order by d), '[]'::jsonb) into v_turnos
      from unnest(coalesce(r.dias, k.dias)) d where d = any(k.dias);
  end if;
  return jsonb_build_object(
    'origem', v_origem, 'turnos', v_turnos, 'nota', r.nota,
    'grade', jsonb_build_object('dias', k.dias, 'hora_ini', k.hora_ini, 'hora_fim', k.hora_fim),
    'n_procs_unidade', cardinality(v_pu),
    'particular', exists (select 1 from public.medico_particular mp where mp.profissional = pn),
    'excecoes', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'data_ini', e.data_ini, 'data_fim', e.data_fim, 'motivo', e.motivo) order by e.data_ini)
                          from public.medico_excecao e where e.profissional = pn and e.data_fim >= current_date), '[]'::jsonb),
    'convenios', coalesce((select jsonb_agg(jsonb_build_object('chave', o.ch, 'nome', o.nome, 'ativo_global', public.convenio_ativo(o.nome),
          'fora', exists (select 1 from public.medico_convenio_bloqueio b where b.profissional = pn and b.operadora = o.ch and b.procedimento_id = 0),
          -- Cobertura inferida das tabelas de preço do convênio no Klingo (catalogo_preco): o convênio tem preço para quantos exames do médico / da unidade.
          'procs_medico', coalesce((select jsonb_agg(distinct c.procedimento_id) from public.catalogo_preco c
                                    where public.convenio_chave(c.operadora) = o.ch and c.fonte = 'convenio' and c.removido_em is null and c.procedimento_id = any(v_pm)), '[]'::jsonb),
          'n_unidade', (select count(distinct c.procedimento_id) from public.catalogo_preco c
                        where public.convenio_chave(c.operadora) = o.ch and c.fonte = 'convenio' and c.removido_em is null and c.procedimento_id = any(v_pu)),
          'restricoes', coalesce((select jsonb_agg(jsonb_build_object('procedimento_id', b.procedimento_id, 'nome', coalesce(pr.nome, 'Exame ' || b.procedimento_id)) order by pr.nome)
                                  from public.medico_convenio_bloqueio b left join public.catalogo_procedimento pr on pr.id = b.procedimento_id
                                  where b.profissional = pn and b.operadora = o.ch and b.procedimento_id > 0), '[]'::jsonb)) order by o.nome)
        from (select public.convenio_chave(operadora) ch, min(operadora) nome from public.catalogo_plano
              where nullif(btrim(operadora), '') is not null and operadora !~* '^(teste|particular.*)$' group by 1) o), '[]'::jsonb),
    'procs', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'nome', q.nome, 'consulta', q.consulta) order by q.consulta desc, q.nome) from (
        select a.procedimento_id as id, min(coalesce(p.nome, a.procedimento)) as nome, bool_or(p.classe = 'CONSULTAS') as consulta
        from public.catalogo_agenda a left join public.catalogo_procedimento p on p.id = a.procedimento_id
        where public.norm_nome(a.profissional) = pn and a.vig_fim >= current_date and a.procedimento_id is not null group by a.procedimento_id) q), '[]'::jsonb));
end $function$;

