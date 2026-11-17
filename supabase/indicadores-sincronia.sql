-- FLUXOGRAMA: auditoria de 17/11/2026 -> mesma regra em todos os blocos (teste fora; funil e conferência iguais; autoatendimento sem teste e com data futura segura)
-- Versão 1.0 — 17/11/2026 / Mudança: (1) `ind_decisao_periodo` e `painel_indicadores_mensal` deixam de contar exames de marcação ligada a conversa de teste (cartão "Marcações novas" 319 -> 318, igual à conferência); (2) `painel_indicadores_conferencia` passa a ler pessoas/pedido pronto/agendaram do próprio funil (antes outra regra: 13 e 18 contra 14 e 21); (3) `painel_automacao_resumo` exclui operações de conversa de teste e não esvazia quando a data inicial é depois de hoje.
-- Aplicado como migrações `indicadores_sincronia_parte1..4`. Rollback: reaplicar as versões anteriores destas 4 funções (retrato de 16/11/2026, git: commit 635f184).
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
            and (p_teste or e.marcacao_id not in (select 'm' || z.m from public.klingo_conferencia z join public.conversas c on c.id = z.conversa_id where c.teste))
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


-- public.painel_indicadores_conferencia(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
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
  dias as (select d::date as d from generate_series(v_de, v_ate, interval '1 day') d),
  fn as materialized (select public.ind_decisao_periodo(v_de, v_ate, v_un, coalesce(p_incluir_teste, false)) -> 'chat' -> 'funil' as f)
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'ultima_leitura', (select max(lido_em) from k),
    'dias_sem_leitura', coalesce((select jsonb_agg(d.d order by d.d) from dias d where not exists (select 1 from k where k.marcado_em = d.d)), '[]'::jsonb),
    'total', (select count(*) from k),
    'canceladas', (select count(*) from k where status_klingo = 'Cancelada'),
    'ativas', (select count(*) from k where status_klingo is distinct from 'Cancelada'),
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
        'marcacoes_ligadas_canceladas', (select count(*) from k where tem_conversa and status_klingo = 'Cancelada'),
        'por_ligacao', coalesce((select jsonb_object_agg(ligacao, n) from (select ligacao, count(*) as n from k where tem_conversa group by 1) q), '{}'::jsonb),
        'por_origem', coalesce((select jsonb_object_agg(o, n) from (select origem as o, count(*) as n from k where tem_conversa group by 1) q), '{}'::jsonb),
        'exames', (select jsonb_build_object(
            'atendido', count(*) filter (where st_banco = 'atendido'), 'faltou', count(*) filter (where st_banco = 'faltou'),
            'por_vir', count(*) filter (where st_banco in ('agendado', 'confirmado')), 'cancelado_ou_remarcado', count(*) filter (where st_banco in ('cancelado', 'remarcado')),
            'ainda_fora_do_banco', count(*) filter (where st_banco is null)) from k where tem_conversa),
        'pessoas_que_procuraram', (select (f ->> 'entraram')::int from fn),
        'atendidas_pela_equipe', (select count(distinct pessoa) from cv where primeiro_humano_em is not null),
        'com_pedido_pronto', (select (f ->> 'completo')::int from fn),
        'agendaram_no_chat', (select (f ->> 'agendaram')::int from fn),
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

-- public.painel_automacao_resumo(p_de date, p_ate date)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_automacao_resumo(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; v_ate date; v_de date; v_dias integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem estes números.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje); v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400); if v_de > v_ate then v_de := v_ate; end if; v_dias := greatest(v_ate - v_de + 1, 1);
  return jsonb_build_object(
    'modos', jsonb_build_object('mestre', public.klingo_mestre(), 'horarios', public.klingo_cfg('klingo_api_horarios', 'nao'), 'marcar', public.klingo_cfg('klingo_api_marcar', 'nao'), 'percentual', public.klingo_cfg('klingo_api_percentual', '100'),
                                'pre_cadastro', public.klingo_cfg('klingo_api_pre_cadastro', 'nao'), 'webhook', public.klingo_cfg('klingo_webhook', 'nao'), 'autogestao', public.klingo_cfg('klingo_autogestao', 'sim')),
    'operacoes', (select coalesce(jsonb_object_agg(estado, n), '{}'::jsonb) from (select estado, count(*) n from public.klingo_operacao where (conversa_id is null or conversa_id not in (select id from public.conversas where teste)) and tipo = 'marcar'
                    and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by estado) x),
    'agendadas_sozinhas', (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
                            where pa.agendado_origem = 'chat_api' and not c.teste and (pa.agendado_auto_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'resolvidas_sem_humano', (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
                               where pa.agendado_origem = 'chat_api' and not c.teste and c.primeiro_humano_em is null and (pa.agendado_auto_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'marcar_canceladas_no_klingo', (select count(*) from public.klingo_operacao o join public.klingo_conferencia k on k.m = o.voucher_id
                                     where (o.conversa_id is null or o.conversa_id not in (select id from public.conversas where teste)) and o.tipo = 'marcar' and o.estado = 'sucesso' and k.status_klingo = 'Cancelada' and (o.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'tempo_medio_s', (select round(avg(extract(epoch from concluido_em - criado_em)))::int from public.klingo_operacao where (conversa_id is null or conversa_id not in (select id from public.conversas where teste)) and tipo = 'marcar' and estado = 'sucesso' and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'motivos_falha', (select coalesce(jsonb_agg(jsonb_build_object('codigo', codigo, 'n', n) order by n desc), '[]'::jsonb) from (select coalesce(codigo, 'sem_codigo') codigo, count(*) n
                       from public.klingo_operacao where (conversa_id is null or conversa_id not in (select id from public.conversas where teste)) and tipo = 'marcar' and estado in ('falha', 'incerto') and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by 1 order by 2 desc limit 8) x),
    'pos', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select tipo || ':' || estado k, count(*) n from public.klingo_operacao where (conversa_id is null or conversa_id not in (select id from public.conversas where teste)) and tipo in ('cancelar', 'remarcar', 'ler_vouchers') and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by 1) x),
    'cadastros', (select coalesce(jsonb_object_agg(situacao, n), '{}'::jsonb) from (select situacao, count(*) n from public.klingo_identidade where (conferido_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by situacao) x),
    'convenios', jsonb_build_object('traduzidos', (select count(*) from public.klingo_plano_map where origem <> 'nao_atende'), 'sem_traducao', (select count(*) from public.klingo_plano_map where origem = 'nao_atende')),
    'horarios_api', jsonb_build_object('ok', public.klingo_medida_soma('horarios_api_ok', v_dias), 'erro', public.klingo_medida_soma('horarios_api_erro', v_dias), 'limite', public.klingo_medida_soma('horarios_api_limite', v_dias),
                      'api_total', public.klingo_medida_soma('sombra_api', v_dias), 'api_na_grade', public.klingo_medida_soma('sombra_api_na_grade', v_dias)),
    'decisoes', (select coalesce(jsonb_agg(jsonb_build_object('em', em, 'chave', chave, 'de', de, 'para', para) order by em desc), '[]'::jsonb) from (select * from public.klingo_decisao order by em desc limit 5) d),
    'gerado_em', now());
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
      select jsonb_agg(jsonb_build_object('mes', to_char(m.d, 'YYYY-MM'),
               'total', coalesce(x.total, 0), 'atendidos', coalesce(x.atendidos, 0), 'faltaram', coalesce(x.faltaram, 0),
               'cancelados', coalesce(x.cancelados, 0), 'remarcados', coalesce(x.remarcados, 0), 'por_vir', coalesce(x.por_vir, 0)) order by m.d)
        from generate_series(v_ini, v_mes_atual, interval '1 month') as m(d)
        left join (
          select date_trunc('month', e.agendado_para at time zone 'America/Sao_Paulo')::date as mes,
                 count(*) as total,
                 count(*) filter (where e.status = 'atendido') as atendidos,
                 count(*) filter (where e.status = 'faltou') as faltaram,
                 count(*) filter (where e.status = 'cancelado') as cancelados,
                 count(*) filter (where e.status = 'remarcado') as remarcados,
                 count(*) filter (where e.status in ('agendado', 'confirmado')) as por_vir
            from public.jornada_exame e
           where e.status <> 'pedido' and e.agendado_para is not null
             and e.marcacao_id not in (select 'm' || z.m from public.klingo_conferencia z join public.conversas c on c.id = z.conversa_id where c.teste)
             and (v_un is null or public.unidade_chave(e.unidade) is null or public.unidade_chave(e.unidade) = v_un)
           group by 1) x on x.mes = m.d), '[]'::jsonb));
end $function$;
