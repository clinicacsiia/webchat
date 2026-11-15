-- public.app_dados_atualizar(p_token text, p_conversa uuid, p_conv_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_dados_atualizar(p_token text, p_conversa uuid, p_conv_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; r record; d jsonb; pa public.pre_agendamentos; v_cpf text; v_nasc date; v_mudou boolean := false;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  begin perform public.chat_valida(p_conversa, p_conv_token);
  exception when others then return jsonb_build_object('ok', false, 'erro', 'conversa'); end;
  select * into r from public.app_chat_pessoa(s.o_pac, p_conversa);
  if r.o_erro is not null then return jsonb_build_object('ok', false, 'erro', r.o_erro); end if;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  v_cpf := regexp_replace(coalesce(d -> 'digitado' ->> 'cpf', pa.paciente ->> 'cpf', ''), '\D', '', 'g');
  v_nasc := coalesce(public.app_data_flex(d -> 'digitado' ->> 'dt_nasc'), public.app_data_flex(pa.paciente ->> 'dt_nasc'));
  if v_cpf ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(v_cpf) and v_cpf is distinct from r.o_cpf then
    if r.o_eu then update public.app_paciente set cpf = v_cpf, atualizado_em = now() where id = s.o_pac; perform public.app_conferir_cadastro(s.o_pac);
    else update public.app_filho set cpf = v_cpf where id = r.o_filho; end if;
    v_mudou := true;
  end if;
  if v_nasc is not null and v_nasc between date '1900-01-01' and public.app_hoje() and v_nasc is distinct from r.o_nasc then
    if r.o_eu and public.app_idade(v_nasc) >= 18 then update public.app_paciente set nascimento = v_nasc, atualizado_em = now() where id = s.o_pac; v_mudou := true;
    elsif not r.o_eu then update public.app_filho set nascimento = v_nasc where id = r.o_filho; v_mudou := true; end if;
  end if;
  if v_mudou then perform public.app_evento_gravar(s.o_pac, 'dados_atualizados_no_chat'); end if;
  return jsonb_build_object('ok', true, 'atualizou', v_mudou, 'perfil', public.app_perfil_json(s.o_pac));
end $function$;

