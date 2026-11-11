-- public.agendamento_preparar_remarcacao(p_destino uuid, p_origem uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_preparar_remarcacao(p_destino uuid, p_origem uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare po public.pre_agendamentos; pd public.pre_agendamentos; v_n int;
begin
  select * into po from public.pre_agendamentos where conversa_id = p_origem;
  if not found or not exists (select 1 from public.pre_agendamento_itens where conversa_id = p_origem and ativo) then return false; end if;
  if p_destino = p_origem then
    update public.pre_agendamentos set status = 'rascunho', etapa = 'plano', escolha_horario = null, data_desejada = null, hora_desejada = null, atualizado_em = now()
     where conversa_id = p_origem;
    return true;
  end if;
  if exists (select 1 from public.pre_agendamento_itens where conversa_id = p_destino and ativo) then return false; end if;
  select * into pd from public.pre_agendamentos where conversa_id = p_destino;
  if found and pd.status in ('agendado', 'cancelado') then return false; end if;
  insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
  select p_destino, i.modalidade, i.regiao, i.regiao_nome, i.lado, i.procedimento_id, i.procedimento, i.quantidade
    from public.pre_agendamento_itens i where i.conversa_id = p_origem and i.ativo;
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;
  insert into public.pre_agendamentos (conversa_id, tipo, procedimento, plano, unidade, profissional, paciente, paciente_id, identidade, etapa, status)
  values (p_destino, po.tipo, po.procedimento, po.plano, po.unidade, po.profissional, po.paciente, po.paciente_id, po.identidade, 'plano', 'rascunho')
  on conflict (conversa_id) do update set tipo = excluded.tipo, procedimento = excluded.procedimento, plano = excluded.plano, unidade = excluded.unidade,
    profissional = excluded.profissional, paciente = excluded.paciente, paciente_id = excluded.paciente_id, identidade = excluded.identidade,
    etapa = 'plano', status = 'rascunho', escolha_horario = null, data_desejada = null, hora_desejada = null, atualizado_em = now();
  return true;
end $function$;

