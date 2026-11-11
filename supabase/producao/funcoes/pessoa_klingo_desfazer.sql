-- public.pessoa_klingo_desfazer(p_prontuario text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pessoa_klingo_desfazer(p_prontuario text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                                                                                                                                                                                                                                                                                                                                                                                                begin
                                                                                                                                                                                                                                                                                                                                                                                                  perform public.pessoa_equipe();
                                                                                                                                                                                                                                                                                                                                                                                                    delete from public.pessoa_klingo_vinculo where prontuario = p_prontuario;
                                                                                                                                                                                                                                                                                                                                                                                                      return jsonb_build_object('ok', true);
                                                                                                                                                                                                                                                                                                                                                                                                      end $function$;

