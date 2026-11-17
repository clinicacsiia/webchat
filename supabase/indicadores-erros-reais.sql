-- FLUXOGRAMA: entrada (pedido do dono, revisão dos indicadores de 17/11/2026: 3 erros reais) -> validação (as funções continuam só para admin e atendente; funções internas só para o servidor) -> lógica (1. quem não tem unidade fica no balde "sem unidade" e NÃO em todas as unidades; 2. o funil usa o andamento real do pedido: quem foi encerrado como "Agendado" sem pedido agendado conta em "Agendaram" mas não nas etapas do meio; 3. agendamento de atendente = quem marcou à mão + quem escreveu na conversa quando o sistema confirmou; dono que não escreveu não ganha, cancelado não conta) -> saída (os mesmos JSONs, com chaves novas: unidades.sem, funil.agendaram_so_pelo_motivo, atendentes.agendados_a_mao)
-- Versão 1.0 — 17/11/2026 / Mudança: Implementação inicial. Só create or replace, mesmas assinaturas e permissões (as de 17/11 em supabase/producao/funcoes/). Seis funções: ind_decisao_periodo, ind_agenda_periodo, painel_indicadores_plataforma, painel_indicadores_diretoria, painel_indicadores_atendentes, painel_indicadores_equipe.
-- Regra de unidade (muda o que a nota de 09/11/2026 em docs/indicadores-por-unidade.md dizia): pessoa sem unidade definida (nenhum pedido agendado, cartão da Jornada nem unidade do formulário) aparece só em "Sem unidade definida" e some do filtro de unidade do topo; antes aparecia em todas e inflava (hoje: 46 pessoas para 34 reais, 10 agendamentos para 8). Marcação do Klingo sem unidade idem.
-- ROLLBACK: recriar as seis funções a partir de supabase/producao/funcoes/ do commit anterior a esta mudança (git show <commit>^:supabase/producao/funcoes/<nome>.sql).
-- APLICAR EM PARTES (a ferramenta de migração expira em 60 s): uma função por migração, na ordem abaixo. Atenção: o painel novo já lê as chaves novas, mas funciona com as funções antigas (mostra zero em "Sem unidade" e esconde a nota do funil).

-- Parte 1: ind_decisao_periodo
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
          where p_un is null or (p_un = 'sem' and (x.chaves is null or cardinality(x.chaves) = 0)) or (p_un <> 'sem' and p_un = any (x.chaves))),
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
                 coalesce(pr.r, 0) as rf,
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
        'pedido', (select count(*) from pes where rf >= 1 or er = 8),
        'data_hora', (select count(*) from pes where rf >= 4),
        'horario', (select count(*) from pes where rf >= 5),
        'completo', (select count(*) from pes where rf >= 7),
        'agendaram', (select count(*) from pes where er = 8),
        'agendaram_so_pelo_motivo', (select count(*) from pes where er = 8 and rf < 8)),
    'parou_em', jsonb_build_object(
        'conversou', (select count(*) from pes where er = 0), 'exame', (select count(*) from pes where er = 1), 'plano', (select count(*) from pes where er = 2),
        'preferencias', (select count(*) from pes where er = 3), 'data_hora', (select count(*) from pes where er = 4),
        'dados', (select count(*) from pes where er in (5, 6)), 'pronto', (select count(*) from pes where er = 7)),
    'sem_agendar_motivo', coalesce((select jsonb_object_agg(m.motivo, m.n) from (select motivo, count(*) as n from pes where er < 8 group by motivo) m), '{}'::jsonb),
    'por_tipo', coalesce((select jsonb_object_agg(q.t, q.o) from (select coalesce(tipo, 'sem_tipo') as t, jsonb_build_object('pedido', count(*) filter (where rf >= 1 or er = 8), 'data_hora', count(*) filter (where rf >= 4),
                          'horario', count(*) filter (where rf >= 5), 'completo', count(*) filter (where rf >= 7), 'agendaram', count(*) filter (where er = 8)) as o from pes where rf >= 1 or er = 8 group by 1) q), '{}'::jsonb),
    'espera_mediana_min', (select round(med::numeric, 0) from espera)
  ) into v_chat;

  return jsonb_build_object('chat', v_chat,
    'clinica', public.ind_clinica_periodo(p_de, p_ate, p_un, p_teste, null),
    'clinica_consulta', public.ind_clinica_periodo(p_de, p_ate, p_un, p_teste, 'consulta'),
    'clinica_exame', public.ind_clinica_periodo(p_de, p_ate, p_un, p_teste, 'exame'));
end $function$;

-- Parte 2: ind_agenda_periodo
CREATE OR REPLACE FUNCTION public.ind_agenda_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v jsonb;
begin
  with
  ex as (
    select e.marcacao_id,
           (e.agendado_para at time zone 'America/Sao_Paulo')::date as dia,
           (e.agendado_em at time zone 'America/Sao_Paulo')::date as marcado,
           case when e.procedimento ~* '^consulta' then 'consulta' else 'exame' end as tipo,
           coalesce(public.unidade_chave(e.unidade), 'sem') as un,
           (coalesce(e.confirm_status, '') ilike 'confirmad%') as conf,
           (e.checkin_em is not null and (e.checkin_em at time zone 'America/Sao_Paulo')::date = (e.agendado_para at time zone 'America/Sao_Paulo')::date) as chegou,
           case e.status when 'remarcado' then 'remarcada' when 'cancelado' then 'cancelada' when 'atendido' then 'atendida' when 'faltou' then 'faltou'
                else case when (e.agendado_para at time zone 'America/Sao_Paulo')::date >= v_hoje then 'por_vir' else 'sem_fechamento' end end as r
      from public.jornada_exame e
      join public.klingo_conferencia kc on 'm' || kc.m = e.marcacao_id
      join public.conversas cw on cw.id = kc.conversa_id
     where e.status <> 'pedido'
       and (p_teste or not cw.teste)
       and (p_un is null or coalesce(public.unidade_chave(e.unidade), 'sem') = p_un)),
  base as (select * from ex where dia between p_de and p_ate),
  ag as (
    select g.grp, g.chave,
           count(*) as agendados,
           count(*) filter (where b.r = 'cancelada') as canceladas,
           count(*) filter (where b.r = 'remarcada') as remarcadas,
           count(*) filter (where b.r not in ('cancelada', 'remarcada')) as ficaram,
           count(*) filter (where b.r not in ('cancelada', 'remarcada') and b.conf) as confirmaram,
           count(*) filter (where b.r = 'atendida') as atendidas,
           count(*) filter (where b.r = 'faltou') as faltaram,
           count(*) filter (where b.r = 'por_vir') as por_vir,
           count(*) filter (where b.r = 'sem_fechamento') as sem_fechamento,
           count(*) filter (where b.r not in ('cancelada', 'remarcada') and b.chegou) as chegaram,
           count(*) filter (where b.r = 'atendida' and b.conf) as conf_atendidas,
           count(*) filter (where b.r = 'faltou' and b.conf) as conf_faltaram,
           count(*) filter (where b.r = 'atendida' and not b.conf) as nconf_atendidas,
           count(*) filter (where b.r = 'faltou' and not b.conf) as nconf_faltaram
      from base b cross join lateral (values ('total', 'todos'), ('tipo', b.tipo), ('un', b.un), ('dia', b.dia::text)) g(grp, chave)
     group by g.grp, g.chave),
  lin as (select grp, chave, to_jsonb(ag) - 'grp' - 'chave' as o from ag),
  hoje as (select count(*) filter (where r not in ('cancelada', 'remarcada')) as ficaram, count(*) filter (where r not in ('cancelada', 'remarcada') and conf) as confirmaram,
                  count(*) filter (where r not in ('cancelada', 'remarcada') and chegou) as chegaram, count(*) filter (where r = 'atendida') as atendidas,
                  count(*) filter (where r in ('cancelada', 'remarcada')) as saiu, count(*) as agendados
             from ex where dia = v_hoje),
  prox as (select dia, count(*) filter (where r not in ('cancelada', 'remarcada')) as ficaram, count(*) filter (where r not in ('cancelada', 'remarcada') and conf) as confirmaram
             from ex where dia > v_hoje and dia <= v_hoje + 3 group by dia),
  nov as (select count(*) as total, count(*) filter (where r = 'cancelada') as canceladas, count(*) filter (where r = 'remarcada') as remarcadas,
                 count(*) filter (where r not in ('cancelada', 'remarcada')) as ativas
            from ex where marcado between p_de and p_ate),
  pu as (select x.conversa_id, x.pessoa from public.painel_conversa_pessoa_un() x where p_un is null or (p_un = 'sem' and (x.chaves is null or cardinality(x.chaves) = 0)) or (p_un <> 'sem' and p_un = any (x.chaves))),
  site as (select count(distinct pu.pessoa) filter (where cardinality(coalesce(pa.klingo_marcacoes, '{}')) > 0) as com_marcacao,
                  count(distinct pu.pessoa) filter (where exists (select 1 from unnest(coalesce(pa.klingo_marcacoes, '{}')) u
                                                                    where exists (select 1 from public.klingo_conferencia z where z.m = u::text and z.status_klingo <> 'Cancelada'))) as com_marcacao_ativa
             from public.conversas c join pu on pu.conversa_id = c.id join public.pre_agendamentos pa on pa.conversa_id = c.id
            where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  pes as (select pu.pessoa, bool_or(c.primeiro_humano_em is not null) as humano,
                 bool_or(c.motivo_encerramento = 'agendado' or exists (select 1 from public.pre_agendamentos pa where pa.conversa_id = c.id and pa.status = 'agendado')) as agendou
            from public.conversas c join pu on pu.conversa_id = c.id
           where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate group by pu.pessoa),
  pesa as (select count(*) as procuraram, count(*) filter (where humano) as atendidas, count(*) filter (where agendou) as agendaram, count(*) filter (where agendou and not humano) as sem_ajuda from pes),
  spd as (select (c.criado_em at time zone 'America/Sao_Paulo')::date as dia, count(distinct pu.pessoa) as pessoas,
                 count(distinct pu.pessoa) filter (where c.motivo_encerramento = 'agendado' or exists (select 1 from public.pre_agendamentos pa where pa.conversa_id = c.id and pa.status = 'agendado')) as agendaram
            from public.conversas c join pu on pu.conversa_id = c.id
           where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate group by 1)
  select jsonb_build_object(
    'total', coalesce((select o from lin where grp = 'total'), jsonb_build_object('agendados', 0, 'canceladas', 0, 'remarcadas', 0, 'ficaram', 0, 'confirmaram', 0, 'atendidas', 0, 'faltaram', 0, 'por_vir', 0, 'sem_fechamento', 0, 'chegaram', 0,
                                                                                    'conf_atendidas', 0, 'conf_faltaram', 0, 'nconf_atendidas', 0, 'nconf_faltaram', 0)),
    'por_tipo', coalesce((select jsonb_object_agg(chave, o) from lin where grp = 'tipo'), '{}'::jsonb),
    'por_unidade', coalesce((select jsonb_object_agg(chave, o) from lin where grp = 'un'), '{}'::jsonb),
    'por_dia', coalesce((select jsonb_agg(o || jsonb_build_object('dia', chave) order by chave) from lin where grp = 'dia'), '[]'::jsonb),
    'hoje', (select to_jsonb(hoje) from hoje),
    'proximos', coalesce((select jsonb_agg(jsonb_build_object('dia', dia, 'ficaram', ficaram, 'confirmaram', confirmaram) order by dia) from prox), '[]'::jsonb),
    'novas', (select to_jsonb(nov) from nov),
    'pessoas', (select to_jsonb(pesa) from pesa),
    'site', (select to_jsonb(site) from site),
    'site_por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', dia, 'pessoas', pessoas, 'agendaram', agendaram) order by dia) from spd), '[]'::jsonb),
    'dados_desde', (select min((agendado_para at time zone 'America/Sao_Paulo')::date) from public.jornada_exame where status <> 'pedido'),
    'checkin_desde', (select min((checkin_em at time zone 'America/Sao_Paulo')::date) from public.jornada_exame where checkin_em is not null and (checkin_em at time zone 'America/Sao_Paulo')::date = (agendado_para at time zone 'America/Sao_Paulo')::date)
  ) into v;
  return v;
end $function$;

-- Parte 3: painel_indicadores_plataforma
CREATE OR REPLACE FUNCTION public.painel_indicadores_plataforma(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_out jsonb;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar', 'sem') then lower(p_unidade) end;
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
       and (v_un is null or coalesce(k.unidade, 'sem') = v_un)),
  p as (select b.*, case when b.st = 'remarcado' then 'remarcada'
                         when b.status_klingo = 'Cancelada' or b.st = 'cancelado' then 'cancelada'
                         when b.st = 'atendido' then 'atendida' when b.st = 'faltou' then 'faltou'
                         when b.st in ('agendado', 'confirmado') then 'por_vir' else 'sem_dado' end as resultado,
               coalesce(b.tipo, 'sem_tipo') as t from base b),
  clin as (select case when je.procedimento ~* '^consulta' then 'consulta' else 'exame' end as t, count(*) as n
             from public.klingo_conferencia k left join public.conversas c on c.id = k.conversa_id left join public.jornada_exame je on je.marcacao_id = 'm' || k.m
            where k.marcado_em between v_de and v_ate and (p_incluir_teste or c.id is null or not c.teste) and (v_un is null or coalesce(k.unidade, 'sem') = v_un) and je.procedimento is not null group by 1),
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

-- Parte 4: painel_indicadores_diretoria
CREATE OR REPLACE FUNCTION public.painel_indicadores_diretoria(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_teste boolean := coalesce(p_incluir_teste, false);
  v_u text; v_un jsonb := '{}'::jsonb; d jsonb; pl jsonb; v_ped jsonb; v_pla jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  foreach v_u in array array['csi', 'rmtc', 'desenvoar', 'sem'] loop
    d := public.ind_decisao_periodo(v_de, v_ate, v_u, v_teste) -> 'chat';
    pl := public.painel_indicadores_plataforma(v_de, v_ate, v_u, v_teste);
    v_un := v_un || jsonb_build_object(v_u, jsonb_build_object('pessoas', d -> 'funil' -> 'entraram', 'agendaram', d -> 'funil' -> 'agendaram',
                                                               'marcacoes', pl -> 'total', 'por_tipo', pl -> 'por_tipo'));
  end loop;
  with
  it as (select pu.pessoa, pa.status,
                coalesce(nullif(btrim(upper(pa.procedimento)), ''), '(sem procedimento)') as proc,
                case when pa.plano is null or btrim(pa.plano) = '' then null when pa.plano ~* 'partic' then 'PARTICULAR' when pa.plano ~* 'unimed' then 'UNIMED' else upper(btrim(pa.plano)) end as plano
           from public.conversas c
           join public.painel_conversa_pessoa_un() pu on pu.conversa_id = c.id
           join public.pre_agendamentos pa on pa.conversa_id = c.id
          where (v_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate)
  select coalesce((select jsonb_agg(x order by (x ->> 'pessoas')::int desc, x ->> 'nome') from (
            select jsonb_build_object('nome', proc, 'pessoas', count(distinct pessoa), 'agendaram', count(distinct pessoa) filter (where status = 'agendado')) as x
              from it group by proc order by count(distinct pessoa) desc, proc limit 8) q), '[]'::jsonb),
         coalesce((select jsonb_agg(x order by (x ->> 'pessoas')::int desc, x ->> 'nome') from (
            select jsonb_build_object('nome', plano, 'pessoas', count(distinct pessoa), 'agendaram', count(distinct pessoa) filter (where status = 'agendado')) as x
              from it where plano is not null group by plano order by count(distinct pessoa) desc, plano limit 8) q), '[]'::jsonb)
    into v_ped, v_pla;
  return jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'gerado_em', now(), 'unidades', v_un, 'pedidos', v_ped, 'planos', v_pla);
end $function$;

-- Parte 5: painel_indicadores_atendentes
CREATE OR REPLACE FUNCTION public.painel_indicadores_atendentes(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_i timestamptz; v_f timestamptz; v_out jsonb;
  v_uid uuid := (select auth.uid()); v_nivel text := public.org_nivel();
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  v_i := (v_de::timestamp at time zone 'America/Sao_Paulo'); v_f := ((v_ate + 1)::timestamp at time zone 'America/Sao_Paulo');
  with
  quem as (select a.id, a.nome, a.papel from public.agentes a
            where a.ativo and a.papel in ('admin', 'atendente')
              and (v_nivel in ('ti', 'gerente') or a.id = v_uid
                   or (v_nivel = 'supervisor' and exists (select 1 from public.org_membro s join public.org_membro t on t.equipe_id = s.equipe_id
                                                           where s.agente_id = v_uid and s.funcao = 'supervisor' and s.ativo and t.agente_id = a.id and t.ativo)))),
  pu as (select x.conversa_id from public.painel_conversa_pessoa_un() x
          where v_un is null or (x.chaves is not null and v_un = any (x.chaves))),
  cv as (select c.id, c.criado_em from public.conversas c join pu on pu.conversa_id = c.id where p_incluir_teste or not c.teste),
  msg as (select m.agente_id, count(distinct m.conversa_id) as conversas from public.mensagens m join cv on cv.id = m.conversa_id
           where m.autor = 'agente' and m.agente_id is not null and m.criado_em >= v_i and m.criado_em < v_f group by m.agente_id),
  -- Crédito do agendamento (v1.1, 17/11/2026): quem marcou à mão no painel (agendado_por); se o sistema confirmou sozinho com o Klingo, quem escreveu na conversa (o dono dela, se escreveu; senão quem mais escreveu).
  -- Dono da conversa que não escreveu nada NÃO ganha crédito. Marcação cancelada de verdade no Klingo não conta (aparece à parte, em cancelados); remarcada (trocada por outra data) continua contando.
  agd as (select x.agente_id,
                 count(*) filter (where not x.cancelado) as n,
                 count(*) filter (where not x.cancelado and x.automatico) as n_auto,
                 count(*) filter (where not x.cancelado and not x.automatico) as n_mao,
                 count(*) filter (where x.cancelado) as n_canc
            from (select coalesce(p.agendado_por, (select m.agente_id from public.mensagens m where m.conversa_id = p.conversa_id and m.autor = 'agente' and m.agente_id is not null
                                       group by m.agente_id order by (m.agente_id = c.agente_id) desc, count(*) desc, m.agente_id limit 1)) as agente_id,
                         p.agendado_por is null as automatico,
                         (coalesce(cardinality(p.klingo_marcacoes), 0) > 0 and not exists (select 1 from unnest(p.klingo_marcacoes) u
                            where not exists (select 1 from public.klingo_conferencia z where z.m = u::text and z.status_klingo = 'Cancelada'))
                         and not exists (select 1 from unnest(p.klingo_marcacoes) u2 join public.jornada_exame je on je.marcacao_id = 'm' || u2 where je.status = 'remarcado')) as cancelado
                    from public.pre_agendamentos p join cv on cv.id = p.conversa_id join public.conversas c on c.id = p.conversa_id
                   where coalesce(p.agendado_em, p.agendado_auto_em) >= v_i and coalesce(p.agendado_em, p.agendado_auto_em) < v_f) x
           where x.agente_id is not null group by x.agente_id),
  prim as (select distinct on (m.conversa_id) m.conversa_id, m.agente_id, m.criado_em as quando
             from public.mensagens m join cv on cv.id = m.conversa_id
            where (cv.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate and m.autor = 'agente' and m.agente_id is not null
            order by m.conversa_id, m.criado_em),
  resp as (select prim.agente_id, count(*) as primeiras,
                  round((percentile_cont(0.5) within group (order by extract(epoch from (prim.quando - cv.criado_em)) / 60))::numeric, 0) as espera_mediana_min
             from prim join cv on cv.id = prim.conversa_id where prim.quando >= cv.criado_em group by prim.agente_id),
  av as (select a.conversa_id, a.nota_atendimento from public.avaliacao_atendimento a join cv on cv.id = a.conversa_id
          where (a.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
  prin as (select distinct on (x.conversa_id) x.conversa_id, x.agente_id
             from (select m.conversa_id, m.agente_id, count(*) as n from public.mensagens m
                    where m.conversa_id in (select conversa_id from av) and m.autor = 'agente' and m.agente_id is not null group by 1, 2) x
            order by x.conversa_id, x.n desc),
  nota as (select prin.agente_id, count(*) as n, round(avg(av.nota_atendimento)::numeric, 1) as media
             from av join prin on prin.conversa_id = av.conversa_id group by prin.agente_id),
  pes as (select q.nome, coalesce(msg.conversas, 0) as conversas, coalesce(agd.n, 0) as agendados, coalesce(agd.n_auto, 0) as agendados_automaticos, coalesce(agd.n_mao, 0) as agendados_a_mao, coalesce(agd.n_canc, 0) as agendados_cancelados, coalesce(nota.n, 0) as avaliacoes, nota.media as nota_media,
                 coalesce(resp.primeiras, 0) as primeiras, resp.espera_mediana_min
            from quem q left join msg on msg.agente_id = q.id left join agd on agd.agente_id = q.id left join nota on nota.agente_id = q.id left join resp on resp.agente_id = q.id
           where q.papel = 'atendente' or coalesce(msg.conversas, 0) > 0 or coalesce(agd.n, 0) > 0 or coalesce(agd.n_canc, 0) > 0)
  select jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'pessoas', coalesce((select jsonb_agg(to_jsonb(p) order by p.nome) from pes p), '[]'::jsonb),
    'nota_media_geral', (select round(avg(nota_atendimento)::numeric, 1) from av join prin on prin.conversa_id = av.conversa_id where prin.agente_id in (select id from quem)))
    into v_out;
  return v_out;
end $function$;

-- Parte 6: painel_indicadores_equipe
CREATE OR REPLACE FUNCTION public.painel_indicadores_equipe(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_nivel text := public.org_nivel(); v_uid uuid := (select auth.uid()); v_de timestamptz; v_ate timestamptz; v_res jsonb;
begin
  if v_nivel is null then raise exception 'Não autorizado.' using errcode = '42501'; end if;
  p_de := coalesce(p_de, ((now() at time zone 'America/Sao_Paulo')::date - 29));
  p_ate := coalesce(p_ate, (now() at time zone 'America/Sao_Paulo')::date);
  if p_ate < p_de or p_ate - p_de > 400 then raise exception 'Período inválido.' using errcode = '22023'; end if;
  v_de := (p_de::timestamp at time zone 'America/Sao_Paulo'); v_ate := ((p_ate + 1)::timestamp at time zone 'America/Sao_Paulo');
  with quem as (
    select a.id, a.nome from public.agentes a
     where a.ativo and a.papel in ('admin', 'atendente')
       and (v_nivel in ('ti', 'gerente') or a.id = v_uid
            or (v_nivel = 'supervisor' and exists (select 1 from public.org_membro s join public.org_membro t on t.equipe_id = s.equipe_id
                                                    where s.agente_id = v_uid and s.funcao = 'supervisor' and s.ativo and t.agente_id = a.id and t.ativo)))),
  cv as (select c.id from public.conversas c where p_incluir_teste or not c.teste),
  msg as (select m.agente_id, count(*) as mensagens, count(distinct m.conversa_id) as conversas
            from public.mensagens m join cv on cv.id = m.conversa_id
           where m.autor = 'agente' and m.agente_id is not null and m.criado_em >= v_de and m.criado_em < v_ate group by m.agente_id),
  assum as (select e.para_agente as agente_id, count(*) as n from public.conversa_evento e join cv on cv.id = e.conversa_id
             where e.tipo = 'assumida' and e.em >= v_de and e.em < v_ate and e.para_agente is not null group by e.para_agente),
  enc as (select ce.por as agente_id, count(*) as n from public.conversa_encerramento ce join cv on cv.id = ce.conversa_id
           where ce.encerrada_em >= v_de and ce.encerrada_em < v_ate and ce.por is not null group by ce.por),
  -- Mesma regra do painel_indicadores_atendentes (v1.1, 17/11/2026): quem marcou à mão; senão quem escreveu na conversa (o dono, se escreveu); marcação cancelada de verdade no Klingo não conta (remarcada continua contando).
  agd as (select x.agente_id, count(*) as n
            from (select coalesce(p.agendado_por, (select m.agente_id from public.mensagens m where m.conversa_id = p.conversa_id and m.autor = 'agente' and m.agente_id is not null
                                       group by m.agente_id order by (m.agente_id = c.agente_id) desc, count(*) desc, m.agente_id limit 1)) as agente_id,
                         (coalesce(cardinality(p.klingo_marcacoes), 0) > 0 and not exists (select 1 from unnest(p.klingo_marcacoes) u
                            where not exists (select 1 from public.klingo_conferencia z where z.m = u::text and z.status_klingo = 'Cancelada'))
                         and not exists (select 1 from unnest(p.klingo_marcacoes) u2 join public.jornada_exame je on je.marcacao_id = 'm' || u2 where je.status = 'remarcado')) as cancelado
                    from public.pre_agendamentos p join cv on cv.id = p.conversa_id join public.conversas c on c.id = p.conversa_id
                   where coalesce(p.agendado_em, p.agendado_auto_em) >= v_de and coalesce(p.agendado_em, p.agendado_auto_em) < v_ate) x
           where x.agente_id is not null and not x.cancelado group by x.agente_id),
  tf as (select e.por as agente_id, count(*) as n from public.conversa_evento e join cv on cv.id = e.conversa_id
          where e.tipo = 'transferencia' and e.em >= v_de and e.em < v_ate and e.por is not null group by e.por),
  tr as (select e.para_agente as agente_id, count(*) as n from public.conversa_evento e join cv on cv.id = e.conversa_id
          where e.tipo = 'transferencia' and e.em >= v_de and e.em < v_ate and e.para_agente is not null group by e.para_agente),
  pes as (select q.id, q.nome, coalesce(msg.conversas, 0) as conversas_participou, coalesce(msg.mensagens, 0) as mensagens, coalesce(assum.n, 0) as assumidas, coalesce(enc.n, 0) as encerradas,
                 coalesce(agd.n, 0) as agendados, coalesce(tf.n, 0) as transferiu, coalesce(tr.n, 0) as recebeu
            from quem q left join msg on msg.agente_id = q.id left join assum on assum.agente_id = q.id left join enc on enc.agente_id = q.id
            left join agd on agd.agente_id = q.id left join tf on tf.agente_id = q.id left join tr on tr.agente_id = q.id)
  select jsonb_build_object('de', p_de, 'ate', p_ate, 'incluir_teste', p_incluir_teste,
    'pessoas', coalesce((select jsonb_agg(to_jsonb(p) order by p.nome) from pes p), '[]'::jsonb),
    'equipes', coalesce((select jsonb_agg(jsonb_build_object('equipe', x.nome, 'unidade', x.unidade, 'pessoas', x.pessoas, 'conversas_participou', x.conv, 'mensagens', x.msgs, 'encerradas', x.enc, 'agendados', x.agd, 'transferencias', x.tf) order by x.nome)
                          from (select e.nome, e.unidade, count(distinct p.id) as pessoas, coalesce(sum(p.conversas_participou), 0) as conv, coalesce(sum(p.mensagens), 0) as msgs,
                                       coalesce(sum(p.encerradas), 0) as enc, coalesce(sum(p.agendados), 0) as agd, coalesce(sum(p.transferiu), 0) as tf
                                  from public.org_equipe e join public.org_membro m on m.equipe_id = e.id and m.ativo and m.agente_id is not null join pes p on p.id = m.agente_id
                                 group by e.id) x), '[]'::jsonb),
    'agendados_pelo_sistema', (select count(*) from public.pre_agendamentos p join cv on cv.id = p.conversa_id where p.agendado_auto_em >= v_de and p.agendado_auto_em < v_ate))
    into v_res;
  return v_res;
end $function$;

