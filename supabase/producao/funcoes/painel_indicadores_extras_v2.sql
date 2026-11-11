-- public.painel_indicadores_extras_v2(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_extras_v2(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ate date := least(coalesce(p_ate, (now() at time zone 'America/Sao_Paulo')::date), (now() at time zone 'America/Sao_Paulo')::date);
  v_de date;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_admin boolean := coalesce((select public.papel_atual()), '') = 'admin';
  v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  with pu as (select x.conversa_id from public.painel_conversa_pessoa_un() x
               where v_un is null or x.chaves is null or cardinality(x.chaves) = 0 or v_un = any (x.chaves)),
  h as (select extract(hour from c.criado_em at time zone 'America/Sao_Paulo')::integer as hora, count(*) as n
          from public.conversas c join pu on pu.conversa_id = c.id
         where (p_incluir_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by 1),
  av as (select a.nota_atendimento, a.nota_site, a.canal
           from public.avaliacao_atendimento a join public.conversas c on c.id = a.conversa_id join pu on pu.conversa_id = c.id
          where (p_incluir_teste or not c.teste) and (a.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
  pe as (select p.conversa_id, p.status, (p.criado_em at time zone 'America/Sao_Paulo')::date as d_cri,
                (coalesce(p.agendado_em, p.agendado_auto_em, p.atualizado_em) at time zone 'America/Sao_Paulo')::date as d_ag, (p.agendado_auto_em is not null) as sistema
           from public.pre_agendamentos p join public.conversas c on c.id = p.conversa_id join pu on pu.conversa_id = p.conversa_id
          where (p_incluir_teste or not c.teste))
  select jsonb_build_object(
    'por_hora', coalesce((select jsonb_agg(jsonb_build_object('hora', h.hora, 'conversas', h.n) order by h.hora) from h), '[]'::jsonb),
    'pedidos', jsonb_build_object(
        'conversas_com_pedido_completo', (select count(distinct conversa_id) from pe where status in ('pronto', 'agendado') and d_cri between v_de and v_ate),
        'agendados', (select count(*) from pe where status = 'agendado' and d_ag between v_de and v_ate),
        'agendados_pelo_sistema', (select count(*) from pe where status = 'agendado' and sistema and d_ag between v_de and v_ate),
        'agendados_pela_equipe', (select count(*) from pe where status = 'agendado' and not sistema and d_ag between v_de and v_ate),
        'prontos_esperando_recepcao', (select count(*) from pe where status = 'pronto' and d_cri between v_de and v_ate),
        'cancelados', (select count(*) from pe where status = 'cancelado' and d_cri between v_de and v_ate),
        'rascunhos', (select count(*) from pe where status = 'rascunho' and d_cri between v_de and v_ate)),
    'avaliacoes', case when v_admin then jsonb_build_object(
        'total', (select count(*) from av),
        'media_atendimento', (select round(avg(nota_atendimento)::numeric, 1) from av),
        'media_site', (select round(avg(nota_site)::numeric, 1) from av),
        'por_canal', coalesce((select jsonb_object_agg(m.canal, m.n) from (select canal, count(*) as n from av group by canal) m), '{}'::jsonb)) end
  ) into v_out;
  return v_out;
end $function$;

