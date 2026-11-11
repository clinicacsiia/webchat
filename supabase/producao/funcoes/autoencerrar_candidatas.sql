-- public.autoencerrar_candidatas()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.autoencerrar_candidatas()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select c.id from public.conversas c
   where c.status = 'em_atendimento' and c.aguarda_paciente_desde is not null and c.chamar_zap_em is null
     and c.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())
     and not exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = any (public.pessoa_membros(c.id)))
     and not exists (select 1 from public.conversas m where m.id = any (public.pessoa_membros(c.id)) and m.status <> 'encerrada'
                        and not (m.status = 'em_atendimento' and m.aguarda_paciente_desde is not null
                                 and m.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())))
$function$;

