-- public.convenios_painel()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenios_painel()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  with ops as (
    select ch, min(nome) nome from (
      select public.convenio_chave(operadora) ch, operadora nome from public.catalogo_plano where nullif(btrim(operadora), '') is not null and operadora !~* '^teste$'
      union all select public.convenio_chave(operadora), operadora from public.jornada_exame where nullif(btrim(operadora), '') is not null
      union all select public.convenio_chave(operadora), operadora from public.catalogo_preco where fonte = 'convenio' and nullif(btrim(operadora), '') is not null
      union all select operadora, initcap(lower(operadora)) from public.convenio_config
    ) u where ch !~ '^(PARTICULAR.*|TESTE)$' group by ch),
  dem as (select * from public.convenio_demanda()),
  tot as (select greatest(sum(d.ult_30d), 0) t30 from dem d where d.chave !~ '^PARTICULAR'),
  pl as (select public.convenio_chave(operadora) ch, count(*)::int n from public.catalogo_plano where coalesce(ativo, true) group by 1),
  pr as (select public.convenio_chave(operadora) ch, count(distinct procedimento_id)::int procs,
           (count(distinct procedimento_id) filter (where confianca = 'alta'))::int alta, (count(distinct procedimento_id) filter (where confianca = 'media'))::int media,
           (count(distinct procedimento_id) filter (where confianca = 'baixa'))::int baixa, max(visto_em) visto
         from public.catalogo_preco where fonte = 'convenio' and status = 'ativo' group by 1),
  ult as (select distinct on (public.convenio_chave(e.operadora)) public.convenio_chave(e.operadora) ch, e.procedimento, e.agendado_para
          from public.jornada_exame e where nullif(btrim(e.operadora), '') is not null and e.agendado_para <= now() and e.cancelamento_motivo is null and coalesce(e.status, '') !~* 'cancel|desmarc'
          order by public.convenio_chave(e.operadora), e.agendado_para desc),
  val as (select distinct on (public.convenio_chave(o.operadora)) public.convenio_chave(o.operadora) ch, o.procedimento, o.valor_tipico, o.amostras, o.janela_fim
          from public.preco_observado o where o.valor_tipico is not null order by public.convenio_chave(o.operadora), o.atualizado_em desc, o.janela_fim desc),
  ev as (select e.operadora ch, count(*)::int n, (count(*) filter (where e.relevante))::int rel from public.convenio_evento e where e.visto_em is null group by 1),
  chat as (select public.convenio_chave(pa.plano) ch, count(*)::int n30, (count(*) filter (where pa.status = 'rascunho' and pa.atualizado_em < now() - interval '24 hours'))::int aband
           from public.pre_agendamentos pa where pa.plano is not null and pa.criado_em >= now() - interval '30 days' group by 1),
  linhas as (
    select jsonb_build_object(
      'operadora', o.nome, 'chave', o.ch,
      'ativo', coalesce(c.ativo, true), 'mensagem_inativo', c.mensagem_inativo, 'aviso', c.aviso, 'um_por_vez', coalesce(c.um_por_vez, false), 'msg_varios', c.msg_varios, 'motivo', c.motivo,
      'atualizado_em', c.atualizado_em, 'atualizado_por', (select a.nome from public.agentes a where a.id = c.atualizado_por),
      'planos', coalesce(pl.n, 0),
      'precos', jsonb_build_object('procedimentos', coalesce(pr.procs, 0), 'alta', coalesce(pr.alta, 0), 'media', coalesce(pr.media, 0), 'baixa', coalesce(pr.baixa, 0), 'visto_em', pr.visto),
      'ultimo_exame', case when ult.ch is not null then jsonb_build_object('procedimento', ult.procedimento, 'quando', ult.agendado_para) end,
      'ultimo_valor', case when val.ch is not null then jsonb_build_object('procedimento', val.procedimento, 'valor', val.valor_tipico, 'amostras', val.amostras, 'ate', val.janela_fim) end,
      'demanda', jsonb_build_object('semanas', coalesce(d.semanas, '{}'::int[]), 'total', coalesce(d.total, 0), 'ult_30d', coalesce(d.ult_30d, 0), 'ant_30d', coalesce(d.ant_30d, 0),
        'previsao_30d', coalesce(d.previsao_30d, 0), 'tendencia_pct', d.tendencia_pct, 'confiavel', coalesce(d.confiavel, false),
        'participacao_pct', case when tot.t30 > 0 then round(coalesce(d.ult_30d, 0) * 100.0 / tot.t30, 1) else 0 end),
      'chat_30d', coalesce(chat.n30, 0), 'chat_abandonados', coalesce(chat.aband, 0),
      'em_andamento', (select count(*) from public.pre_agendamentos pa where public.convenio_chave(pa.plano) = o.ch and pa.status = 'rascunho'),
      'avisos_novos', coalesce(ev.n, 0), 'avisos_relevantes', coalesce(ev.rel, 0)) j,
      coalesce(d.ult_30d, 0) u30, o.nome
    from ops o left join public.convenio_config c on c.operadora = o.ch left join pl on pl.ch = o.ch left join pr on pr.ch = o.ch left join ult on ult.ch = o.ch left join val on val.ch = o.ch
      left join dem d on d.chave = o.ch left join ev on ev.ch = o.ch left join chat on chat.ch = o.ch cross join tot)
  select jsonb_build_object(
    'gerado_em', now(),
    'convenios', coalesce((select jsonb_agg(j order by u30 desc, nome) from linhas), '[]'::jsonb),
    'particular', jsonb_build_object(
      'precos', (select jsonb_build_object('procedimentos', count(distinct procedimento_id), 'alta', count(distinct procedimento_id) filter (where confianca = 'alta'),
                   'media', count(distinct procedimento_id) filter (where confianca = 'media'), 'baixa', count(distinct procedimento_id) filter (where confianca = 'baixa'), 'visto_em', max(visto_em))
                 from public.catalogo_preco where fonte = 'particular' and status = 'ativo'),
      'mudancas_30d', (select count(*) from public.convenio_evento where tipo = 'preco_particular' and criado_em >= now() - interval '30 days'),
      'avisos_novos', (select count(*) from public.convenio_evento where operadora ~ '^PARTICULAR' and visto_em is null)),
    'padroes', jsonb_build_object('mensagem_inativo', public.fluxo_t('convenio_inativo'), 'msg_varios', public.fluxo_t('convenio_varios')),
    'avisos_novos', (select count(*) from public.convenio_evento where visto_em is null))
  into r;
  return r;
end $function$;

