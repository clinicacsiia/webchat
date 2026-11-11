-- public.conta_paciente_excluir(p_confirmacao text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_excluir(p_confirmacao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                                                                                                                                                                                                                                                                declare v_uid uuid := (select auth.uid()); v_cp public.contas_paciente; v_conv int;
                                                                                                                                                                                                                                                                begin
                                                                                                                                                                                                                                                                  select * into v_cp from public.contas_paciente where id = v_uid;
                                                                                                                                                                                                                                                                    if v_uid is null or not found then raise exception 'Entre na sua conta para apagá-la.' using errcode = '42501'; end if;
                                                                                                                                                                                                                                                                      if p_confirmacao is distinct from 'EXCLUIR' then raise exception 'Confirmação ausente: a conta não foi apagada.' using errcode = '22023'; end if;
                                                                                                                                                                                                                                                                        select count(*) into v_conv from public.conversas where conta_id = v_uid;
                                                                                                                                                                                                                                                                          insert into public.conta_paciente_evento (tipo, tinha_cadastro, conversas) values ('exclusao', v_cp.paciente_id is not null, v_conv);
                                                                                                                                                                                                                                                                            delete from auth.users where id = v_uid;   -- contas_paciente sai em cascata; conversas.conta_id vira nulo
                                                                                                                                                                                                                                                                              return jsonb_build_object('ok', true, 'continua_guardado', jsonb_build_array('cadastro', 'pedidos', 'conversas', 'historico'));
                                                                                                                                                                                                                                                                              end $function$;

