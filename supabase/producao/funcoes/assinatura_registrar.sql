-- public.assinatura_registrar(p_segredo text, p_token text, p_hash text, p_resultado jsonb, p_pontos jsonb, p_ip text, p_user_agent text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.assinatura_registrar(p_segredo text, p_token text, p_hash text, p_resultado jsonb, p_pontos jsonb, p_ip text, p_user_agent text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_claims jsonb;
  a public.atendimentos%rowtype;
  v_perfil jsonb;
  v_n_base integer;
  v_n_atual integer;
  v_aprovado boolean;
  v_tipo text;
  v_score numeric;
  v_falhas integer;
  v_bloqueado boolean;
begin
  if not public.fila_segredo_ok(p_segredo) then
    raise exception 'Não autorizado.' using errcode = '42501';
  end if;
  v_claims := public.fila_jwt_validar(p_token);
  if v_claims is null then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  select * into a from public.atendimentos where id = (v_claims ->> 'atendimento_id')::uuid for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  if a.bloqueado_em is not null then
    return jsonb_build_object('ok', false, 'erro', 'bloqueado');
  end if;
  if a.status <> 'assinatura_pendente' then
    return jsonb_build_object('ok', false, 'erro', 'fora_de_assinatura');
  end if;
  if a.documento_hash is distinct from p_hash then
    return jsonb_build_object('ok', false, 'erro', 'documento_diferente');
  end if;

  if not coalesce(case when jsonb_typeof(p_pontos) = 'array' then jsonb_array_length(p_pontos) between 20 and 5000 end, false)
     or jsonb_typeof(p_resultado) is distinct from 'object'
     or coalesce(p_resultado ->> 'consentimento', 'false') <> 'true' then
    return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
  end if;

  select perfil_biometrico_historico into v_perfil from public.pacientes where id = a.paciente_id for update;
  v_n_atual := coalesce((v_perfil ->> 'n')::integer, 0);
  v_n_base := (p_resultado ->> 'perfil_n_base')::integer;
  if v_n_base is distinct from v_n_atual then
    return jsonb_build_object('ok', false, 'erro', 'conflito');
  end if;

  v_aprovado := (p_resultado ->> 'aprovado')::boolean;
  v_tipo := p_resultado ->> 'tipo';
  v_score := (p_resultado ->> 'score')::numeric;

  if v_tipo = 'enrolamento' then
    if v_n_atual <> 0 or v_aprovado is not true or v_score is not null then
      return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
    end if;
  elsif v_tipo = 'comparacao' then
    if v_n_atual = 0 or v_score is null or v_score < 0 or v_score > 1
       or v_aprovado is distinct from (v_score >= 0.30) then
      return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
    end if;
  else
    return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
  end if;

  if v_aprovado then
    if jsonb_typeof(p_resultado -> 'perfil_novo') is distinct from 'object'
       or coalesce((p_resultado -> 'perfil_novo' ->> 'n')::integer, 0) <> v_n_atual + 1 then
      return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
    end if;
    update public.pacientes set perfil_biometrico_historico = p_resultado -> 'perfil_novo', atualizado_em = now()
     where id = a.paciente_id;
    insert into public.registro_assinaturas
      (atendimento_id, email_confirmado_transacao, hash_documento, consentimento_biometrico, tipo_validacao,
       score_similaridade, vetor_traco_bruto, caracteristicas, ip_origem, user_agent)
    values (a.id, v_claims ->> 'email_informado', p_hash, true, v_tipo, v_score, p_pontos,
            coalesce(p_resultado -> 'caracteristicas', '{}'::jsonb), left(p_ip, 45), left(coalesce(p_user_agent, ''), 500));
    update public.atendimentos set status = 'em_atendimento' where id = a.id;
    return jsonb_build_object('ok', true, 'aprovado', true);
  end if;

  v_falhas := a.tentativas_falhas + 1;
  v_bloqueado := v_falhas >= 3;
  update public.atendimentos
     set tentativas_falhas = v_falhas, bloqueado_em = case when v_bloqueado then now() end
   where id = a.id;
  insert into public.assinatura_tentativas (atendimento_id, numero, score_similaridade, ip_origem, user_agent)
  values (a.id, v_falhas, v_score, left(p_ip, 45), left(coalesce(p_user_agent, ''), 500));
  return jsonb_build_object('ok', true, 'aprovado', false,
                            'tentativas_restantes', greatest(3 - v_falhas, 0), 'bloqueado', v_bloqueado);
end $function$;

