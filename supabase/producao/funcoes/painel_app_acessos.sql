-- public.painel_app_acessos(p_paciente uuid, p_limite integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_app_acessos(p_paciente uuid DEFAULT NULL::uuid, p_limite integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê os acessos.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(r order by r ->> 'em' desc) from (
    select jsonb_build_object('paciente_id', l.paciente_id, 'nome', a.nome, 'evento', l.evento, 'em', l.em, 'ip', l.ip, 'aparelho', ap.aparelho, 'agente', l.agente, 'fuso', l.fuso,
      'na_clinica', l.na_clinica, 'distancia_m', l.distancia_m, 'precisao_m', l.precisao_m, 'local_negado', l.local_negado, 'exames_hoje', l.exames_hoje,
      'divergente', coalesce(l.exames_hoje, 0) > 0 and l.na_clinica is false) as r
    from public.app_acesso_log l join public.app_paciente a on a.id = l.paciente_id left join public.app_aparelho ap on ap.id = l.aparelho_id
    where p_paciente is null or l.paciente_id = p_paciente
    order by l.em desc limit least(greatest(coalesce(p_limite, 50), 1), 300)) x), '[]'::jsonb);
end $function$;

