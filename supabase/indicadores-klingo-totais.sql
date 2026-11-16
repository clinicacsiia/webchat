-- FLUXOGRAMA: Klingo (relatório #14554 em klingo_conferencia) -> indicadores: total, canceladas e ativas em cada bloco
-- Versão 1.0 — 16/11/2026 / Mudança: (1) cadastros do autoatendimento passam a respeitar o período (antes somava a tabela inteira); (2) conferência devolve canceladas e ativas; (3) agendamentos por atendente devolvem quantos estão cancelados no Klingo; (4) autoatendimento devolve quantas marcações certas já estão canceladas no Klingo.
-- Rollback: reaplicar as 3 funções de supabase/producao/funcoes/ (versão anterior do retrato).
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
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje); v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400); v_dias := greatest(v_ate - v_de + 1, 1);
  return jsonb_build_object(
    'modos', jsonb_build_object('mestre', public.klingo_mestre(), 'horarios', public.klingo_cfg('klingo_api_horarios', 'nao'), 'marcar', public.klingo_cfg('klingo_api_marcar', 'nao'), 'percentual', public.klingo_cfg('klingo_api_percentual', '100'),
                                'pre_cadastro', public.klingo_cfg('klingo_api_pre_cadastro', 'nao'), 'webhook', public.klingo_cfg('klingo_webhook', 'nao'), 'autogestao', public.klingo_cfg('klingo_autogestao', 'sim')),
    'operacoes', (select coalesce(jsonb_object_agg(estado, n), '{}'::jsonb) from (select estado, count(*) n from public.klingo_operacao where tipo = 'marcar'
                    and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by estado) x),
    'agendadas_sozinhas', (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
                            where pa.agendado_origem = 'chat_api' and not c.teste and (pa.agendado_auto_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'resolvidas_sem_humano', (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
                               where pa.agendado_origem = 'chat_api' and not c.teste and c.primeiro_humano_em is null and (pa.agendado_auto_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'marcar_canceladas_no_klingo', (select count(*) from public.klingo_operacao o join public.klingo_conferencia k on k.m = o.voucher_id
                                     where o.tipo = 'marcar' and o.estado = 'sucesso' and k.status_klingo = 'Cancelada' and (o.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'tempo_medio_s', (select round(avg(extract(epoch from concluido_em - criado_em)))::int from public.klingo_operacao where tipo = 'marcar' and estado = 'sucesso' and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'motivos_falha', (select coalesce(jsonb_agg(jsonb_build_object('codigo', codigo, 'n', n) order by n desc), '[]'::jsonb) from (select coalesce(codigo, 'sem_codigo') codigo, count(*) n
                       from public.klingo_operacao where tipo = 'marcar' and estado in ('falha', 'incerto') and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by 1 order by 2 desc limit 8) x),
    'pos', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select tipo || ':' || estado k, count(*) n from public.klingo_operacao where tipo in ('cancelar', 'remarcar', 'ler_vouchers') and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by 1) x),
    'cadastros', (select coalesce(jsonb_object_agg(situacao, n), '{}'::jsonb) from (select situacao, count(*) n from public.klingo_identidade where (conferido_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by situacao) x),
    'convenios', jsonb_build_object('traduzidos', (select count(*) from public.klingo_plano_map where origem <> 'nao_atende'), 'sem_traducao', (select count(*) from public.klingo_plano_map where origem = 'nao_atende')),
    'horarios_api', jsonb_build_object('ok', public.klingo_medida_soma('horarios_api_ok', v_dias), 'erro', public.klingo_medida_soma('horarios_api_erro', v_dias), 'limite', public.klingo_medida_soma('horarios_api_limite', v_dias),
                      'api_total', public.klingo_medida_soma('sombra_api', v_dias), 'api_na_grade', public.klingo_medida_soma('sombra_api_na_grade', v_dias)),
    'decisoes', (select coalesce(jsonb_agg(jsonb_build_object('em', em, 'chave', chave, 'de', de, 'para', para) order by em desc), '[]'::jsonb) from (select * from public.klingo_decisao order by em desc limit 5) d),
    'gerado_em', now());
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
  dias as (select d::date as d from generate_series(v_de, v_ate, interval '1 day') d)
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


-- public.painel_indicadores_atendentes(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
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
          where v_un is null or x.chaves is null or cardinality(x.chaves) = 0 or v_un = any (x.chaves)),
  cv as (select c.id, c.criado_em from public.conversas c join pu on pu.conversa_id = c.id where p_incluir_teste or not c.teste),
  msg as (select m.agente_id, count(distinct m.conversa_id) as conversas from public.mensagens m join cv on cv.id = m.conversa_id
           where m.autor = 'agente' and m.agente_id is not null and m.criado_em >= v_i and m.criado_em < v_f group by m.agente_id),
  -- Crédito do agendamento: quem marcou à mão; se o sistema confirmou sozinho com o Klingo, o dono da conversa; sem dono, quem mais escreveu nela. Sem ninguém: fica só no total do sistema.
  agd as (select x.agente_id, count(*) as n, count(*) filter (where x.automatico) as n_auto, count(*) filter (where x.cancelado) as n_canc
            from (select coalesce(p.agendado_por, c.agente_id, (select m.agente_id from public.mensagens m where m.conversa_id = p.conversa_id and m.autor = 'agente' and m.agente_id is not null
                                                                  group by m.agente_id order by count(*) desc, m.agente_id limit 1)) as agente_id,
                         p.agendado_por is null as automatico,
                         (coalesce(cardinality(p.klingo_marcacoes), 0) > 0 and not exists (select 1 from unnest(p.klingo_marcacoes) u
                            where not exists (select 1 from public.klingo_conferencia z where z.m = u::text and z.status_klingo = 'Cancelada'))) as cancelado
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
  pes as (select q.nome, coalesce(msg.conversas, 0) as conversas, coalesce(agd.n, 0) as agendados, coalesce(agd.n_auto, 0) as agendados_automaticos, coalesce(agd.n_canc, 0) as agendados_cancelados, coalesce(nota.n, 0) as avaliacoes, nota.media as nota_media,
                 coalesce(resp.primeiras, 0) as primeiras, resp.espera_mediana_min
            from quem q left join msg on msg.agente_id = q.id left join agd on agd.agente_id = q.id left join nota on nota.agente_id = q.id left join resp on resp.agente_id = q.id
           where q.papel = 'atendente' or coalesce(msg.conversas, 0) > 0 or coalesce(agd.n, 0) > 0)
  select jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'pessoas', coalesce((select jsonb_agg(to_jsonb(p) order by p.nome) from pes p), '[]'::jsonb),
    'nota_media_geral', (select round(avg(nota_atendimento)::numeric, 1) from av join prin on prin.conversa_id = av.conversa_id where prin.agente_id in (select id from quem)))
    into v_out;
  return v_out;
end $function$;

