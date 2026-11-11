-- public.painel_indicadores_unidade(p_dias integer, p_unidade text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_unidade(p_dias integer DEFAULT 0, p_unidade text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ini timestamptz := case when p_dias = -1 then ((v_hoje - 1)::timestamp at time zone 'America/Sao_Paulo')
    when coalesce(p_dias, 0) > 0 then ((v_hoje - (least(p_dias, 3650) - 1))::timestamp at time zone 'America/Sao_Paulo') else '-infinity'::timestamptz end;
  v_fim timestamptz := case when p_dias = -1 then (v_hoje::timestamp at time zone 'America/Sao_Paulo') else 'infinity'::timestamptz end;
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
      from public.conversas c join pu on pu.conversa_id = c.id where c.criado_em >= v_ini and c.criado_em < v_fim),
  pe as (
    select p.conversa_id, p.status, p.agendado_auto_em, (p.criado_em at time zone 'America/Sao_Paulo')::date as dia
      from public.pre_agendamentos p join pu on pu.conversa_id = p.conversa_id where p.criado_em >= v_ini and p.criado_em < v_fim),
  en as (
    select e.motivo, e.origem from public.conversa_encerramento e join pu on pu.conversa_id = e.conversa_id where e.encerrada_em >= v_ini and e.encerrada_em < v_fim),
  av as (
    select a.nota_atendimento, a.nota_site, a.canal
      from public.avaliacao_atendimento a left join pu on pu.conversa_id = a.conversa_id
     where a.criado_em >= v_ini and a.criado_em < v_fim and (v_un is null or pu.conversa_id is not null))
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
end $function$;

