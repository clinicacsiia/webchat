-- FLUXOGRAMA: indicadores focados na PLATAFORMA (chat) -> consulta e exame separados em todos os blocos -> a clínica toda (Klingo) só para comparar
-- Versão 1.0 — 17/11/2026 / Mudança: (1) `painel_indicadores_plataforma` (nova): marcações do Klingo que vieram do chat, por consulta e exame, com canceladas, remarcadas e ativas separadas; (2) `ind_clinica_periodo` (nova, só servidor): o bloco da clínica com filtro de tipo; (3) `ind_decisao_periodo`: funil do chat por tipo de pedido e clínica em 3 versões (todos, consulta, exame); (4) `painel_indicadores_mensal`: cada mês também por consulta e por exame. Consulta = procedimento que começa com "CONSULTA"; o resto é exame.
-- Aplicado como migrações `indicadores_plataforma_parte1..4`. Rollback: reaplicar as versões anteriores de `ind_decisao_periodo` e `painel_indicadores_mensal` (git 22414a2) e `drop function public.painel_indicadores_plataforma(date,date,text,boolean); drop function public.ind_clinica_periodo(date,date,text,boolean,text);`.
-- public.ind_clinica_periodo(p_de date, p_ate date, p_un text, p_teste boolean, p_tipo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_clinica_periodo(p_de date, p_ate date, p_un text, p_teste boolean, p_tipo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cli jsonb;
begin
  with
  ex as (select e.status, e.confirm_status, e.operadora, e.unidade, e.agendado_em, e.agendado_para, e.marcacao_id, e.procedimento,
                lower(btrim(coalesce(e.cancelamento_motivo, ''))) as m
           from public.jornada_exame e
          where e.status <> 'pedido'
            and (p_teste or e.marcacao_id not in (select 'm' || z.m from public.klingo_conferencia z join public.conversas c on c.id = z.conversa_id where c.teste))
            and (p_un is null or public.unidade_chave(e.unidade) is null or public.unidade_chave(e.unidade) = p_un)
            and (p_tipo is null or (case when e.procedimento ~* '^consulta' then 'consulta' else 'exame' end) = p_tipo)),
  pm as (select distinct 'm' || unnest(klingo_marcacoes) as m from public.pre_agendamentos where klingo_marcacoes is not null),
  ep as (select * from ex where (agendado_para at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  ef as (select ep.*, ((ep.agendado_para at time zone 'America/Sao_Paulo')::date - (ep.agendado_em at time zone 'America/Sao_Paulo')::date) as ant
           from ep where ep.status in ('atendido', 'faltou')),
  nv as (select ex.* from ex where ex.status <> 'remarcado' and (ex.agendado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  cc as (select case
           when m = '' or m ~ '^[^[:alnum:]]*$' or length(m) < 3 then 'sem_motivo'
           when m ~ 'duplic|dupli|erro|errad|eror|correç|corrig|unificad|lançamento|lancamento|teste' then 'erro_duplicidade'
           when m ~ 'conv[eêé]nio|autoriza|suspens|geap|cassi|promedica|negou|plano|sedaç|sedac|n[aã]o (faz|atend|realiz)|esse exame' then 'convenio_cobertura'
           when m ~ 'outro (local|lugar|m[eé]dico|especialista)|em outro|outra cl[ií]nica|mais pr[oó]xim|j[aá] (realiz|fez|fiz|feito)|mora em' then 'outro_lugar'
           when m ~ 'remarc|antecip|remanej|reagend|mudou a data|mudamos|marcou para|para o dia|para dezembro|depois' then 'remarcou_depois'
           when m ~ 'dra |dr |m[eé]dic[oa] n[aã]o|imprevisto|agenda cheia' then 'imprevisto_clinica'
           when m ~ 'cancel|desmarc|desist|pediu|solicit|pc |paciente|pela mesma|wpp|wellon|wellow|welon|msg|mensagem|liga|tel|m[aã]e|responsavel|n[aã]o (poder|vai|quis|consegu|ir)' then 'paciente_cancelou'
           else 'outros' end as cat
         from ep where ep.status = 'cancelado')
  select jsonb_build_object(
    'novas_marcacoes', (select count(*) from nv),
    'novas_pelo_chat', (select count(*) from nv where nv.marcacao_id in (select m from pm)),
    'previstos', (select count(*) from ep),
    'atendidos', (select count(*) from ep where status = 'atendido'),
    'faltaram', (select count(*) from ep where status = 'faltou'),
    'cancelados', (select count(*) from ep where status = 'cancelado'),
    'remarcados', (select count(*) from ep where status = 'remarcado'),
    'por_vir', (select count(*) from ep where status in ('agendado', 'confirmado')),
    'falta_unidade', coalesce((select jsonb_agg(jsonb_build_object('nome', s.nome, 'atendidos', s.a, 'faltaram', s.f) order by s.nome)
        from (select coalesce(unidade, 'Sem unidade') as nome, count(*) filter (where status = 'atendido') as a, count(*) filter (where status = 'faltou') as f from ef group by 1) s), '[]'::jsonb),
    'falta_antecedencia', coalesce((select jsonb_agg(jsonb_build_object('nome', s.nome, 'atendidos', s.a, 'faltaram', s.f) order by s.o)
        from (select case when ant <= 1 then 'No mesmo dia ou no dia seguinte' when ant <= 7 then 'De 2 a 7 dias antes' when ant <= 15 then 'De 8 a 15 dias antes' else 'Mais de 15 dias antes' end as nome,
                     case when ant <= 1 then 1 when ant <= 7 then 2 when ant <= 15 then 3 else 4 end as o,
                     count(*) filter (where status = 'atendido') as a, count(*) filter (where status = 'faltou') as f
                from ef where ant is not null group by 1, 2) s), '[]'::jsonb),
    'falta_confirmacao', coalesce((select jsonb_agg(jsonb_build_object('nome', s.nome, 'atendidos', s.a, 'faltaram', s.f) order by s.nome)
        from (select coalesce(confirm_status, 'Sem informação') as nome, count(*) filter (where status = 'atendido') as a, count(*) filter (where status = 'faltou') as f from ef group by 1) s), '[]'::jsonb),
    'falta_plano', coalesce((select jsonb_agg(jsonb_build_object('nome', s.nome, 'atendidos', s.a, 'faltaram', s.f) order by s.nome)
        from (select case when operadora ilike '%partic%' then 'Particular' else 'Convênio' end as nome, count(*) filter (where status = 'atendido') as a, count(*) filter (where status = 'faltou') as f from ef group by 1) s), '[]'::jsonb),
    'cancel_motivos', coalesce((select jsonb_object_agg(x.cat, x.n) from (select cat, count(*) as n from cc group by cat) x), '{}'::jsonb)
  ) into v_cli;
  return v_cli;
end $function$;

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

-- public.painel_indicadores_plataforma(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_plataforma(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
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
  base as (
    select k.m, k.origem, k.ligacao, k.conversa_id, k.status_klingo, k.unidade, k.marcado_em, je.status as st, je.procedimento,
           lower(btrim(coalesce(je.cancelamento_motivo, ''))) as mot,
           case when je.procedimento is not null then (case when je.procedimento ~* '^consulta' then 'consulta' else 'exame' end)
                else (select case x.tipo when 'consulta' then 'consulta' when 'exame' then 'exame' end from public.pre_agendamentos x where x.conversa_id = k.conversa_id order by x.criado_em desc limit 1) end as tipo
      from public.klingo_conferencia k
      join public.conversas c on c.id = k.conversa_id
      left join public.jornada_exame je on je.marcacao_id = 'm' || k.m
     where k.marcado_em between v_de and v_ate and (p_incluir_teste or not c.teste)
       and (v_un is null or k.unidade is null or k.unidade = v_un)),
  p as (select b.*, case when b.st = 'remarcado' then 'remarcada'
                         when b.status_klingo = 'Cancelada' or b.st = 'cancelado' then 'cancelada'
                         when b.st = 'atendido' then 'atendida' when b.st = 'faltou' then 'faltou'
                         when b.st in ('agendado', 'confirmado') then 'por_vir' else 'sem_dado' end as resultado,
               coalesce(b.tipo, 'sem_tipo') as t from base b),
  clin as (select case when je.procedimento ~* '^consulta' then 'consulta' else 'exame' end as t, count(*) as n
             from public.klingo_conferencia k left join public.conversas c on c.id = k.conversa_id left join public.jornada_exame je on je.marcacao_id = 'm' || k.m
            where k.marcado_em between v_de and v_ate and (p_incluir_teste or c.id is null or not c.teste) and (v_un is null or k.unidade is null or k.unidade = v_un) and je.procedimento is not null group by 1),
  cc as (select case
           when mot = '' or mot ~ '^[^[:alnum:]]*$' or length(mot) < 3 then 'sem_motivo'
           when mot ~ 'duplic|dupli|erro|errad|eror|correç|corrig|unificad|lançamento|lancamento|teste' then 'erro_duplicidade'
           when mot ~ 'conv[eêé]nio|autoriza|suspens|geap|cassi|promedica|negou|plano|sedaç|sedac|n[aã]o (faz|atend|realiz)|esse exame' then 'convenio_cobertura'
           when mot ~ 'outro (local|lugar|m[eé]dico|especialista)|em outro|outra cl[ií]nica|mais pr[oó]xim|j[aá] (realiz|fez|fiz|feito)|mora em' then 'outro_lugar'
           when mot ~ 'remarc|antecip|remanej|reagend|mudou a data|mudamos|marcou para|para o dia|para dezembro|depois' then 'remarcou_depois'
           when mot ~ 'dra |dr |m[eé]dic[oa] n[aã]o|imprevisto|agenda cheia' then 'imprevisto_clinica'
           when mot ~ 'cancel|desmarc|desist|pediu|solicit|pc |paciente|pela mesma|wpp|wellon|wellow|welon|msg|mensagem|liga|tel|m[aã]e|responsavel|n[aã]o (poder|vai|quis|consegu|ir)' then 'paciente_cancelou'
           else 'outros' end as cat from p where resultado = 'cancelada')
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'conversas', (select count(distinct conversa_id) from p),
    'por_tipo', coalesce((select jsonb_object_agg(q.t, q.o) from (
        select t, jsonb_build_object('total', count(*), 'canceladas', count(*) filter (where resultado = 'cancelada'), 'remarcadas', count(*) filter (where resultado = 'remarcada'),
               'ativas', count(*) filter (where resultado in ('atendida', 'faltou', 'por_vir', 'sem_dado')), 'atendidas', count(*) filter (where resultado = 'atendida'),
               'faltaram', count(*) filter (where resultado = 'faltou'), 'por_vir', count(*) filter (where resultado = 'por_vir'), 'sem_dado', count(*) filter (where resultado = 'sem_dado')) as o
          from p group by t) q), '{}'::jsonb),
    'total', (select jsonb_build_object('total', count(*), 'canceladas', count(*) filter (where resultado = 'cancelada'), 'remarcadas', count(*) filter (where resultado = 'remarcada'),
               'ativas', count(*) filter (where resultado in ('atendida', 'faltou', 'por_vir', 'sem_dado')), 'atendidas', count(*) filter (where resultado = 'atendida'),
               'faltaram', count(*) filter (where resultado = 'faltou'), 'por_vir', count(*) filter (where resultado = 'por_vir'), 'sem_dado', count(*) filter (where resultado = 'sem_dado')) from p),
    'por_origem', coalesce((select jsonb_object_agg(o, n) from (select origem as o, count(*) as n from p group by 1) q), '{}'::jsonb),
    'por_ligacao', coalesce((select jsonb_object_agg(l, n) from (select ligacao as l, count(*) as n from p group by 1) q), '{}'::jsonb),
    'cancel_motivos', coalesce((select jsonb_object_agg(x.cat, x.n) from (select cat, count(*) as n from cc group by cat) x), '{}'::jsonb),
    'clinica_mesmo_periodo', coalesce((select jsonb_object_agg(t, n) from clin), '{}'::jsonb)
  ) into v_out;
  return v_out;
end $function$;

-- public.painel_indicadores_mensal(p_meses integer, p_unidade text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_mensal(p_meses integer DEFAULT 6, p_unidade text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_mes_atual date := date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date;
  v_n integer := least(greatest(coalesce(p_meses, 6), 1), 12);
  v_ini date;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ini := (v_mes_atual - ((v_n - 1) || ' months')::interval)::date;
  return jsonb_build_object(
    'de', v_ini, 'ate', v_mes_atual, 'unidade', v_un, 'gerado_em', now(),
    'meses', coalesce((
      with base as (
        select date_trunc('month', e.agendado_para at time zone 'America/Sao_Paulo')::date as mes, e.status,
               case when e.procedimento ~* '^consulta' then 'consulta' else 'exame' end as tipo
          from public.jornada_exame e
         where e.status <> 'pedido' and e.agendado_para is not null
           and e.marcacao_id not in (select 'm' || z.m from public.klingo_conferencia z join public.conversas c on c.id = z.conversa_id where c.teste)
           and (v_un is null or public.unidade_chave(e.unidade) is null or public.unidade_chave(e.unidade) = v_un))
      select jsonb_agg(jsonb_build_object('mes', to_char(m.d, 'YYYY-MM'),
               'total', t.todos -> 'total', 'atendidos', t.todos -> 'atendidos', 'faltaram', t.todos -> 'faltaram', 'cancelados', t.todos -> 'cancelados',
               'remarcados', t.todos -> 'remarcados', 'por_vir', t.todos -> 'por_vir', 'consulta', t.co, 'exame', t.ex) order by m.d)
        from generate_series(v_ini, v_mes_atual, interval '1 month') as m(d)
        cross join lateral (
          select
            (select jsonb_build_object('total', count(*), 'atendidos', count(*) filter (where status = 'atendido'), 'faltaram', count(*) filter (where status = 'faltou'),
                    'cancelados', count(*) filter (where status = 'cancelado'), 'remarcados', count(*) filter (where status = 'remarcado'), 'por_vir', count(*) filter (where status in ('agendado', 'confirmado')))
               from base b where b.mes = m.d) as todos,
            (select jsonb_build_object('total', count(*), 'atendidos', count(*) filter (where status = 'atendido'), 'faltaram', count(*) filter (where status = 'faltou'),
                    'cancelados', count(*) filter (where status = 'cancelado'), 'remarcados', count(*) filter (where status = 'remarcado'), 'por_vir', count(*) filter (where status in ('agendado', 'confirmado')))
               from base b where b.mes = m.d and b.tipo = 'consulta') as co,
            (select jsonb_build_object('total', count(*), 'atendidos', count(*) filter (where status = 'atendido'), 'faltaram', count(*) filter (where status = 'faltou'),
                    'cancelados', count(*) filter (where status = 'cancelado'), 'remarcados', count(*) filter (where status = 'remarcado'), 'por_vir', count(*) filter (where status in ('agendado', 'confirmado')))
               from base b where b.mes = m.d and b.tipo = 'exame') as ex
        ) t), '[]'::jsonb));
end $function$;
REVOKE ALL ON FUNCTION public.ind_clinica_periodo(date, date, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ind_clinica_periodo(date, date, text, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.painel_indicadores_plataforma(date, date, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.painel_indicadores_plataforma(date, date, text, boolean) TO authenticated, service_role;
