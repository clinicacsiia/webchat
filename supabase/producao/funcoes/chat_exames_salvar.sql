-- public.chat_exames_salvar(p_conversa uuid, p_token text, p_itens jsonb)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_exames_salvar(p_conversa uuid, p_token text, p_itens jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare it jsonb; p record; reg record; v_lado text; v_qtd int; v_linhas text[] := '{}'; v_nomes text[] := '{}'; v_n int := 0; v_msg bigint; v_txt text; v_livre text;
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 or jsonb_array_length(p_itens) > 12 then
    raise exception 'Pedido inválido.' using errcode = '22023';
  end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  if exists (select 1 from public.pre_agendamentos where conversa_id = p_conversa and status in ('agendado','cancelado','pronto')) then
    raise exception 'Este pedido já foi enviado. Inicie um novo atendimento.' using errcode = '22023';
  end if;
  update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
  for it in select * from jsonb_array_elements(p_itens) loop
    v_livre := nullif(left(btrim(coalesce(it ->> 'texto', '')), 160), '');
    if nullif(it ->> 'procedimento_id', '') is null then
      if v_livre is null then raise exception 'Escolha o exame.' using errcode = '22023'; end if;
      insert into public.pre_agendamento_itens (conversa_id, modalidade, lado, procedimento_id, procedimento, quantidade)
      values (p_conversa, 'OUTRO', 'N', null, v_livre, 1);
      v_linhas := v_linhas || ('• ' || v_livre || ' (o atendente confere o exame)'); v_nomes := v_nomes || v_livre; v_n := v_n + 1;
      continue;
    end if;
    select pr.id, pr.nome, pr.modalidade into p from public.catalogo_procedimento pr
     where pr.id = (it ->> 'procedimento_id')::int and pr.ativo and pr.modalidade <> 'CONSULTA'
       and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = pr.id and a.vig_fim >= current_date and a.profissional !~* 'teste');
    if p.id is null then raise exception 'Exame não encontrado no cadastro.' using errcode = '22023'; end if;
    select g.codigo, g.nome, g.tem_lado into reg from public.catalogo_regiao g
     where g.codigo = it ->> 'regiao' or regexp_replace(public.norm_nome(p.nome), 'NAO INCLUI.*$', '') ~ g.padrao
     order by (g.codigo = coalesce(it ->> 'regiao', '')) desc, g.ordem limit 1;
    v_lado := upper(coalesce(nullif(it ->> 'lado', ''), 'N'));
    if p.nome ~* 'BILATERAL' then v_lado := case when coalesce(reg.tem_lado, false) then 'A' else 'N' end;
    elsif coalesce(reg.tem_lado, false) then
      if v_lado not in ('D','E','A') then raise exception 'Informe o lado (direito, esquerdo ou os dois) de: %.', initcap(lower(p.nome)) using errcode = '22023'; end if;
    else v_lado := 'N';
    end if;
    v_qtd := case when v_lado = 'A' and p.nome !~* 'BILATERAL' then 2 else 1 end;
    insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
    values (p_conversa, p.modalidade, reg.codigo, reg.nome, v_lado, p.id, p.nome, v_qtd);
    v_n := v_n + 1;
    v_linhas := v_linhas || ('• ' || initcap(lower(p.nome)) || case v_lado when 'D' then ' — lado direito' when 'E' then ' — lado esquerdo' when 'A' then ' — os dois lados' else '' end
                             || case when v_qtd > 1 then ' (2 unidades)' else '' end);
    v_nomes := v_nomes || p.nome;
  end loop;
  insert into public.pre_agendamentos as pa (conversa_id, tipo, procedimento, etapa, paciente, status)
  values (p_conversa, 'exame', left(array_to_string(v_nomes, ' + '), 160), 'plano', '{}'::jsonb, 'rascunho')
  on conflict (conversa_id) do update set tipo = 'exame', procedimento = excluded.procedimento, escolha_horario = null, data_desejada = null, hora_desejada = null,
    etapa = case when pa.etapa is null or pa.etapa = 'pedido' then 'plano' else pa.etapa end, atualizado_em = now()
  where pa.status = 'rascunho';
  v_txt := left('Pedido de exames:' || E'\n' || array_to_string(v_linhas, E'\n'), 3900);
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'itens', v_n, 'mensagem_id', v_msg, 'respostas', public.chat_respostas(p_conversa, v_msg - 1));
end $function$;

