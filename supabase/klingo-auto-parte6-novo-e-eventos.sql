-- Autoatendimento com a API do Klingo — Parte 6: paciente novo (pré-cadastro único por CPF) e avisos do Klingo (webhook). Escrito em 12/11/2026.
--
-- FLUXOGRAMA: paciente novo (CPF não achado no Klingo) -> klingo_pre_reservar trava por hash do CPF (1 pré-cadastro por pessoa, mesmo com 2 conversas ao mesmo tempo; resposta perdida do register vira
--   "bloqueado" e a equipe resolve) -> klingo-executar chama /externo/register -> klingo_pre_gravar guarda o id (sem "P") em klingo_identidade -> o login usa o número puro e confere id, nome e nascimento.
--   Webhook: o Klingo avisa (cancelou, remarcou, chegou) -> klingo-webhook confere o cabeçalho e chama klingo_evento_aplicar (idempotente por hash do evento) -> o pedido ligado pelo voucher é atualizado.
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão.
-- Para voltar atrás: update public.config set valor = 'nao' where chave in ('klingo_api_pre_cadastro', 'klingo_webhook'); drop function public.klingo_pre_reservar(uuid, text, date), klingo_pre_gravar(uuid, text, date, text), klingo_evento_aplicar(jsonb).

create or replace function public.klingo_pre_reservar(p_op uuid, p_cpf text, p_nasc date) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'); v_hash text; v_ex public.klingo_identidade; v_rid text;
begin
  if not public.fluxo_cpf_ok(v_cpf) then raise exception 'CPF inválido' using errcode = '22023'; end if;
  v_hash := public.klingo_hash(v_cpf);
  perform pg_advisory_xact_lock(hashtext('pre:' || v_hash));
  select * into v_ex from public.klingo_identidade where cpf_hash = v_hash and tipo = 'pre' limit 1;
  if v_ex.id is not null then return jsonb_build_object('acao', 'existente', 'klingo_id', v_ex.klingo_id); end if;
  -- o registro foi feito por outra operação mas a gravação da identidade falhou: reaproveita o id guardado na operação
  select o.detalhe ->> 'registro_id' into v_rid from public.klingo_operacao o where o.detalhe ->> 'cpf_hash' = v_hash and o.detalhe ? 'registro_id' order by o.criado_em desc limit 1;
  if v_rid is not null then return jsonb_build_object('acao', 'existente', 'klingo_id', v_rid); end if;
  -- outra operação já começou (ou deixou incerto) um registro para este CPF: NUNCA registra de novo
  if exists (select 1 from public.klingo_operacao o where o.id <> p_op and o.detalhe ->> 'cpf_hash' = v_hash and o.detalhe ? 'registro_iniciado_em'
              and ((o.detalhe ->> 'registro_iniciado_em')::timestamptz > now() - interval '3 minutes' or o.estado = 'incerto' or o.codigo = 'registro_incerto')
              and not (o.detalhe ? 'registro_id')) then
    return jsonb_build_object('acao', 'bloqueado');
  end if;
  update public.klingo_operacao set detalhe = detalhe || jsonb_build_object('cpf_hash', v_hash, 'registro_iniciado_em', now()) where id = p_op;
  return jsonb_build_object('acao', 'criar');
end $$;

create or replace function public.klingo_pre_gravar(p_op uuid, p_cpf text, p_nasc date, p_klingo_id text) returns void
language plpgsql security definer set search_path to '' as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
begin
  if p_klingo_id !~ '^[0-9]+$' then raise exception 'id de pré-cadastro inválido' using errcode = '22023'; end if;
  -- o id fica na operação ANTES de tudo: se a gravação abaixo falhar, o pré-cadastro criado não se perde
  update public.klingo_operacao set detalhe = detalhe || jsonb_build_object('registro_id', p_klingo_id) where id = p_op;
  begin
    insert into public.klingo_identidade (chave, cpf_hash, tipo, klingo_id, situacao, criado_pela_operacao)
    values (public.klingo_hash(v_cpf || '|' || p_nasc::text), public.klingo_hash(v_cpf), 'pre', p_klingo_id, 'pre_cadastro', p_op)
    on conflict (chave) do update set tipo = 'pre', klingo_id = excluded.klingo_id, situacao = 'pre_cadastro', criado_pela_operacao = p_op, conferido_em = now();
  exception when unique_violation then null;
  end;
  perform public.klingo_medir('pre_cadastro_criado');
end $$;

-- Aviso do Klingo (webhook). p = {evento, id_marcacao, status, checkin, nova, motivo}
create or replace function public.klingo_evento_aplicar(p jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_ev text := left(coalesce(p ->> 'evento', ''), 40); v_id text := left(coalesce(p ->> 'id_marcacao', ''), 30); v_st text := left(coalesce(p ->> 'status', ''), 5); v_nova text := left(coalesce(p ->> 'nova', ''), 30);
  v_hash text; v_ev_id bigint; pa public.pre_agendamentos; v_res text := 'sem_pedido';
begin
  if v_id !~ '^[0-9]+$' then return jsonb_build_object('ok', false, 'motivo', 'id_invalido'); end if;
  v_hash := encode(sha256(convert_to(v_ev || '|' || v_id || '|' || v_st || '|' || coalesce(p ->> 'checkin', '') || '|' || v_nova, 'UTF8')), 'hex');
  insert into public.klingo_evento (hash, evento, id_marcacao, status) values (v_hash, v_ev, v_id, v_st) on conflict (hash) do nothing returning id into v_ev_id;
  if v_ev_id is null then return jsonb_build_object('ok', true, 'duplicado', true); end if;
  select * into pa from public.pre_agendamentos where klingo_marcacoes @> array[v_id] limit 1;
  if pa.id is not null then
    if v_nova ~ '^[0-9]+$' then   -- remarcação: o pedido passa a apontar para a marcação nova
      update public.pre_agendamentos set klingo_marcacoes = array_replace(klingo_marcacoes, v_id, v_nova) where id = pa.id;
      perform public.fluxo_nota(pa.conversa_id, 'Klingo avisou: a marcação foi remarcada (a nova é a ' || v_nova || ').');
      v_res := 'remarcada';
    elsif v_st = 'C' and pa.status = 'agendado' then   -- cancelada no Klingo
      update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', atualizado_em = now() where id = pa.id;
      perform public.fluxo_nota(pa.conversa_id, 'Klingo avisou: a marcação ' || v_id || ' foi CANCELADA.');
      v_res := 'cancelada';
    elsif nullif(p ->> 'checkin', '') is not null then
      perform public.fluxo_nota(pa.conversa_id, 'Klingo avisou: o paciente fez check-in.');
      v_res := 'checkin';
    else v_res := 'sem_efeito';
    end if;
  end if;
  update public.klingo_evento set processado_em = now(), resultado = v_res where id = v_ev_id;
  perform public.klingo_medir('evento_' || v_res);
  return jsonb_build_object('ok', true, 'resultado', v_res);
end $$;

-- O executor pode demorar (marcar chega a 25 s): o pg_net espera até 110 s
create or replace function pg_temp.trocar(t text, velho text, novo text) returns text language plpgsql as $t$
begin
  if position(novo in t) > 0 then return t; end if;   -- já aplicado: a migração pode ser repetida sem estragar
  if (length(t) - length(replace(t, velho, ''))) / greatest(length(velho), 1) <> 1 then raise exception 'trecho nao encontrado exatamente uma vez: %', left(velho, 60); end if;
  return replace(t, velho, novo);
end $t$;
do $do$ declare d text;
begin
  d := pg_get_functiondef('public.klingo_operacao_disparar(uuid)'::regprocedure);
  d := pg_temp.trocar(d, 'timeout_milliseconds := 60000', 'timeout_milliseconds := 110000');
  execute d;
end $do$;

do $do$ declare f text; begin
  for f in select unnest(array['klingo_pre_reservar(uuid, text, date)', 'klingo_pre_gravar(uuid, text, date, text)', 'klingo_evento_aplicar(jsonb)']) loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $do$;
