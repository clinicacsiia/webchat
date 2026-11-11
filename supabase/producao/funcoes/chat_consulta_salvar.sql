-- public.chat_consulta_salvar(p_conversa uuid, p_token text, p_procedimento_id integer)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_consulta_salvar(p_conversa uuid, p_token text, p_procedimento_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cat text; v_med text; v_c record; v_proc text; v_msg bigint; v_txt text;
begin
  perform public.chat_valida(p_conversa, p_token);
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  if exists (select 1 from public.pre_agendamentos where conversa_id = p_conversa and status in ('agendado','cancelado')) then
    raise exception 'Este pedido já foi concluído. Inicie um novo atendimento.' using errcode = '22023';
  end if;
  select u.catalogo, c.medico_preferido into v_cat, v_med
  from public.conversas c left join public.unidade_config u on u.chave = c.unidade_inicial where c.id = p_conversa;
  select x.id, x.rotulo into v_c from public.consultas_da_unidade(v_cat) x where x.id = p_procedimento_id;
  if v_c.id is null then raise exception 'Consulta não encontrada para esta unidade.' using errcode = '22023'; end if;
  select p.nome into v_proc from public.catalogo_procedimento p where p.id = v_c.id;
  update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null,
    etapa = case when etapa in ('dados','confirmacao') then 'data_hora' else etapa end
    where conversa_id = p_conversa and escolha_horario is not null;
  update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
  insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
  values (p_conversa, 'CONSULTA', null, null, 'N', v_c.id, v_proc, 1);
  insert into public.pre_agendamentos as pa (conversa_id, tipo, procedimento, etapa, paciente, status)
  values (p_conversa, 'consulta', left(v_proc, 160), 'plano', '{}'::jsonb, 'rascunho')
  on conflict (conversa_id) do update set tipo = 'consulta', procedimento = excluded.procedimento,
    etapa = case when pa.etapa is null or pa.etapa = 'pedido' then 'plano' else pa.etapa end, atualizado_em = now()
  where pa.status not in ('agendado','cancelado');
  v_txt := 'Pedido de consulta:' || E'\n' || '• ' || v_c.rotulo || case when v_med is not null then E'\nMédico de preferência: ' || initcap(lower(v_med)) else '' end;
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end,
    agente_id = case when status = 'encerrada' then null else agente_id end where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'mensagem_id', v_msg);
end $function$;

