-- FLUXOGRAMA: entrada (banco que já recebeu a v1 de fila-biometria.sql) -> validação (só mexe em funções do módulo; nenhuma tabela nem dado) -> lógica (remove as 3 RPCs antigas com segredo em parâmetro; cria o segredo por cabeçalho x-fila-segredo; recria fila_entrar, fila_reenviar_link e as 3 RPCs do n8n) -> saída (banco idêntico ao da instalação nova de fila-biometria.sql)
-- Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
-- Rodar no SQL Editor do Supabase UMA vez, só em quem já aplicou a v1. Quem instala do zero roda apenas fila-biometria.sql.
-- Os três DROP FUNCTION removem as RPCs da v1 (criadas sem nenhum dado associado). O teste testes/sql-delta.test.mjs prova
-- que v1 + este arquivo = instalação nova.

-- v2: o segredo do n8n passa a vir no cabeçalho x-fila-segredo (credencial Header Auth do n8n), não em parâmetro de função.
drop function if exists public.fila_emitir_token(text, uuid);
drop function if exists public.assinatura_contexto(text, text, text);
drop function if exists public.assinatura_registrar(text, text, text, jsonb, jsonb, text, text);

-- Segredo do n8n vindo do cabeçalho x-fila-segredo (PostgREST expõe os cabeçalhos em request.headers).
create or replace function public.fila_segredo_do_cabecalho() returns text
language plpgsql stable set search_path to '' as $$
begin
  return nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-fila-segredo';
exception when others then
  return null;
end $$;

create or replace function public.fila_n8n_autorizado() returns boolean
language sql stable security definer set search_path to '' as $$
  select public.fila_segredo_ok(public.fila_segredo_do_cabecalho())
$$;

revoke all on function public.fila_segredo_do_cabecalho(), public.fila_n8n_autorizado() from public, anon, authenticated;

create or replace function public.fila_entrar(p_nome text, p_email text, p_telefone text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_nome text := btrim(coalesce(p_nome, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_paciente uuid;
  v_atendimento uuid;
  v_fone text := public.fone_chave(p_telefone);
  v_ativo boolean := coalesce((select valor from public.config where chave = 'fila_webhook_url'), '') <> '';
begin
  perform public.fila_exige_staff();
  if char_length(v_nome) not between 3 and 120 then
    raise exception 'Informe o nome completo do paciente.' using errcode = '22023';
  end if;
  if char_length(v_email) > 200 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'E-mail inválido.' using errcode = '22023';
  end if;

  select p.id into v_paciente from public.pacientes p
   where lower(p.email) = v_email and public.nome_confere(p.nome, v_nome)
   order by p.ultima_visita_em desc limit 1;

  if v_paciente is null then
    insert into public.pacientes (nome, nome_norm, telefones, email)
    values (v_nome, coalesce(public.norm_nome(v_nome), upper(v_nome)),
            case when v_fone is null then '{}'::text[] else array[v_fone] end, v_email)
    returning id into v_paciente;
  else
    update public.pacientes set ultima_visita_em = now(), atualizado_em = now(),
           telefones = case when v_fone is null or v_fone = any(telefones) then telefones else telefones || v_fone end
     where id = v_paciente;
  end if;

  begin
    insert into public.atendimentos (paciente_id, email_informado) values (v_paciente, v_email) returning id into v_atendimento;
  exception when unique_violation then
    raise exception 'Este paciente já está na fila ou em atendimento.' using errcode = '23505';
  end;

  perform public.fila_avisar_n8n(v_atendimento);
  return jsonb_build_object('atendimento_id', v_atendimento, 'paciente_id', v_paciente, 'link_agendado', v_ativo);
end $$;

create or replace function public.fila_reenviar_link(p_atendimento uuid) returns void
language plpgsql security definer set search_path to '' as $$
begin
  perform public.fila_exige_staff();
  if not exists (select 1 from public.atendimentos where id = p_atendimento and status in ('aguardando', 'assinatura_pendente')) then
    raise exception 'Este atendimento não está na fila.' using errcode = 'P0001';
  end if;
  if coalesce((select valor from public.config where chave = 'fila_webhook_url'), '') = '' then
    raise exception 'O envio do link por e-mail ainda não está configurado (config.fila_webhook_url).' using errcode = 'P0001';
  end if;
  perform public.fila_avisar_n8n(p_atendimento);
end $$;

create or replace function public.fila_emitir_token(p_atendimento uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  a public.atendimentos%rowtype;
  v_nome text;
  v_agora bigint := floor(extract(epoch from now()))::bigint;
  v_exp bigint := floor(extract(epoch from now()))::bigint + 4 * 3600;
begin
  if not public.fila_n8n_autorizado() then
    raise exception 'Não autorizado.' using errcode = '42501';
  end if;
  select * into a from public.atendimentos where id = p_atendimento for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'atendimento_inexistente');
  end if;
  if a.status not in ('aguardando', 'assinatura_pendente') then
    return jsonb_build_object('ok', false, 'erro', 'fora_da_fila');
  end if;
  if a.links_enviados >= 10 then
    return jsonb_build_object('ok', false, 'erro', 'limite_de_envios');
  end if;
  select nome into v_nome from public.pacientes where id = a.paciente_id;
  update public.atendimentos set links_enviados = links_enviados + 1 where id = a.id;
  return jsonb_build_object(
    'ok', true,
    'token', public.fila_jwt_assinar(jsonb_build_object(
      'aud', 'fila', 'atendimento_id', a.id, 'email_informado', a.email_informado,
      'iat', v_agora, 'exp', v_exp, 'jti', gen_random_uuid())),
    'nome', v_nome,
    'email', a.email_informado,
    'expira_em', to_timestamp(v_exp));
end $$;

create or replace function public.assinatura_contexto(p_token text, p_hash text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_claims jsonb;
  a public.atendimentos%rowtype;
  v_perfil jsonb;
begin
  if not public.fila_n8n_autorizado() then
    raise exception 'Não autorizado.' using errcode = '42501';
  end if;
  v_claims := public.fila_jwt_validar(p_token);
  if v_claims is null then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  select * into a from public.atendimentos where id = (v_claims ->> 'atendimento_id')::uuid;
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
  select perfil_biometrico_historico into v_perfil from public.pacientes where id = a.paciente_id;
  return jsonb_build_object('ok', true, 'perfil', coalesce(v_perfil, '{}'::jsonb), 'tentativas_falhas', a.tentativas_falhas);
end $$;

create or replace function public.assinatura_registrar(
  p_token text, p_hash text, p_resultado jsonb, p_pontos jsonb, p_ip text, p_user_agent text
) returns jsonb
language plpgsql security definer set search_path to '' as $$
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
  if not public.fila_n8n_autorizado() then
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

  -- CASE em vez de OR: o SQL não garante curto-circuito, e jsonb_array_length lança erro em quem não é array.
  if not coalesce(case when jsonb_typeof(p_pontos) = 'array' then jsonb_array_length(p_pontos) between 20 and 5000 end, false)
     or jsonb_typeof(p_resultado) is distinct from 'object'
     or coalesce(p_resultado ->> 'consentimento', 'false') <> 'true' then
    return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
  end if;

  select perfil_biometrico_historico into v_perfil from public.pacientes where id = a.paciente_id for update;
  v_n_atual := coalesce((v_perfil ->> 'n')::integer, 0);
  v_n_base := (p_resultado ->> 'perfil_n_base')::integer;
  if v_n_base is distinct from v_n_atual then
    return jsonb_build_object('ok', false, 'erro', 'conflito');   -- outro envio mudou o perfil: tentar de novo, sem contar
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
end $$;

revoke all on function public.fila_emitir_token(uuid), public.assinatura_contexto(text, text),
  public.assinatura_registrar(text, text, jsonb, jsonb, text, text) from public;
grant execute on function public.fila_emitir_token(uuid), public.assinatura_contexto(text, text),
  public.assinatura_registrar(text, text, jsonb, jsonb, text, text) to anon, authenticated;
