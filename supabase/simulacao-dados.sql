-- FLUXOGRAMA: entrada (a tela /simulacao/, aberta por quem está logado no painel como admin ou atendente) -> validação (papel_atual() precisa ser admin ou atendente; só lê tabelas que já existem; nenhum nome, CPF, telefone, e-mail ou prontuário sai: cada pessoa vira um número de 1 a N que só vale naquela chamada) -> lógica (jornada_exame + jornada_card + jornada_evento = marcações do Klingo (relatório #14359) com o momento em que o Klingo marcou "atendido"; histórico de dias fechados; faltas por situação da confirmação) -> saída (um JSON no formato que a simulação já entende: visits, history, mais "calibragem" e "indicadores")
-- Versão 1.0 — 15/11/2026 / Mudança: criação das funções de leitura da simulação (somente leitura; nenhuma tabela nova). O resumo do dia traz também quando a Jornada leu o Klingo pela última vez (jornada_sync_estado.klingo_fim_em).
--
-- O que NÃO existe no Klingo (conferido em 15/11/2026): hora de início e de fim do exame, hora do cadastro no guichê, hora do preparo.
-- O que existe: hora marcada, situação (atendido, faltou, cancelado, remarcado), situação da confirmação e o MOMENTO em que a Jornada viu o Klingo marcar
-- o atendimento como feito (jornada_evento: para_coluna = 'em_atendimento', origem = 'klingo'), lido a cada 30 s. Esse momento é usado como CHEGADA
-- (aproximação: a recepção abre o atendimento ao receber o paciente). Só vale se for no mesmo dia da marcação.
--
-- ROLLBACK (rodar no editor SQL do Supabase, pede confirmação por causa do drop):
--   drop function public.painel_simulacao_indicadores(integer);
--   drop function public.painel_simulacao_dia(date);
--   drop function public.sim_modalidade(text);
--   drop function public.sim_unidade(text);

-- Unidade do Klingo -> chave da simulação
create or replace function public.sim_unidade(p_unidade text)
returns text language sql immutable set search_path = ''
as $f$
  select case lower(btrim(coalesce(p_unidade, '')))
    when 'csi 1' then 'csi1' when 'csi 2' then 'csi2' when 'csi pediatria' then 'ped' else null end
$f$;

-- Nome do procedimento -> modalidade da simulação (consulta, us, rm, tc, eco, rx, dmo, mamo, histero). Fora disso: nulo.
create or replace function public.sim_modalidade(p_proc text)
returns text language sql immutable set search_path = ''
as $f$
  select case
    when p_proc is null then null
    when p_proc ~* 'histeroscop' then 'histero'
    when p_proc ~* 'densitom' then 'dmo'
    when p_proc ~* 'mamograf' then 'mamo'
    when p_proc ~* 'ecodoppler|ecocardio|eletrocardio|\mecg\M' then 'eco'
    when p_proc ~* 'histerossalping|uretrocisto|enema|clister|esofago|esôfago|escanometria|\mrx\M|radiograf' then 'rx'
    when p_proc ~* '\mrm\M|resson|angiorm' then 'rm'
    when p_proc ~* '\mtc\M|tomograf' then 'tc'
    when p_proc ~* '\mus\M|\musg\M|ultra|doppler|elastograf|transvaginal' then 'us'
    when p_proc ~* 'consulta|atendimento|preventivo|eletroencefal|\meeg' then 'consulta'
    else null end
$f$;

-- Um dia (passado, hoje ou futuro) no formato da simulação
create or replace function public.painel_simulacao_dia(p_dia date default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $f$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dia date := coalesce(p_dia, (now() at time zone 'America/Sao_Paulo')::date);
  v_ini timestamptz; v_fim timestamptz; v_asof timestamptz; v_corte integer;
  v_visitas jsonb; v_hist jsonb; v_calib jsonb; v_meta jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem a simulação.' using errcode = '42501';
  end if;
  if v_dia < v_hoje - 120 or v_dia > v_hoje + 120 then
    raise exception 'Data fora da janela de 120 dias.' using errcode = '22023';
  end if;
  v_ini := v_dia::timestamp at time zone 'America/Sao_Paulo';
  v_fim := (v_dia + 1)::timestamp at time zone 'America/Sao_Paulo';
  v_asof := case when v_dia < v_hoje then v_fim + interval '6 hours' else now() end;
  v_corte := case when v_dia < v_hoje then 1439
                  when v_dia > v_hoje then 0
                  else (extract(hour from now() at time zone 'America/Sao_Paulo') * 60 + extract(minute from now() at time zone 'America/Sao_Paulo'))::int end;

  with ex as (
    select e.id, e.card_id, e.status, e.confirm_status, k.paciente_chave,
           public.sim_unidade(e.unidade) as u, public.sim_modalidade(e.procedimento) as t,
           (extract(hour from e.agendado_para at time zone 'America/Sao_Paulo') * 60 + extract(minute from e.agendado_para at time zone 'America/Sao_Paulo'))::int as slot
      from public.jornada_exame e join public.jornada_card k on k.id = e.card_id
     where e.marcacao_id like 'm%' and e.agendado_para >= v_ini and e.agendado_para < v_fim
  ),
  chegada as (
    select v.card_id, min(v.quando) as q
      from public.jornada_evento v
     where v.para_coluna = 'em_atendimento' and v.origem = 'klingo' and v.quando >= v_ini and v.quando < v_fim and v.quando <= v_asof
     group by v.card_id
  ),
  uteis as (select * from ex where status not in ('cancelado', 'remarcado', 'pedido') and u is not null and t is not null),
  pessoa as (select paciente_chave, dense_rank() over (order by paciente_chave)::int as n from (select distinct paciente_chave from uteis) z)
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', x.id, 'person', p.n, 'unit', x.u, 'type', x.t, 'slot', x.slot,
           'arrive', case when c.q is not null then least((extract(hour from c.q at time zone 'America/Sao_Paulo') * 60 + extract(minute from c.q at time zone 'America/Sao_Paulo'))::int, v_corte) end,
           'absentAt', case when x.status = 'faltou' and c.q is null then least(x.slot + 15, v_corte) end,
           'confirm', case x.confirm_status when 'Confirmado' then 'confirmado' when 'A Confirmar' then 'a_confirmar' when 'Sem Resposta' then 'sem_resposta' end,
           'done', case when x.status = 'atendido' then true end
         )) order by x.slot, x.id), '[]'::jsonb),
         jsonb_build_object(
           'marcacoes_no_dia', (select count(*) from ex),
           'canceladas_ou_remarcadas', (select count(*) from ex where status in ('cancelado', 'remarcado')),
           'fora_do_modelo', (select count(*) from ex where status not in ('cancelado', 'remarcado', 'pedido') and (u is null or t is null)),
           'com_chegada_real', (select count(*) from uteis x2 join chegada c2 on c2.card_id = x2.card_id),
           'faltas_registradas', (select count(*) from uteis where status = 'faltou'),
           'sync_klingo_em', (select s.klingo_fim_em from public.jornada_sync_estado s limit 1))
    into v_visitas, v_meta
    from uteis x join pessoa p on p.paciente_chave = x.paciente_chave left join chegada c on c.card_id = x.card_id;

  -- Histórico: dias fechados (antes de hoje e antes do dia pedido), últimas 10 semanas. booked = quem tinha desfecho conhecido (atendido ou faltou).
  select coalesce(jsonb_agg(jsonb_build_object('date', h.d, 'hour', h.h, 'unit', h.u, 'type', h.t, 'booked', h.booked, 'arrivals', h.arr) order by h.d, h.h, h.u, h.t), '[]'::jsonb)
    into v_hist
    from (select (e.agendado_para at time zone 'America/Sao_Paulo')::date as d,
                 extract(hour from e.agendado_para at time zone 'America/Sao_Paulo')::int as h,
                 public.sim_unidade(e.unidade) as u, public.sim_modalidade(e.procedimento) as t,
                 count(*)::int as booked, (count(*) filter (where e.status = 'atendido'))::int as arr
            from public.jornada_exame e
           where e.marcacao_id like 'm%' and e.status in ('atendido', 'faltou')
             and e.agendado_para >= ((least(v_dia, v_hoje) - 70)::timestamp at time zone 'America/Sao_Paulo')
             and e.agendado_para < least(v_ini, (v_hoje::timestamp at time zone 'America/Sao_Paulo'))
           group by 1, 2, 3, 4) h
   where h.u is not null and h.t is not null;

  -- Calibragem medida na própria clínica (últimas 8 semanas fechadas)
  with base as (
    select e.id, e.status, e.confirm_status, public.sim_unidade(e.unidade) as u, e.card_id,
           (extract(hour from e.agendado_para at time zone 'America/Sao_Paulo') * 60 + extract(minute from e.agendado_para at time zone 'America/Sao_Paulo'))::int as slot,
           (e.agendado_para at time zone 'America/Sao_Paulo')::date as d
      from public.jornada_exame e
     where e.marcacao_id like 'm%' and e.status in ('atendido', 'faltou') and public.sim_modalidade(e.procedimento) is not null
       and e.agendado_para >= ((v_hoje - 56)::timestamp at time zone 'America/Sao_Paulo') and e.agendado_para < (v_hoje::timestamp at time zone 'America/Sao_Paulo')
  ),
  ch as (
    select b.u, b.id, (extract(hour from c.q at time zone 'America/Sao_Paulo') * 60 + extract(minute from c.q at time zone 'America/Sao_Paulo'))::int - b.slot as delta
      from base b join lateral (select min(v.quando) as q from public.jornada_evento v where v.card_id = b.card_id and v.para_coluna = 'em_atendimento' and v.origem = 'klingo') c on c.q is not null
     where b.status = 'atendido' and (c.q at time zone 'America/Sao_Paulo')::date = b.d
  )
  select jsonb_build_object(
    'faltaPorConfirmacao', (select coalesce(jsonb_object_agg(k, jsonb_build_object('taxa', round(100.0 * f / nullif(n, 0), 1), 'n', n)), '{}'::jsonb)
        from (select case confirm_status when 'Confirmado' then 'confirmado' when 'A Confirmar' then 'a_confirmar' when 'Sem Resposta' then 'sem_resposta' end as k,
                     count(*) as n, count(*) filter (where status = 'faltou') as f
                from base where confirm_status in ('Confirmado', 'A Confirmar', 'Sem Resposta') group by 1) q),
    'faltaGeral', (select round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) from base),
    'chegada', (select coalesce(jsonb_object_agg(u, jsonb_build_object('n', n, 'quantis', qs)), '{}'::jsonb)
        from (select u, count(*) as n,
                     percentile_cont(array[0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) within group (order by greatest(-90, least(90, delta))) as qs
                from ch where u is not null group by u having count(*) >= 20) z)
  ) into v_calib;

  return jsonb_build_object('date', v_dia, 'asOf', to_char(v_asof at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                            'visits', v_visitas, 'history', v_hist, 'capacity', '{}'::jsonb, 'outage', null,
                            'calibragem', v_calib, 'meta', v_meta);
end;
$f$;

-- Indicadores de decisão (últimos p_dias dias fechados + próximos 14 dias). Só números.
create or replace function public.painel_simulacao_indicadores(p_dias integer default 28)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $f$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dias integer := greatest(7, least(coalesce(p_dias, 28), 90));
  v_de timestamptz; v_ate timestamptz; v_fut timestamptz;
  v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem a simulação.' using errcode = '42501';
  end if;
  v_de := (v_hoje - v_dias)::timestamp at time zone 'America/Sao_Paulo';
  v_ate := v_hoje::timestamp at time zone 'America/Sao_Paulo';
  v_fut := (v_hoje + 15)::timestamp at time zone 'America/Sao_Paulo';

  with base as (
    select e.id, e.card_id, e.status, e.confirm_status, e.agendado_em, e.agendado_para,
           public.sim_unidade(e.unidade) as u, public.sim_modalidade(e.procedimento) as t,
           (e.agendado_para at time zone 'America/Sao_Paulo')::date as d,
           extract(hour from e.agendado_para at time zone 'America/Sao_Paulo')::int as h,
           extract(isodow from e.agendado_para at time zone 'America/Sao_Paulo')::int as dow
      from public.jornada_exame e
     where e.marcacao_id like 'm%' and e.agendado_para >= v_de and e.agendado_para < v_fut
  ),
  pas as (select * from base where agendado_para < v_ate),
  fut as (select * from base where agendado_para >= v_ate),
  fechados as (select * from pas where status in ('atendido', 'faltou') and u is not null and t is not null),
  taxa as (
    select coalesce(confirm_status, 'x') as c, count(*) as n, count(*) filter (where status = 'faltou') as f,
           round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct
      from fechados group by 1
  ),
  geral as (select round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct from fechados),
  cheg as (
    select b.u, b.t, b.h, (extract(hour from c.q at time zone 'America/Sao_Paulo') * 60 + extract(minute from c.q at time zone 'America/Sao_Paulo')
           - (extract(hour from b.agendado_para at time zone 'America/Sao_Paulo') * 60 + extract(minute from b.agendado_para at time zone 'America/Sao_Paulo')))::numeric as delta
      from fechados b join lateral (select min(v.quando) as q from public.jornada_evento v where v.card_id = b.card_id and v.para_coluna = 'em_atendimento' and v.origem = 'klingo') c on c.q is not null
     where b.status = 'atendido' and (c.q at time zone 'America/Sao_Paulo')::date = b.d
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_hoje - v_dias, 'ate', v_hoje - 1, 'dias', v_dias,
        'dias_com_dado', (select count(distinct d) from pas), 'primeiro_dia_do_banco', (select min(d) from base)),
    'unidades', (select coalesce(jsonb_agg(jsonb_build_object('unidade', u, 'marcadas', total, 'atendidas', att, 'faltaram', fal, 'canceladas', can, 'remarcadas', rem,
            'pct_falta', round(100.0 * fal / nullif(att + fal, 0), 1), 'pct_cancela_remarca', round(100.0 * (can + rem) / nullif(total, 0), 1)) order by u), '[]'::jsonb)
        from (select u, count(*) as total, count(*) filter (where status = 'atendido') as att, count(*) filter (where status = 'faltou') as fal,
                     count(*) filter (where status = 'cancelado') as can, count(*) filter (where status = 'remarcado') as rem
                from pas where u is not null group by u) z),
    'modalidades', (select coalesce(jsonb_agg(jsonb_build_object('unidade', u, 'tipo', t, 'n', n, 'dias', dias, 'por_dia', round(n::numeric / nullif(dias, 0), 1), 'pct_falta', pct) order by u, n desc), '[]'::jsonb)
        from (select u, t, count(*) as n, count(distinct d) as dias,
                     round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct
                from fechados group by u, t) z),
    'confirmacao', (select coalesce(jsonb_agg(jsonb_build_object('situacao', c, 'n', n, 'faltaram', f, 'pct_falta', pct) order by n desc), '[]'::jsonb) from taxa),
    'semana', (select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'unidade', u, 'media_por_dia', round(n::numeric / nullif(dias, 0), 1), 'dias', dias, 'pct_falta', pct) order by dow, u), '[]'::jsonb)
        from (select dow, u, count(*) as n, count(distinct d) as dias, round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct
                from fechados group by dow, u) z),
    'horas', (select coalesce(jsonb_agg(jsonb_build_object('hora', h, 'unidade', u, 'media_por_dia', round(n::numeric / nullif(dias, 0), 1), 'pct_falta', pct, 'dias', dias) order by u, h), '[]'::jsonb)
        from (select h, u, count(*) as n, count(distinct d) as dias, round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct
                from fechados group by h, u) z),
    'pontualidade', (select coalesce(jsonb_agg(jsonb_build_object('unidade', u, 'n', n, 'p10', round(p10::numeric, 0), 'p50', round(p50::numeric, 0), 'p90', round(p90::numeric, 0),
            'pct_15_antes', pa, 'pct_15_depois', pd) order by u), '[]'::jsonb)
        from (select u, count(*) as n,
                     percentile_cont(0.1) within group (order by greatest(-120, least(120, delta))) as p10,
                     percentile_cont(0.5) within group (order by greatest(-120, least(120, delta))) as p50,
                     percentile_cont(0.9) within group (order by greatest(-120, least(120, delta))) as p90,
                     round(100.0 * count(*) filter (where delta <= -15) / count(*), 1) as pa, round(100.0 * count(*) filter (where delta >= 15) / count(*), 1) as pd
                from cheg where u is not null group by u having count(*) >= 20) z),
    'antecedencia', (select jsonb_build_object('n', count(*),
            'p50_dias', round((percentile_cont(0.5) within group (order by extract(epoch from (agendado_para - agendado_em)) / 86400))::numeric, 1),
            'p90_dias', round((percentile_cont(0.9) within group (order by extract(epoch from (agendado_para - agendado_em)) / 86400))::numeric, 1),
            'pct_menos_de_1_dia', round(100.0 * count(*) filter (where agendado_para - agendado_em < interval '1 day') / nullif(count(*), 0), 1))
        from pas where agendado_em is not null and agendado_em < agendado_para),
    'proximos', (select coalesce(jsonb_agg(jsonb_build_object('dia', d, 'unidade', u, 'marcadas', n, 'confirmadas', conf, 'a_confirmar', ac, 'sem_resposta', sr,
            'faltas_esperadas', round(esp::numeric, 1)) order by d, u), '[]'::jsonb)
        from (select f.d, f.u, count(*) as n,
                     count(*) filter (where f.confirm_status = 'Confirmado') as conf, count(*) filter (where f.confirm_status = 'A Confirmar') as ac,
                     count(*) filter (where f.confirm_status = 'Sem Resposta') as sr,
                     sum(coalesce(tx.pct, (select g.pct from geral g)) / 100.0) as esp
                from fut f left join taxa tx on tx.c = coalesce(f.confirm_status, 'x')
               where f.u is not null and f.t is not null and f.status in ('agendado', 'confirmado', 'atendido') group by f.d, f.u) z),
    'origem', (select coalesce(jsonb_agg(jsonb_build_object('origem', o, 'n', n, 'do_chat', chat) order by n desc), '[]'::jsonb)
        from (select origem as o, count(*) as n, count(*) filter (where conversa_id is not null) as chat
                from public.klingo_conferencia where marcado_em >= v_hoje - v_dias group by origem) z),
    'pedidos_chat', (select coalesce(jsonb_agg(jsonb_build_object('situacao', s, 'n', n) order by n desc), '[]'::jsonb)
        from (select status as s, count(*) as n from public.pre_agendamentos where criado_em >= v_de group by status) z),
    'fila_chegada', (select jsonb_build_object('n', count(*), 'atendidos', count(*) filter (where chamado_em is not null),
            'espera_mediana_min', round((percentile_cont(0.5) within group (order by extract(epoch from (chamado_em - chegou_em)) / 60))::numeric, 1))
        from public.fila_chegada where chegou_em >= v_de and chamado_em is not null)
  ) into v_out;
  return v_out;
end;
$f$;

revoke all on function public.painel_simulacao_dia(date) from public, anon;
revoke all on function public.painel_simulacao_indicadores(integer) from public, anon;
grant execute on function public.painel_simulacao_dia(date) to authenticated, service_role;
grant execute on function public.painel_simulacao_indicadores(integer) to authenticated, service_role;
