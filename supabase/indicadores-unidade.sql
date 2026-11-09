-- Indicadores por unidade e por pessoa (09/11/2026). Só cria/atualiza funções (create or replace; sem drop, sem mexer em tabela). Pode rodar de novo.
-- O que muda:
--   * painel_indicadores_unidade(p_dias, p_unidade): o mesmo resumo de antes, mas obedecendo o filtro de unidade do topo do painel
--     ('csi' | 'rmtc' | 'desenvoar'; nulo = todas), e contando PESSOAS como o painel conta (conversas da mesma pessoa viram uma só).
--     Acrescenta: média de conversas por pessoa, pessoas e média por dia, conversas por hora, motivos de encerramento e avaliações (já filtrados).
--   * Período em dias de calendário (fuso de São Paulo): 1 = hoje, 7 = hoje e os 6 dias anteriores; 0 ou nulo = desde o começo.
--   * painel_indicadores(p_dias) continua existindo (painel antigo aberto no navegador não quebra) e chama a nova sem filtro.
-- Regra de unidade da pessoa (igual à do painel): 1) pedido já agendado e ainda aberto; 2) cartão da Jornada; 3) unidade escolhida no formulário do chat.
--   Sem nenhuma = unidade desconhecida = a pessoa aparece em TODAS as unidades (regra de ouro do painel).
-- ROLLBACK: restaurar painel_indicadores(integer) com supabase/indicadores-painel.sql; drop function public.painel_indicadores_unidade(integer, text); drop function public.painel_conversa_pessoa_un();

-- PARTE 1: pessoa e unidade de cada conversa (uso interno; ninguém de fora chama).
create or replace function public.painel_conversa_pessoa_un() returns table (conversa_id uuid, pessoa text, chaves text[])
language sql stable security definer set search_path to '' as $$
  with g as (
    select c.id, coalesce(cg.grupo_id::text, c.id::text) as pessoa, c.unidade_inicial
      from public.conversas c left join public.conversa_grupo cg on cg.conversa_id = c.id),
  a as (
    select g.pessoa, array_agg(distinct public.unidade_chave(x.unidade)) filter (where public.unidade_chave(x.unidade) is not null) as k
      from g join public.v_agendamento_aberto x on x.conversa_id = g.id group by g.pessoa),
  q as (
    select g.pessoa, array_agg(distinct public.unidade_chave(j.unidade)) filter (where public.unidade_chave(j.unidade) is not null) as k
      from g join public.jornada_card j on j.conversa_id = g.id and j.arquivado_em is null group by g.pessoa),
  f as (
    select g.pessoa, array_agg(distinct public.unidade_chave(g.unidade_inicial)) filter (where public.unidade_chave(g.unidade_inicial) is not null) as k
      from g group by g.pessoa)
  select g.id, g.pessoa, coalesce(a.k, q.k, f.k)
    from g left join a on a.pessoa = g.pessoa left join q on q.pessoa = g.pessoa left join f on f.pessoa = g.pessoa
$$;
revoke all on function public.painel_conversa_pessoa_un() from public, anon, authenticated;

-- PARTE 2: o resumo.
create or replace function public.painel_indicadores_unidade(p_dias integer default 0, p_unidade text default null) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ini timestamptz := case when coalesce(p_dias, 0) > 0
    then ((v_hoje - (least(p_dias, 3650) - 1))::timestamp at time zone 'America/Sao_Paulo') else '-infinity'::timestamptz end;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_admin boolean := coalesce((select public.papel_atual()), '') = 'admin';
  v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;

  with pu as (
    select x.conversa_id, x.pessoa from public.painel_conversa_pessoa_un() x
     where v_un is null or x.chaves is null or cardinality(x.chaves) = 0 or v_un = any (x.chaves)),
  cv as (
    select c.id, c.status, c.criado_em, pu.pessoa,
           (c.criado_em at time zone 'America/Sao_Paulo')::date as dia,
           extract(hour from c.criado_em at time zone 'America/Sao_Paulo')::integer as hora
      from public.conversas c join pu on pu.conversa_id = c.id where c.criado_em >= v_ini),
  pe as (
    select p.conversa_id, p.status, p.agendado_auto_em, (p.criado_em at time zone 'America/Sao_Paulo')::date as dia
      from public.pre_agendamentos p join pu on pu.conversa_id = p.conversa_id where p.criado_em >= v_ini),
  en as (
    select e.motivo, e.origem from public.conversa_encerramento e join pu on pu.conversa_id = e.conversa_id where e.encerrada_em >= v_ini),
  av as (
    select a.nota_atendimento, a.nota_site, a.canal
      from public.avaliacao_atendimento a left join pu on pu.conversa_id = a.conversa_id
     where a.criado_em >= v_ini and (v_un is null or pu.conversa_id is not null))
  select jsonb_build_object(
    'periodo_dias', coalesce(p_dias, 0), 'unidade', v_un,
    'desde', (select min(c.criado_em) from public.conversas c), 'gerado_em', now(),
    'conversas', (select jsonb_build_object(
        'total', count(*), 'pessoas', count(distinct pessoa),
        'finalizadas', count(*) filter (where status = 'encerrada'),
        'em_andamento', count(*) filter (where status <> 'encerrada'),
        'media_por_pessoa', round(count(*)::numeric / nullif(count(distinct pessoa), 0), 2)) from cv),
    'pedidos', (select jsonb_build_object(
        'conversas_com_pedido_completo', count(distinct conversa_id) filter (where status in ('pronto', 'agendado')),
        'agendados', count(*) filter (where status = 'agendado'),
        'agendados_pela_ia', count(*) filter (where status = 'agendado' and agendado_auto_em is not null),
        'agendados_pela_equipe', count(*) filter (where status = 'agendado' and agendado_auto_em is null),
        'prontos_esperando_recepcao', count(*) filter (where status = 'pronto'),
        'cancelados', count(*) filter (where status = 'cancelado'),
        'rascunhos', count(*) filter (where status = 'rascunho')) from pe),
    'por_dia', coalesce((
      select jsonb_agg(jsonb_build_object('dia', d.dia, 'conversas', d.conversas, 'pessoas', d.pessoas, 'finalizadas', d.finalizadas,
               'media_por_pessoa', round(d.conversas::numeric / nullif(d.pessoas, 0), 2),
               'pedidos_completos', coalesce(p.pedidos, 0), 'agendados', coalesce(p.agendados, 0)) order by d.dia)
        from (select dia, count(*) as conversas, count(distinct pessoa) as pessoas, count(*) filter (where status = 'encerrada') as finalizadas from cv group by dia) d
        left join (select dia, count(distinct conversa_id) filter (where status in ('pronto', 'agendado')) as pedidos, count(*) filter (where status = 'agendado') as agendados from pe group by dia) p
          on p.dia = d.dia), '[]'::jsonb),
    'por_hora', coalesce((select jsonb_agg(jsonb_build_object('hora', h.hora, 'conversas', h.n) order by h.hora) from (select hora, count(*) as n from cv group by hora) h), '[]'::jsonb),
    'encerramentos', jsonb_build_object(
        'total', (select count(*) from en), 'automaticos', (select count(*) from en where origem = 'inatividade'),
        'por_motivo', coalesce((select jsonb_object_agg(m.motivo, m.n) from (select coalesce(motivo, 'sem_motivo') as motivo, count(*) as n from en group by 1) m), '{}'::jsonb)),
    'avaliacoes', case when v_admin then jsonb_build_object(
        'total', (select count(*) from av),
        'media_atendimento', (select round(avg(nota_atendimento)::numeric, 1) from av),
        'media_site', (select round(avg(nota_site)::numeric, 1) from av),
        'por_canal', coalesce((select jsonb_object_agg(m.canal, m.n) from (select canal, count(*) as n from av group by canal) m), '{}'::jsonb)) end
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.painel_indicadores_unidade(integer, text) from public, anon;
grant execute on function public.painel_indicadores_unidade(integer, text) to authenticated;

-- PARTE 3: a função antiga segue valendo (todas as unidades).
create or replace function public.painel_indicadores(p_dias integer default 0) returns jsonb
language sql stable security definer set search_path to '' as $$
  select public.painel_indicadores_unidade(p_dias, null)
$$;
revoke all on function public.painel_indicadores(integer) from public, anon;
grant execute on function public.painel_indicadores(integer) to authenticated;
