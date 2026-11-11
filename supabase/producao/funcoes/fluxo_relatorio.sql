-- public.fluxo_relatorio(p_dias integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fluxo_relatorio(p_dias integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ini timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_dias, 7), 90))); r jsonb;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select jsonb_build_object(
    'conversas', (select count(*) from public.conversas c where c.motor = 'fluxo' and c.criado_em >= v_ini),
    'passos', coalesce((select jsonb_agg(jsonb_build_object('passo', coalesce(f.passo, 'inicio'), 'conversas', f.n) order by f.n desc)
                        from (select f.passo, count(*) n from public.conversa_fluxo f join public.conversas c on c.id = f.conversa_id where c.criado_em >= v_ini group by f.passo) f), '[]'::jsonb),
    'ms_servidor_p50', (select round(percentile_cont(0.5) within group (order by ms)::numeric, 1) from public.fluxo_evento where criado_em >= v_ini and ms is not null),
    'ms_servidor_p95', (select round(percentile_cont(0.95) within group (order by ms)::numeric, 1) from public.fluxo_evento where criado_em >= v_ini and ms is not null),
    'ms_paciente_p50', (select percentile_cont(0.5) within group (order by ms_cliente) from public.fluxo_evento where criado_em >= v_ini and ms_cliente is not null),
    'ms_paciente_p95', (select percentile_cont(0.95) within group (order by ms_cliente) from public.fluxo_evento where criado_em >= v_ini and ms_cliente is not null),
    'nao_entendidos', (select count(*) from public.fluxo_evento where criado_em >= v_ini and not entendido),
    'erros', (select count(*) from public.fluxo_evento where criado_em >= v_ini and passo = 'erro'),
    'notas', coalesce((select jsonb_agg(x order by x ->> 'quando' desc) from (
        select jsonb_build_object('conversa_id', f.conversa_id, 'nota', n, 'quando', f.atualizado_em) x
        from public.conversa_fluxo f cross join lateral jsonb_array_elements_text(coalesce(f.dados -> 'notas', '[]'::jsonb)) n
        where f.atualizado_em >= v_ini order by f.atualizado_em desc limit 60) q), '[]'::jsonb))
  into r;
  return r;
end $function$;

