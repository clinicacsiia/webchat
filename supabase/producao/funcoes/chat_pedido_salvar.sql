-- public.chat_pedido_salvar(p_conversa uuid, p_token text, p_itens jsonb)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_pedido_salvar(p_conversa uuid, p_token text, p_itens jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  it jsonb; v_pid int; v_pnome text; v_reg record; v_mod text; v_lado text; v_qtd int; v_reg_nome text; v_lado_txt text;
  v_linhas text[] := '{}'; v_nomes text[] := '{}'; v_n int := 0; v_msg bigint; v_txt text; v_modnome text;
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 or jsonb_array_length(p_itens) > 12 then
    raise exception 'Pedido inválido.' using errcode = '22023';
  end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;

  if exists (select 1 from public.pre_agendamentos where conversa_id = p_conversa and status in ('agendado','cancelado')) then
    raise exception 'Este pedido já foi concluído. Inicie um novo atendimento para outro exame.' using errcode = '22023';
  end if;
  update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null,
    etapa = case when etapa in ('dados','confirmacao') then 'data_hora' else etapa end
    where conversa_id = p_conversa and escolha_horario is not null;
  update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
  for it in select * from jsonb_array_elements(p_itens) loop
    v_mod := upper(coalesce(it ->> 'modalidade', ''));
    if v_mod not in ('RM','TC','US','RX','MAMO','DENSITO') then raise exception 'Modalidade inválida.' using errcode = '22023'; end if;
    v_modnome := case v_mod when 'RM' then 'Ressonância magnética' when 'TC' then 'Tomografia' when 'US' then 'Ultrassom' when 'RX' then 'Raio-X'
                            when 'MAMO' then 'Mamografia' else 'Densitometria óssea' end;
    select * into v_reg from public.catalogo_regiao where codigo = it ->> 'regiao';
    v_reg_nome := coalesce(v_reg.nome, case when it ->> 'regiao' = 'outros' then 'Outros exames' else null end);
    v_lado := upper(coalesce(nullif(it ->> 'lado', ''), 'N'));
    if found and v_reg.tem_lado then
      if v_lado not in ('D','E','A') then raise exception 'Informe o lado (direito, esquerdo ou ambos) de: %.', v_reg.nome using errcode = '22023'; end if;
    else
      v_lado := 'N';
    end if;
    v_pid := null; v_pnome := null;
    if nullif(it ->> 'procedimento_id', '') is not null then
      select p.id, p.nome into v_pid, v_pnome from public.catalogo_procedimento p
       where p.id = (it ->> 'procedimento_id')::int and p.ativo and p.modalidade = v_mod;
      if v_pid is null then raise exception 'Exame não encontrado no cadastro.' using errcode = '22023'; end if;
      if v_lado in ('D','E') and v_pnome ~* 'BILATERAL' then
        raise exception 'O exame "%" é feito nos dois lados. Escolha "ambos os lados".', v_pnome using errcode = '22023';
      end if;
    end if;
    v_qtd := case when v_lado = 'A' and (v_pnome is null or v_pnome !~* 'BILATERAL') then 2 else 1 end;
    insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
    values (p_conversa, v_mod, nullif(it ->> 'regiao', ''), v_reg_nome, v_lado, v_pid, v_pnome, v_qtd);
    v_n := v_n + 1;
    v_lado_txt := case v_lado when 'D' then ' (lado direito)' when 'E' then ' (lado esquerdo)' when 'A' then ' (os dois lados)' else '' end;
    v_linhas := v_linhas || ('• ' || v_modnome || case when v_reg_nome is not null then ' — ' || v_reg_nome else '' end || v_lado_txt || ': '
                             || coalesce(v_pnome, 'exame a definir com o atendente')
                             || case when v_qtd > 1 then ' (' || v_qtd || ' unidades, uma de cada lado)' else '' end);
    v_nomes := v_nomes || coalesce(v_pnome, v_modnome || ' ' || coalesce(v_reg_nome, ''));
  end loop;

  insert into public.pre_agendamentos as pa (conversa_id, tipo, procedimento, etapa, paciente, status)
  values (p_conversa, 'exame', left(array_to_string(v_nomes, ' + '), 160), 'plano', '{}'::jsonb, 'rascunho')
  on conflict (conversa_id) do update set tipo = 'exame', procedimento = excluded.procedimento,
    etapa = case when pa.etapa is null or pa.etapa = 'pedido' then 'plano' else pa.etapa end, atualizado_em = now()
  where pa.status not in ('agendado','cancelado');

  v_txt := left('Pedido de exames:' || E'\n' || array_to_string(v_linhas, E'\n'), 3900);
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end,
    agente_id = case when status = 'encerrada' then null else agente_id end where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'itens', v_n, 'mensagem_id', v_msg);
end $function$;

