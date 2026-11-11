-- public.painel_indicadores_v2(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_v2(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date := least(coalesce(p_ate, (now() at time zone 'America/Sao_Paulo')::date), (now() at time zone 'America/Sao_Paulo')::date);
  v_de date;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_ult date; v_vivo date; v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  select max(f.dia) into v_ult from public.ind_fechamento f where f.dia <= v_ate;
  v_vivo := greatest(v_de, coalesce(v_ult + 1, v_de));

  with
  p0 as (
    select dia, pessoa, teste, unidades, contatos, entrou, reentradas, transferencias from public.ind_pessoa_dia where dia between v_de and v_ate
    union all select dia, pessoa, teste, unidades, contatos, entrou, reentradas, transferencias from public.ind_calc_pessoas(v_vivo, v_ate)),
  pf as (select * from p0 where (p_incluir_teste or not teste) and (v_un is null or cardinality(unidades) = 0 or v_un = any (unidades))),
  c0 as (
    select dia, pessoa, teste, unidades, origem, motivo, cruzou, mais24, reencerrada from public.ind_conclusao_dia where dia between v_de and v_ate
    union all select dia, pessoa, teste, unidades, origem, motivo, cruzou, mais24, reencerrada from public.ind_calc_conclusoes(v_vivo, v_ate)),
  cf as (select * from c0 where (p_incluir_teste or not teste) and (v_un is null or cardinality(unidades) = 0 or v_un = any (unidades))),
  s0 as (
    select dia, pessoa, teste, unidades from public.ind_semhumano_dia where dia between v_de and v_ate
    union all select dia, pessoa, teste, unidades from public.ind_calc_semhumano(v_vivo, v_ate)),
  sf as (select * from s0 where (p_incluir_teste or not teste) and (v_un is null or cardinality(unidades) = 0 or v_un = any (unidades))),
  pu as (select x.conversa_id, x.chaves from public.painel_conversa_pessoa_un() x
          where v_un is null or x.chaves is null or cardinality(x.chaves) = 0 or v_un = any (x.chaves)),
  dias as (select d::date as dia from generate_series(v_de, v_ate, interval '1 day') d),
  pd as (select dia, count(distinct pessoa) filter (where entrou) as pessoas, coalesce(sum(reentradas), 0) as reentradas,
                count(distinct pessoa) filter (where reentradas > 0) as voltaram, coalesce(sum(transferencias), 0) as transf from pf group by dia),
  cd as (select dia, count(*) as concluidas from cf group by dia),
  sd as (select dia, count(*) as sem_humano from sf group by dia)
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate, 'fechado_ate', v_ult),
    'unidade', v_un, 'incluir_teste', coalesce(p_incluir_teste, false), 'gerado_em', now(),
    'pessoas', jsonb_build_object(
        'unicas_no_periodo', (select count(distinct pessoa) filter (where entrou) from pf),
        'soma_dos_dias', (select coalesce(sum(pessoas), 0) from pd)),
    'reentradas', jsonb_build_object(
        'total', (select coalesce(sum(reentradas), 0) from pd),
        'pessoas_que_voltaram', (select count(distinct pessoa) filter (where reentradas > 0) from pf)),
    'sem_atendimento_humano', jsonb_build_object(
        'total', (select count(*) from sf),
        'ainda_sem_pessoa_agora', (select count(*) from public.conversas c join pu on pu.conversa_id = c.id
                                    where c.primeiro_humano_em is null and (p_incluir_teste or not c.teste)
                                      and (c.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate)),
    'conclusoes', jsonb_build_object(
        'total', (select count(*) from cf),
        'por_origem', coalesce((select jsonb_object_agg(o.origem, o.n) from (select origem, count(*) as n from cf group by origem) o), '{}'::jsonb),
        'por_motivo', coalesce((select jsonb_object_agg(m.motivo, m.n) from (select motivo, count(*) as n from cf group by motivo) m), '{}'::jsonb),
        'cruzaram_meia_noite', (select count(*) filter (where cruzou) from cf),
        'mais_de_24h', (select count(*) filter (where mais24) from cf),
        'reencerradas', (select count(*) filter (where reencerrada) from cf)),
    'transferencias', (select coalesce(sum(transf), 0) from pd),
    'agora', jsonb_build_object(
        'aguardando', (select count(*) from public.conversas c join pu on pu.conversa_id = c.id where c.status = 'aguardando' and (p_incluir_teste or not c.teste)),
        'em_atendimento', (select count(*) from public.conversas c join pu on pu.conversa_id = c.id where c.status = 'em_atendimento' and (p_incluir_teste or not c.teste))),
    'testes', jsonb_build_object('conversas_criadas_no_periodo', (select count(*) from public.conversas c where c.teste and (c.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate)),
    'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', d.dia, 'pessoas', coalesce(pd.pessoas, 0), 'reentradas', coalesce(pd.reentradas, 0),
              'pessoas_que_voltaram', coalesce(pd.voltaram, 0), 'sem_humano', coalesce(sd.sem_humano, 0), 'concluidas', coalesce(cd.concluidas, 0),
              'transferencias', coalesce(pd.transf, 0), 'fechado', (v_ult is not null and d.dia <= v_ult)) order by d.dia)
            from dias d left join pd on pd.dia = d.dia left join sd on sd.dia = d.dia left join cd on cd.dia = d.dia), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $function$;

