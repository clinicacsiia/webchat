-- public.klingo_agendamento_passar(p_ip text, p_acao text, p_cpf text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_agendamento_passar(p_ip text, p_acao text, p_cpf text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                          declare
                            v_ip text; v_cpf text; v_escrita boolean; v_modo text; v_mestre text; v_id bigint;
                              v_lim_min int; v_lim_esc_ip int; v_lim_div_ip int; v_lim_esc_cpf int; v_lim_div_cpf int;
                                v_n int;
                                  v_motivo text;
                                  begin
                                    v_escrita := p_acao in ('atualizar_contato','reservar','soltar','marcar','remarcar','cancelar','trocar_procedimento','checkin','cancelar_checkin','cadastrar');
                                      select coalesce(valor, 'sim') into v_modo from public.config where chave = 'agendamento_externo_modo';
                                        select coalesce(valor, 'sim') into v_mestre from public.config where chave = 'klingo_auto';
                                          v_modo := coalesce(v_modo, 'sim');
                                            v_lim_min := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_ip_por_minuto'), 60);
                                              v_lim_esc_ip := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_ip_escritas_hora'), 30);
                                                v_lim_div_ip := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_ip_divergentes_hora'), 15);
                                                  v_lim_esc_cpf := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_cpf_escritas_hora'), 8);
                                                    v_lim_div_cpf := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_cpf_divergentes_dia'), 10);

                                                      v_ip := public.klingo_hash('ip|' || coalesce(nullif(trim(p_ip), ''), 'desconhecido'));
                                                        v_cpf := case when p_cpf is null or p_cpf = '' then null else public.klingo_hash(regexp_replace(p_cpf, '\D', '', 'g')) end;

                                                          -- 1) chaves de desligamento (a gestão pode recuar sem publicar nada)
                                                            if v_modo = 'nao' then v_motivo := 'desligado';
                                                              elsif v_escrita and v_modo = 'leitura' then v_motivo := 'escrita_desligada';
                                                                end if;

                                                                  -- 2) ritmo por IP (qualquer ação)
                                                                    if v_motivo is null then
                                                                        select count(*) into v_n from public.klingo_agendamento_evento where ip_hash = v_ip and em > now() - interval '1 minute';
                                                                            if v_n >= v_lim_min then v_motivo := 'ip_ritmo'; end if;
                                                                              end if;
                                                                                -- 3) escritas por IP e por CPF; nascimentos errados por IP e por CPF
                                                                                  if v_motivo is null and v_escrita then
                                                                                      select count(*) into v_n from public.klingo_agendamento_evento where ip_hash = v_ip and escrita and em > now() - interval '1 hour' and coalesce(resultado, 'ok') not like 'bloqueado%';
                                                                                          if v_n >= v_lim_esc_ip then v_motivo := 'ip_escritas'; end if;
                                                                                              if v_motivo is null and v_cpf is not null then
                                                                                                    select count(*) into v_n from public.klingo_agendamento_evento where cpf_hash = v_cpf and escrita and em > now() - interval '1 hour' and coalesce(resultado, 'ok') not like 'bloqueado%';
                                                                                                          if v_n >= v_lim_esc_cpf then v_motivo := 'cpf_escritas'; end if;
                                                                                                              end if;
                                                                                                                end if;
                                                                                                                  if v_motivo is null then
                                                                                                                      select count(*) into v_n from public.klingo_agendamento_evento where ip_hash = v_ip and resultado = 'divergente' and em > now() - interval '1 hour';
                                                                                                                          if v_n >= v_lim_div_ip then v_motivo := 'ip_divergentes'; end if;
                                                                                                                            end if;
                                                                                                                              if v_motivo is null and v_cpf is not null then
                                                                                                                                  select count(*) into v_n from public.klingo_agendamento_evento where cpf_hash = v_cpf and resultado = 'divergente' and em > now() - interval '1 day';
                                                                                                                                      if v_n >= v_lim_div_cpf then v_motivo := 'cpf_divergentes'; end if;
                                                                                                                                        end if;

                                                                                                                                          insert into public.klingo_agendamento_evento (ip_hash, cpf_hash, acao, escrita, resultado)
                                                                                                                                            values (v_ip, v_cpf, left(coalesce(p_acao, ''), 40), v_escrita, case when v_motivo is null then null else 'bloqueado_' || v_motivo end)
                                                                                                                                              returning id into v_id;

                                                                                                                                                -- limpeza leve (retenção de 30 dias), sem custo no caminho normal
                                                                                                                                                  if v_id % 50 = 0 then delete from public.klingo_agendamento_evento where em < now() - interval '30 days'; end if;

                                                                                                                                                    if v_motivo is not null then return jsonb_build_object('ok', false, 'motivo', v_motivo, 'id', v_id); end if;
                                                                                                                                                      return jsonb_build_object('ok', true, 'id', v_id);
                                                                                                                                                      end
                                                                                                                                                      $function$;

