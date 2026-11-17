-- public.ind_decisao_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_decisao_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_chat jsonb;
begin
  with
  pu as (select x.conversa_id, x.pessoa from public.painel_conversa_pessoa_un() x
          where p_un is null or x.chaves is null or cardinality(x.chaves) = 0 or p_un = any (x.chaves)),
  cv as (select c.id, pu.pessoa, c.criado_em, c.primeiro_humano_em, c.status, c.motivo_encerramento
           from public.conversas c join pu on pu.conversa_id = c.id
          where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  pr as (select cv.pessoa,
                max(case pa.status when 'agendado' then 8 when 'pronto' then 7
                      else case pa.etapa when 'pedido' then 1 when 'plano' then 2 when 'preferencias' then 3 when 'data_hora' then 4
                                         when 'dados' then 5 when 'confirmacao' then 6 when 'pronto' then 7 else 1 end end) as r,
                bool_or(pa.tipo = 'exame') as t_ex, bool_or(pa.tipo = 'consulta') as t_co
           from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id group by cv.pessoa),
  ult as (select distinct on (cv.pessoa) cv.pessoa, cv.status as ult_status, cv.motivo_encerramento as ult_motivo from cv order by cv.pessoa, cv.criado_em desc),
  ag as (select cv.pessoa, bool_or(cv.primeiro_humano_em is not null) as humano, bool_or(cv.motivo_encerramento = 'agendado') as marcou_motivo from cv group by cv.pessoa),
  pes as (select ag.pessoa, ag.humano, case when pr.t_ex then 'exame' when pr.t_co then 'consulta' end as tipo,
                 case when coalesce(pr.r, 0) = 8 or ag.marcou_motivo then 8 else coalesce(pr.r, 0) end as er,
                 case when not ag.humano then 'sem_equipe'
                      when ult.ult_status <> 'encerrada' then 'em_andamento'
                      else coalesce(nullif(ult.ult_motivo, ''), 'sem_motivo') end as motivo
            from ag join ult on ult.pessoa = ag.pessoa left join pr on pr.pessoa = ag.pessoa),
  espera as (select percentile_cont(0.5) within group (order by extract(epoch from (cv.primeiro_humano_em - cv.criado_em)) / 60) as med
               from cv where cv.primeiro_humano_em is not null and cv.primeiro_humano_em >= cv.criado_em)
  select jsonb_build_object(
    'entraram', (select count(*) from pes),
    'funil', jsonb_build_object(
        'entraram', (select count(*) from pes),
        'pedido', (select count(*) from pes where er >= 1),
        'data_hora', (select count(*) from pes where er >= 4),
        'horario', (select count(*) from pes where er >= 5),
        'completo', (select count(*) from pes where er >= 7),
        'agendaram', (select count(*) from pes where er = 8)),
    'parou_em', jsonb_build_object(
        'conversou', (select count(*) from pes where er = 0), 'exame', (select count(*) from pes where er = 1), 'plano', (select count(*) from pes where er = 2),
        'preferencias', (select count(*) from pes where er = 3), 'data_hora', (select count(*) from pes where er = 4),
        'dados', (select count(*) from pes where er in (5, 6)), 'pronto', (select count(*) from pes where er = 7)),
    'sem_agendar_motivo', coalesce((select jsonb_object_agg(m.motivo, m.n) from (select motivo, count(*) as n from pes where er < 8 group by motivo) m), '{}'::jsonb),
    'por_tipo', coalesce((select jsonb_object_agg(q.t, q.o) from (select coalesce(tipo, 'sem_tipo') as t, jsonb_build_object('pedido', count(*) filter (where er >= 1), 'data_hora', count(*) filter (where er >= 4),
                          'horario', count(*) filter (where er >= 5), 'completo', count(*) filter (where er >= 7), 'agendaram', count(*) filter (where er = 8)) as o from pes where er >= 1 group by 1) q), '{}'::jsonb),
    'espera_mediana_min', (select round(med::numeric, 0) from espera)
  ) into v_chat;

  return jsonb_build_object('chat', v_chat,
    'clinica', public.ind_clinica_periodo(p_de, p_ate, p_un, p_teste, null),
    'clinica_consulta', public.ind_clinica_periodo(p_de, p_ate, p_un, p_teste, 'consulta'),
    'clinica_exame', public.ind_clinica_periodo(p_de, p_ate, p_un, p_teste, 'exame'));
end $function$;
