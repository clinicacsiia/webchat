-- public.painel_indicadores_conferencia(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated
CREATE OR REPLACE FUNCTION public.painel_indicadores_conferencia(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_out jsonb;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;

  with
  k as materialized (
    select k.*, e.status as st_banco, (c.id is not null) as tem_conversa
      from public.klingo_conferencia k
      left join public.jornada_exame e on e.marcacao_id = 'm' || k.m
      left join public.conversas c on c.id = k.conversa_id
     where k.marcado_em between v_de and v_ate
       and (v_un is null or k.unidade is null or k.unidade = v_un)
       and (p_incluir_teste or c.id is null or not c.teste)),
  pu as (select x.conversa_id, x.pessoa from public.painel_conversa_pessoa_un() x
          where v_un is null or x.chaves is null or cardinality(x.chaves) = 0 or v_un = any (x.chaves)),
  cv as (select c.id, pu.pessoa, c.primeiro_humano_em from public.conversas c join pu on pu.conversa_id = c.id
          where (p_incluir_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
  perd as (
    select pa.id as pre_id, pa.conversa_id, pa.atualizado_em from public.pre_agendamentos pa join cv on cv.id = pa.conversa_id
     where pa.status = 'agendado' and coalesce(cardinality(pa.klingo_marcacoes), 0) = 0
       and not exists (select 1 from public.klingo_conferencia z where z.conversa_id = pa.conversa_id)),
  dias as (select d::date as d from generate_series(v_de, v_ate, interval '1 day') d)
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'ultima_leitura', (select max(lido_em) from k),
    'dias_sem_leitura', coalesce((select jsonb_agg(d.d order by d.d) from dias d where not exists (select 1 from k where k.marcado_em = d.d)), '[]'::jsonb),
    'total', (select count(*) from k),
    'por_origem', coalesce((select jsonb_object_agg(o, n) from (select origem as o, count(*) as n from k group by 1) q), '{}'::jsonb),
    'por_status', coalesce((select jsonb_object_agg(coalesce(s, 'sem_status'), n) from (select status_klingo as s, count(*) as n from k group by 1) q), '{}'::jsonb),
    'explicacao', (select jsonb_build_object(
        'no_banco', count(*) filter (where st_banco is not null),
        'fora_do_banco', count(*) filter (where st_banco is null),
        'remarcadas', count(*) filter (where st_banco = 'remarcado'),
        'novas_marcacoes_indicador', count(*) filter (where st_banco is not null and st_banco <> 'remarcado'),
        'canceladas_no_klingo', count(*) filter (where status_klingo = 'Cancelada')) from k),
    'webchat', jsonb_build_object(
        'marcacoes_ligadas', (select count(*) from k where tem_conversa),
        'conversas_ligadas', (select count(distinct conversa_id) from k where tem_conversa),
        'por_ligacao', coalesce((select jsonb_object_agg(ligacao, n) from (select ligacao, count(*) as n from k where tem_conversa group by 1) q), '{}'::jsonb),
        'por_origem', coalesce((select jsonb_object_agg(o, n) from (select origem as o, count(*) as n from k where tem_conversa group by 1) q), '{}'::jsonb),
        'exames', (select jsonb_build_object(
            'atendido', count(*) filter (where st_banco = 'atendido'), 'faltou', count(*) filter (where st_banco = 'faltou'),
            'por_vir', count(*) filter (where st_banco in ('agendado', 'confirmado')), 'cancelado_ou_remarcado', count(*) filter (where st_banco in ('cancelado', 'remarcado')),
            'ainda_fora_do_banco', count(*) filter (where st_banco is null)) from k where tem_conversa),
        'pessoas_que_procuraram', (select count(distinct pessoa) from cv),
        'atendidas_pela_equipe', (select count(distinct pessoa) from cv where primeiro_humano_em is not null),
        'com_pedido_pronto', (select count(distinct cv.pessoa) from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id where pa.status in ('pronto', 'agendado')),
        'agendaram_no_chat', (select count(distinct cv.pessoa) from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id where pa.status = 'agendado'),
        'agendaram_e_ligadas_ao_klingo', (select count(distinct cv.pessoa) from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id
                                           where pa.status = 'agendado' and (coalesce(cardinality(pa.klingo_marcacoes), 0) > 0 or exists (select 1 from public.klingo_conferencia z where z.conversa_id = pa.conversa_id))),
        'agendadas_sem_marcacao_no_klingo', (select count(distinct conversa_id) from perd)),
    'qualidade_klingo', jsonb_build_object(
        'sem_cpf', (select count(*) from k where 'cpf' = any (vazios)), 'sem_email', (select count(*) from k where 'email' = any (vazios)),
        'sem_celular', (select count(*) from k where 'celular' = any (vazios))),
    'problemas', jsonb_build_object(
        'conflito', (select count(*) from k where cardinality(conflito) > 0),
        'dado_faltando', (select count(*) from k where cardinality(falta_no_klingo) > 0),
        'responsavel_diferente_esperado', (select count(*) from k where cardinality(responsavel_diferente) > 0 and cardinality(conflito) = 0),
        'filho_nos_ligados', (select count(*) from k where tem_conversa and paciente_tipo = 'filho')),
    'lista_problemas', coalesce((select jsonb_agg(x order by x ->> 'marcado_em' desc, x ->> 'm') from (
        select jsonb_build_object('m', k.m, 'marcado_em', k.marcado_em, 'origem', k.origem, 'status', k.status_klingo, 'conversa_id', k.conversa_id, 'nome', public.pessoa_ficha(k.conversa_id) ->> 'nome',
               'tipo', k.paciente_tipo, 'conflito', k.conflito, 'falta_no_klingo', k.falta_no_klingo, 'responsavel_diferente', k.responsavel_diferente) as x
          from k where cardinality(k.conflito) > 0 or cardinality(k.falta_no_klingo) > 0 order by k.marcado_em desc, k.m limit 200) q), '[]'::jsonb),
    'lista_ligadas', coalesce((select jsonb_agg(x order by x ->> 'marcado_em' desc, x ->> 'm') from (
        select jsonb_build_object('m', k.m, 'marcado_em', k.marcado_em, 'origem', k.origem, 'ligacao', k.ligacao, 'conversa_id', k.conversa_id, 'nome', public.pessoa_ficha(k.conversa_id) ->> 'nome',
               'tipo', k.paciente_tipo, 'exame', coalesce(k.st_banco, 'fora_do_banco'), 'status', k.status_klingo,
               'problema', (cardinality(k.conflito) > 0 or cardinality(k.falta_no_klingo) > 0)) as x
          from k where k.tem_conversa order by k.marcado_em desc, k.m limit 300) q), '[]'::jsonb),
    'lista_sem_marcacao', coalesce((select jsonb_agg(x order by x ->> 'atualizado_em' desc) from (
        select jsonb_build_object('conversa_id', p.conversa_id, 'nome', public.pessoa_ficha(p.conversa_id) ->> 'nome', 'atualizado_em', p.atualizado_em) as x from perd p order by p.atualizado_em desc limit 100) q), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $function$;

