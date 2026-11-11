-- public.fluxo_avancar(p_conversa uuid, p_entrada jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_avancar(p_conversa uuid, p_entrada jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.conversas; f public.conversa_fluxo; v_t0 timestamptz := clock_timestamp();
  v_passo text; v_valor jsonb := p_entrada -> 'valor'; v_texto text := btrim(coalesce(p_entrada ->> 'texto', ''));
  v_norm text; v_res jsonb; v_prox text; v_prefixo text; v_tipo text := 'texto'; v_entendeu boolean := true; ctx jsonb;
begin
  select * into c from public.conversas where id = p_conversa for update;
  if not found or c.motor <> 'fluxo' or not (c.ia_ativa and c.status = 'aguardando') then return; end if;
  insert into public.conversa_fluxo (conversa_id) values (p_conversa) on conflict (conversa_id) do nothing;
  select * into f from public.conversa_fluxo where conversa_id = p_conversa for update;
  v_passo := f.passo;
  ctx := public.fluxo_ctx(p_conversa);

  if v_passo is null then
    v_prefixo := public.fluxo_t(case when (ctx ->> 'filho')::boolean then 'ola_filho' else 'ola_proprio' end, ctx);
    v_tipo := 'inicio';
  elsif v_passo in ('pronto', 'humano', 'assunto_fim') then
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('reaberta', ctx), jsonb_build_object('tipo', 'nova'));
    perform public.fluxo_transferir(p_conversa, 'Paciente voltou a escrever depois do atendimento.', 'baixa', false);
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'reaberta', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
    return;
  elsif p_entrada ->> 'acao' = 'atendente' then
    perform public.fluxo_transferir(p_conversa, 'Paciente pediu para falar com um atendente.', 'media', true);
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'atendente', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
    return;
  elsif p_entrada ->> 'evento' = 'anexo' then
    return;
  elsif v_valor is not null then
    v_tipo := 'botao';
    if p_entrada ->> 'passo' is distinct from v_passo then return; end if;
  elsif v_texto ~ '^(Pedido de exames:|Pedido de consulta:)' then
    v_tipo := 'componente';
    perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', case when v_texto like 'Pedido de consulta:%' then 'consulta' else 'exame' end,
                                                            'confirmado', false, 'refazer', null, 'medico_feito', false));
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null
     where conversa_id = p_conversa and escolha_horario is not null and status = 'rascunho';   -- convenio-quem-volta: exame ou consulta
  elsif v_texto ~ '^(Horário \d+ de \d+: )?Escolhi ' then
    v_tipo := 'componente';
    perform public.fluxo_set(p_conversa, '{"confirmado": false}');
  elsif v_texto like 'Agora vamos agendar para %' then
    v_tipo := 'componente';
  else
    v_norm := public.fluxo_norm(v_texto);
    if v_norm ~ '(dor (muito )?(forte |intensa )?no peito|aperto no peito|falta de ar|nao consigo respirar|dificuldade (para|pra) respirar|desmai|sangramento (intenso|forte|muito)|sangrando muito|\mavc\M|derrame|boca torta|convuls|reacao alergica|anafila|garganta fechando|quero morrer|me matar|suicid|me machucar|tirar (a )?minha vida|febre (alta|muito alta)|desidrat|sangue nas fezes|sangue no vomito|vomitando sangue|inconsciente|nao acorda|engasgad|nao (esta|ta) respirando)' then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('emergencia', ctx));
      perform public.fluxo_transferir(p_conversa, 'URGENTE: possível emergência descrita pelo paciente: "' || left(v_texto, 200) || '"', 'alta', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'emergencia', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    if v_norm ~ '(\matendente\M|\mhumano\M|recepcionista|secretaria|falar com (alguem|uma pessoa|pessoa|a clinica|voces)|pessoa de verdade|\mpessoa real\M)' then
      perform public.fluxo_transferir(p_conversa, 'Paciente pediu para falar com um atendente.', 'media', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'atendente', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    if v_passo is distinct from 'assunto_texto' then
      if v_norm ~ '(quanto custa|quanto (e|fica|sai)|qual (o )?valor|\mvalor\M|\mpreco|\mcusta\M|orcamento)' then
        v_prefixo := coalesce(public.preco_previsao_chat(p_conversa), public.fluxo_t('preco', ctx)); v_prox := v_passo;
      elsif v_norm ~ '(diagnostic|remedio|medicament|posso tomar|o que (pode ser|eu tenho|ele tem|ela tem)|e grave|tratamento|dosagem|\mdose\M)' then
        v_prefixo := public.fluxo_t('clinico', ctx); v_prox := v_passo;
      end if;
    end if;
    if v_prox is null then
      v_valor := public.fluxo_ler_texto(p_conversa, v_passo, v_texto);
      if v_valor is null and v_passo = 'exame' then
        perform public.fluxo_set(p_conversa, jsonb_build_object('termo', left(v_texto, 80)));
        v_prefixo := 'Veja se o seu exame está nesta lista:'; v_prox := v_passo;
      elsif v_valor is null then
        v_entendeu := false;
        perform public.fluxo_nota(p_conversa, 'Paciente escreveu (não entendido no passo ' || coalesce(v_passo, '-') || '): ' || left(v_texto, 200));
        update public.conversa_fluxo set tentativas = tentativas + 1 where conversa_id = p_conversa;
        v_prefixo := public.fluxo_t('nao_entendi', ctx); v_prox := v_passo;
      end if;
    end if;
  end if;

  if v_valor is not null and v_prox is null then
    v_res := public.fluxo_aplicar(p_conversa, v_passo, v_valor);
    if not coalesce((v_res ->> 'ok')::boolean, false) then
      v_entendeu := false;
      v_prefixo := coalesce(v_res ->> 'erro', public.fluxo_t('nao_entendi', ctx)); v_prox := v_passo;
    elsif coalesce((v_res ->> 'transferir')::boolean, false) then
      perform public.fluxo_transferir(p_conversa, 'Outro assunto: ' || coalesce((select dados ->> 'assunto' from public.conversa_fluxo where conversa_id = p_conversa), ''), 'baixa', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, v_tipo, true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    else
      v_prefixo := v_res ->> 'aviso';
    end if;
  end if;

  if v_prox is null then v_prox := public.fluxo_proximo(p_conversa); end if;
  if v_prox = 'pronto' then
    perform public.fluxo_finalizar(p_conversa);
  elsif v_prox = 'horario' and v_tipo = 'componente' and v_passo = 'horario' then
    perform public.fluxo_perguntar(p_conversa, v_prox, null);
  else
    perform public.fluxo_perguntar(p_conversa, v_prox, v_prefixo);
  end if;
  insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente)
  values (p_conversa, coalesce(v_passo, 'inicio'), v_tipo, v_entendeu, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
end $function$;

