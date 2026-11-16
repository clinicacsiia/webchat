-- FLUXOGRAMA: entrada (a atendente abre "Marcações" na conversa e, se quiser, cancela uma) -> validação (só admin e atendente; as chaves klingo_api_consultar / klingo_api_cancelar da conversa ligadas;
--   CPF e nascimento já conferidos; só cancela voucher que apareceu numa consulta feita há menos de 10 min) -> processamento (cria klingo_operacao "ler_vouchers" ou "cancelar" com detalhe.por = 'painel' e chama a MESMA
--   Edge Function klingo-executar do chat: ela abre a sessão do paciente, confere a identidade e só cancela voucher ATIVO dele) -> persistência (klingo_marcacao, nota interna do resumo) -> saída (jsonb enxuto)
--   O PACIENTE NÃO RECEBE MENSAGEM NENHUMA por este caminho: quem avisa é a atendente.
-- Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (Etapa 3 do plano docs/plano-painel-agenda-2026-11-16.md: ver e cancelar marcações pelo painel). Remarcar fica para a próxima.
-- Pré-requisitos: klingo_operacao, klingo_marcacao, klingo_ativo, klingo_dados_conversa, klingo_operacao_disparar, klingo_cancelamento_aplicar, fluxo_nota, papel_atual (todas já na produção).
-- ROLLBACK: drop function public.painel_marcacoes_pedir(uuid); drop function public.painel_marcacoes(uuid); drop function public.painel_marcacao_cancelar(uuid, text); drop function public.painel_marcacao_op(uuid);
--   e restaurar klingo_cancelamento_aplicar de supabase/producao/funcoes/klingo_cancelamento_aplicar.sql (versão de 16/11/2026 antes desta mudança).
-- Aplicar em partes (a ferramenta expira em 60 s): 1) klingo_cancelamento_aplicar, 2) painel_marcacoes_pedir e painel_marcacoes, 3) painel_marcacao_cancelar e painel_marcacao_op.

-- ===== 1. O cancelamento pedido pelo painel não fala com o paciente =====
create or replace function public.klingo_cancelamento_aplicar(p_op uuid, p_estado text, p_cod text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare op public.klingo_operacao; ctx jsonb; v_vou text; v_res text; v_pos text; v_quem text;
begin
  select * into op from public.klingo_operacao where id = p_op;
  v_vou := op.detalhe ->> 'voucher';
  -- Pedido da equipe (painel): só atualiza as marcações e deixa uma nota para a equipe. Nada de mensagem, transferência ou passo do chat para o paciente.
  if op.detalhe ->> 'por' = 'painel' then
    select a.nome into v_quem from public.agentes a where a.id::text = op.detalhe ->> 'agente';
    if p_estado = 'sucesso' then
      update public.klingo_marcacao set situacao = 'cancelada', consultado_em = now() where voucher = v_vou and situacao in ('ativa', 'nao_listada');
      update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', conferencia_em = now(), atualizado_em = now() where klingo_marcacoes @> array[v_vou] and status = 'agendado';
      perform public.fluxo_nota(op.conversa_id, 'Marcação ' || coalesce(v_vou, '?') || ' cancelada no Klingo pelo painel' || coalesce(' (' || v_quem || ')', '') || '.');
      return jsonb_build_object('ok', true, 'estado', 'sucesso');
    end if;
    perform public.fluxo_nota(op.conversa_id, 'Cancelamento pelo painel NÃO concluído (' || coalesce(p_cod, 'falha') || '). A marcação ' || coalesce(v_vou, '?') || ' pode continuar ATIVA no Klingo: conferir'
      || case when p_estado = 'incerto' then ' ANTES de qualquer nova tentativa.' else '.' end);
    return jsonb_build_object('ok', true, 'estado', p_estado);
  end if;
  ctx := public.fluxo_ctx(op.conversa_id);
  select public.klingo_marc_resumo(op.conversa_id, v_vou) into v_res;
  select passo into v_pos from public.conversa_fluxo where conversa_id = op.conversa_id;
  if p_estado = 'sucesso' then
    update public.klingo_marcacao set situacao = 'cancelada', consultado_em = now() where voucher = v_vou and situacao in ('ativa', 'nao_listada');
    update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', conferencia_em = now(), atualizado_em = now() where klingo_marcacoes @> array[v_vou] and status = 'agendado';
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'pos', 'marc_voucher', null, 'marc_acao', null));
    perform public.fluxo_perguntar(op.conversa_id, 'marc_pos', public.fluxo_t('marc_cancelado', ctx) || coalesce(E'\n\n' || v_res, ''));
    return jsonb_build_object('ok', true, 'estado', 'sucesso');
  end if;
  perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_acao', null));
  perform public.fluxo_nota(op.conversa_id, 'Cancelamento automático NÃO concluído (' || coalesce(p_cod, 'falha') || '). A marcação ' || coalesce(v_vou, '?') || ' pode continuar ATIVA no Klingo: conferir' || case when p_estado = 'incerto' then ' ANTES de qualquer nova tentativa.' else '.' end);
  perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('cancelar_equipe', ctx));
  perform public.fluxo_transferir(op.conversa_id, 'Paciente pediu para cancelar a marcação ' || coalesce(v_vou, '?') || ' e o cancelamento automático não concluiu (' || coalesce(p_cod, 'falha') || ').', case when p_estado = 'incerto' then 'media' else 'baixa' end, false);
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $$;

-- ===== 2. Ver as marcações do paciente =====
create or replace function public.painel_marcacoes_pedir(p_conversa uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare d jsonb; v_op uuid; v_falta text[];
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  if not public.klingo_ativo(p_conversa, 'klingo_api_consultar') then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  d := public.klingo_dados_conversa(p_conversa);
  v_falta := array_remove(array[case when d ->> 'cpf' is null then 'CPF' end, case when d ->> 'nascimento' is null then 'data de nascimento' end], null);
  if cardinality(v_falta) > 0 then return jsonb_build_object('ok', false, 'motivo', 'dados_incompletos', 'faltando', to_jsonb(v_falta)); end if;
  -- se o paciente está no passo de ver marcações do chat, não mexe: o fluxo dele reagiria ao resultado
  if exists (select 1 from public.conversa_fluxo where conversa_id = p_conversa and passo like 'marc\_%') then return jsonb_build_object('ok', false, 'motivo', 'paciente_vendo'); end if;
  select id into v_op from public.klingo_operacao where conversa_id = p_conversa and tipo = 'ler_vouchers' and detalhe ->> 'por' = 'painel' and estado in ('pendente', 'executando') and criado_em > now() - interval '3 minutes' order by criado_em desc limit 1;
  if v_op is null then
    insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, origem, detalhe)
    values (p_conversa, nullif(d ->> 'pre_agendamento_id', '')::uuid, 'ler_vouchers', 'ler:' || p_conversa::text || ':' || gen_random_uuid()::text, 'equipe', jsonb_build_object('por', 'painel', 'agente', auth.uid())) returning id into v_op;
    perform public.klingo_operacao_disparar(v_op);
    perform public.klingo_medir('op_criada');
  end if;
  return jsonb_build_object('ok', true, 'op', v_op);
end $$;

create or replace function public.painel_marcacoes(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_hoje date := (now() at time zone 'America/Bahia')::date; o record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  select estado, codigo, criado_em into o from public.klingo_operacao where conversa_id = p_conversa and tipo = 'ler_vouchers' and detalhe ->> 'por' = 'painel' order by criado_em desc limit 1;
  return jsonb_build_object('consulta', case when o.estado is null then null else jsonb_build_object('estado', o.estado, 'codigo', o.codigo, 'em', o.criado_em) end,
    'marcacoes', coalesce((select jsonb_agg(jsonb_build_object('voucher', m.voucher, 'procedimento', m.procedimento, 'unidade', m.unidade, 'profissional', m.profissional, 'data', m.data, 'hora', m.hora, 'origem', m.origem, 'consultado_em', m.consultado_em) order by m.data, m.hora)
      from public.klingo_marcacao m where m.conversa_id = p_conversa and m.situacao = 'ativa' and m.data >= v_hoje), '[]'::jsonb));
end $$;

-- ===== 3. Cancelar uma marcação =====
create or replace function public.painel_marcacao_cancelar(p_conversa uuid, p_voucher text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_hoje date := (now() at time zone 'America/Bahia')::date; m public.klingo_marcacao; v_op uuid; v_est text; v_pa uuid;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if p_voucher is null or p_voucher !~ '^\d+$' then raise exception 'Marcação inválida.' using errcode = '22023'; end if;
  if not public.klingo_ativo(p_conversa, 'klingo_api_cancelar') then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into m from public.klingo_marcacao where conversa_id = p_conversa and voucher = p_voucher and situacao = 'ativa' and data >= v_hoje;
  if m.voucher is null then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrada'); end if;
  -- só cancela o que a equipe acabou de ver: lista com mais de 10 minutos pede nova consulta
  if m.consultado_em < now() - interval '10 minutes' then return jsonb_build_object('ok', false, 'motivo', 'lista_antiga'); end if;
  select id, estado into v_op, v_est from public.klingo_operacao where conversa_id = p_conversa and tipo = 'cancelar' and detalhe ->> 'voucher' = p_voucher and estado in ('pendente', 'executando', 'incerto') order by criado_em desc limit 1;
  if v_op is not null then
    return case when v_est = 'incerto' then jsonb_build_object('ok', false, 'motivo', 'incerto_conferir', 'op', v_op) else jsonb_build_object('ok', true, 'op', v_op, 'repetido', true) end;
  end if;
  select (public.klingo_dados_conversa(p_conversa) ->> 'pre_agendamento_id')::uuid into v_pa;
  insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, origem, detalhe)
  values (p_conversa, v_pa, 'cancelar', 'cancelar:' || p_conversa::text || ':' || p_voucher || ':' || gen_random_uuid()::text, 'equipe',
          jsonb_build_object('voucher', p_voucher, 'origem', 'marcacoes', 'por', 'painel', 'agente', auth.uid())) returning id into v_op;
  perform public.klingo_operacao_disparar(v_op);
  perform public.klingo_medir('op_criada');
  return jsonb_build_object('ok', true, 'op', v_op);
end $$;

create or replace function public.painel_marcacao_op(p_op uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare o record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  select tipo, estado, codigo into o from public.klingo_operacao where id = p_op and detalhe ->> 'por' = 'painel';
  if o.tipo is null then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrada'); end if;
  return jsonb_build_object('ok', true, 'tipo', o.tipo, 'estado', o.estado, 'codigo', o.codigo);
end $$;

revoke all on function public.painel_marcacoes_pedir(uuid) from public, anon;
revoke all on function public.painel_marcacoes(uuid) from public, anon;
revoke all on function public.painel_marcacao_cancelar(uuid, text) from public, anon;
revoke all on function public.painel_marcacao_op(uuid) from public, anon;
grant execute on function public.painel_marcacoes_pedir(uuid) to authenticated, service_role;
grant execute on function public.painel_marcacoes(uuid) to authenticated, service_role;
grant execute on function public.painel_marcacao_cancelar(uuid, text) to authenticated, service_role;
grant execute on function public.painel_marcacao_op(uuid) to authenticated, service_role;
