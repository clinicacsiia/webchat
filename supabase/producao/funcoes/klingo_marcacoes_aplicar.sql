-- public.klingo_marcacoes_aplicar(p_op uuid, p_estado text, p_r jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_marcacoes_aplicar(p_op uuid, p_estado text, p_r jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  op public.klingo_operacao; v_cod text := left(p_r ->> 'codigo', 60); v_n integer := 0; v_fut integer := 0; v_hoje date := (now() at time zone 'America/Bahia')::date; ctx jsonb; v_txt text; v_pos text;
begin
  select * into op from public.klingo_operacao where id = p_op;
  if coalesce((op.detalhe ->> 'resultado')::boolean, false) then return public.klingo_resultados_aplicar(p_op, p_estado, p_r); end if;
  ctx := public.fluxo_ctx(op.conversa_id);
  select passo into v_pos from public.conversa_fluxo where conversa_id = op.conversa_id;
  if p_estado = 'sucesso' and jsonb_typeof(p_r -> 'marcacoes') = 'array' then
    update public.klingo_marcacao set situacao = 'nao_listada' where conversa_id = op.conversa_id and situacao = 'ativa';
    insert into public.klingo_marcacao (conversa_id, voucher, procedimento, procedimento_id, unidade, profissional, data, hora, situacao, origem, consultado_em, operacao_id)
    select op.conversa_id, m.id, left(m.procedimento, 120), left(m."procedimentoId", 20), left(m.unidade, 120), left(m.profissional, 120),
           case when m.data ~ '^\d{4}-\d{2}-\d{2}' then substr(m.data, 1, 10)::date end, left(m.hora, 5), 'ativa',
           case when exists (select 1 from public.pre_agendamentos x where x.klingo_marcacoes @> array[m.id] and x.agendado_origem = 'chat_api') then 'chat_api' else 'klingo' end, now(), op.id
      from jsonb_to_recordset(p_r -> 'marcacoes') as m(id text, procedimento text, "procedimentoId" text, unidade text, profissional text, data text, hora text)
     where m.id ~ '^\d+$'
    on conflict (conversa_id, voucher) do update set procedimento = excluded.procedimento, procedimento_id = excluded.procedimento_id, unidade = excluded.unidade, profissional = excluded.profissional,
      data = excluded.data, hora = excluded.hora, situacao = 'ativa', origem = excluded.origem, consultado_em = now(), operacao_id = excluded.operacao_id;
    select count(*) into v_n from public.klingo_marcacao where conversa_id = op.conversa_id and situacao = 'ativa';
    select count(*) into v_fut from public.klingo_marcacao where conversa_id = op.conversa_id and situacao = 'ativa' and data >= v_hoje;
    if v_pos is distinct from 'marc_consultando' then return jsonb_build_object('ok', true, 'estado', 'sucesso', 'marcacoes', v_n); end if;
    if v_fut = 0 then
      perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'vazio'));
      perform public.fluxo_perguntar(op.conversa_id, 'marc_vazio', null);
    else
      perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'pronto', 'marc_voucher', null, 'marc_acao', null));
      perform public.fluxo_perguntar(op.conversa_id, 'marc_lista', null);
    end if;
    return jsonb_build_object('ok', true, 'estado', 'sucesso', 'marcacoes', v_n);
  end if;
  if v_pos is distinct from 'marc_consultando' then return jsonb_build_object('ok', true, 'estado', p_estado); end if;
  if v_cod = 'cadastro_nao_encontrado' then
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'vazio'));
    perform public.fluxo_perguntar(op.conversa_id, 'marc_vazio', null);
  elsif v_cod in ('nascimento_divergente', 'sessao_nao_confere', 'dados_incompletos', 'sem_id_definitivo') or v_cod like 'divergencia_%' then
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'local'));
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('marc_identidade', ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Paciente quis ver as marcações e a identidade não foi confirmada no Klingo (' || coalesce(v_cod, 'falha') || '). Conferir com o paciente antes de mostrar qualquer dado.', 'baixa', true);
  else
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'local'));
    v_txt := public.fluxo_t('marc_falha', ctx);
    select string_agg('• ' || (e ->> 'rotulo'), E'\n') into v_pos from jsonb_array_elements(public.fluxo_assunto_futuros(op.conversa_id)) e;
    if v_pos is not null then v_txt := v_txt || E'\n\nPelo histórico deste chat constam (pode estar desatualizado):' || E'\n' || v_pos; end if;
    perform public.fluxo_nota(op.conversa_id, 'Consulta de marcações ao Klingo não concluída (' || coalesce(v_cod, 'falha') || '). O paciente foi informado da limitação.');
    perform public.fluxo_dizer(op.conversa_id, v_txt);
    perform public.fluxo_transferir(op.conversa_id, 'Paciente quis ver, cancelar ou remarcar marcação e a consulta ao Klingo não concluiu (' || coalesce(v_cod, 'falha') || ').', 'baixa', true);
  end if;
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $function$;

