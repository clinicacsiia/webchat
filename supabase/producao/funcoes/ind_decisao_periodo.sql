-- public.ind_decisao_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_decisao_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_chat jsonb; v_cli jsonb;
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
                                         when 'dados' then 5 when 'confirmacao' then 6 when 'pronto' then 7 else 1 end end) as r
           from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id group by cv.pessoa),
  ult as (select distinct on (cv.pessoa) cv.pessoa, cv.status as ult_status, cv.motivo_encerramento as ult_motivo from cv order by cv.pessoa, cv.criado_em desc),
  ag as (select cv.pessoa, bool_or(cv.primeiro_humano_em is not null) as humano, bool_or(cv.motivo_encerramento = 'agendado') as marcou_motivo from cv group by cv.pessoa),
  pes as (select ag.pessoa, ag.humano,
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
    'espera_mediana_min', (select round(med::numeric, 0) from espera)
  ) into v_chat;

  with
  ex as (select e.status, e.confirm_status, e.operadora, e.unidade, e.agendado_em, e.agendado_para, e.marcacao_id,
                lower(btrim(coalesce(e.cancelamento_motivo, ''))) as m
           from public.jornada_exame e
          where e.status <> 'pedido'
            and (p_un is null or public.unidade_chave(e.unidade) is null or public.unidade_chave(e.unidade) = p_un)),
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
  return jsonb_build_object('chat', v_chat, 'clinica', v_cli);
end $function$;

