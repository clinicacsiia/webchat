-- public.klingo_agendamento_resultado(p_id bigint, p_resultado text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_agendamento_resultado(p_id bigint, p_resultado text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                                                                                                                                                        update public.klingo_agendamento_evento
                                                                                                                                                             set resultado = p_resultado
                                                                                                                                                                where id = p_id
                                                                                                                                                                     and p_resultado in ('ok', 'recusado', 'divergente')
                                                                                                                                                                          and (resultado is null or p_resultado = 'divergente');
                                                                                                                                                                          $function$;

