-- FLUXOGRAMA: entrada (paciente adulto pede CONSULTA e a conversa fica sem unidade autorizada: a CSI está desligada em Configurações > Marcação automática por unidade)
--   -> validação (chat_consultas e chat_consulta_salvar conferem a unidade da conversa: sem unidade, ou unidade com marcacao_auto_<unidade> = nao, não segue)
--   -> lógica (antes, unidade vazia listava as consultas de TODAS as unidades e o paciente escolhia um médico da CSI sem poder marcar; agora a lista vem vazia com sem_unidade_autorizada = true)
--   -> saída (a tela mostra o aviso e o botão "Continuar pelo WhatsApp"; o toque também avisa a equipe pela conversa; o servidor recusa salvar a consulta mesmo com tela desatualizada)
-- Versão 1.0 — 19/11/2026 / Mudança: pedido do dono (pacientes caindo na unidade errada; só a Desenvoar está autorizada a marcar pelo chat e o resto deve voltar para o WhatsApp). Exame sem horário em unidade desligada já tinha o aviso (chat_horarios); a mudança dele é só de tela (index.html).
-- Sem "drop": a ferramenta de migração pede confirmação para comandos que parecem destrutivos e expira em 60 s.
-- ROLLBACK: recriar chat_consultas e chat_consulta_salvar a partir de supabase/producao/funcoes/ (versão anterior ao retrato de 19/11/2026, no histórico do git).

-- Parte 1: a lista de consultas só existe para unidade autorizada
create or replace function public.chat_consultas(p_conversa uuid, p_token text) returns jsonb
 language plpgsql stable security definer set search_path to ''
as $function$
declare v_cat text; v_med text;
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  perform public.chat_valida(p_conversa, p_token);
  select u.catalogo, c.medico_preferido into v_cat, v_med
  from public.conversas c left join public.unidade_config u on u.chave = c.unidade_inicial where c.id = p_conversa;
  if v_cat is null or not public.unidade_marca_auto(v_cat) then
    return jsonb_build_object('medico_preferido', v_med, 'consultas', '[]'::jsonb, 'sem_unidade_autorizada', true, 'aviso', public.unidade_aviso_bloqueio());
  end if;
  return jsonb_build_object('medico_preferido', v_med, 'consultas', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'rotulo', x.rotulo, 'do_medico', coalesce(v_med = any(x.medicos), false))
                     order by coalesce(v_med = any(x.medicos), false) desc, x.profissionais desc, x.rotulo)
    from (select * from public.consultas_da_unidade(v_cat) cu where public.klingo_liberado(p_conversa, cu.id, 'consulta') limit 24) x), '[]'::jsonb));
end $function$;

-- Parte 2: a trava no servidor (tela antiga não consegue salvar consulta de unidade não autorizada)
create or replace function public.chat_consulta_salvar(p_conversa uuid, p_token text, p_procedimento_id integer) returns jsonb
 language plpgsql security definer set search_path to ''
as $function$
declare v_cat text; v_med text; v_c record; v_proc text; v_msg bigint; v_txt text;
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  perform public.chat_valida(p_conversa, p_token);
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  if exists (select 1 from public.pre_agendamentos where conversa_id = p_conversa and status in ('agendado','cancelado')) then
    raise exception 'Este pedido já foi concluído. Inicie um novo atendimento.' using errcode = '22023';
  end if;
  select u.catalogo, c.medico_preferido into v_cat, v_med
  from public.conversas c left join public.unidade_config u on u.chave = c.unidade_inicial where c.id = p_conversa;
  if v_cat is null or not public.unidade_marca_auto(v_cat) then raise exception '%', public.unidade_aviso_bloqueio() using errcode = 'P0001'; end if;
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
