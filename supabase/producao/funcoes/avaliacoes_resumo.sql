-- public.avaliacoes_resumo(p_dias integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.avaliacoes_resumo(p_dias integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d integer := greatest(1, least(coalesce(p_dias, 30), 365));
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Apenas administradores.' using errcode = '42501'; end if;
  return jsonb_build_object('dias', d,
    'total', (select count(*) from public.avaliacao_atendimento where criado_em >= now() - make_interval(days => d)),
    'media_atendimento', (select round(avg(nota_atendimento)::numeric, 1) from public.avaliacao_atendimento where criado_em >= now() - make_interval(days => d)),
    'media_site', (select round(avg(nota_site)::numeric, 1) from public.avaliacao_atendimento where criado_em >= now() - make_interval(days => d)),
    'por_canal', coalesce((select jsonb_object_agg(canal, n) from (select canal, count(*) n from public.avaliacao_atendimento where criado_em >= now() - make_interval(days => d) group by canal) x), '{}'::jsonb));
end $function$;

