-- public.autoencerrar_resumo()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.autoencerrar_resumo()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Apenas administradores.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'modo', coalesce((select valor from public.config where chave = 'autoencerrar_modo'), 'desligado'),
    'horas', public.autoencerrar_horas(),
    'elegiveis_agora', (select count(*) from public.autoencerrar_candidatas()),
    'aguardando_paciente', (select count(*) from public.conversas where status = 'em_atendimento' and aguarda_paciente_desde is not null),
    'ultimas', coalesce((select jsonb_agg(x) from (select em, modo, elegiveis, fechadas from public.autoencerramento_execucao order by id desc limit 5) x), '[]'::jsonb));
end $function$;

