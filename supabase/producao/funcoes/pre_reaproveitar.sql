-- public.pre_reaproveitar(p_conversa uuid, p_origem text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pre_reaproveitar(p_conversa uuid, p_origem text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_conf jsonb; v_pid uuid; v_ex jsonb; v_orig uuid; v_n int; v_off int := 0;
begin
  v_conf := public.paciente_conferir(p_conversa);
  v_pid := nullif(v_conf ->> 'paciente_id', '')::uuid;
  if v_pid is null or (v_conf ->> 'dt_nasc_conferida') is distinct from 'true' then return false; end if;
  if exists (select 1 from public.pre_agendamento_itens where conversa_id = p_conversa and ativo) then return false; end if;
  if p_origem ~ '^ultimo(:[0-9])?$' then
    v_off := coalesce(nullif(substr(p_origem, 8), ''), '0')::int;
    select h.exames into v_ex from public.paciente_historico h
      where h.paciente_id = v_pid and not h.cancelado and (v_off > 0 or jsonb_array_length(h.exames) > 0) order by coalesce(h.ocorreu_em, h.criado_em at time zone 'America/Bahia') desc limit 1 offset v_off;
  elsif p_origem = 'pendente' then
    v_orig := public.pre_pendencia_anterior(p_conversa);
    if v_orig is null then return false; end if;
    select jsonb_agg(jsonb_build_object('modalidade', i.modalidade, 'regiao', i.regiao, 'parte_do_corpo', i.regiao_nome, 'lado', i.lado,
        'procedimento_id', i.procedimento_id, 'quantidade', i.quantidade) order by i.id) into v_ex
      from public.pre_agendamento_itens i where i.conversa_id = v_orig and i.ativo;
  else
    return false;
  end if;
  if v_ex is null then return false; end if;
  insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
  select p_conversa, x.modalidade, x.regiao, x.parte_do_corpo, coalesce(nullif(x.lado, ''), 'N'), p.id, p.nome, greatest(coalesce(x.quantidade, 1), 1)
  from jsonb_to_recordset(v_ex) as x(modalidade text, regiao text, parte_do_corpo text, lado text, procedimento_id int, quantidade int)
  left join public.catalogo_procedimento p on p.id = x.procedimento_id and p.ativo
  where x.modalidade in ('RM','TC','US','RX','MAMO','DENSITO') and coalesce(nullif(x.lado, ''), 'N') in ('D','E','A','N');
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;
  update public.pre_agendamentos pa set tipo = 'exame',
    procedimento = left((select string_agg(coalesce(i.procedimento, i.modalidade), ' + ' order by i.id) from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo), 160),
    etapa = case when pa.etapa is null or pa.etapa = 'pedido' then 'plano' else pa.etapa end,
    -- convenio-quem-volta: o plano da vez anterior NÃO é copiado; o motor pergunta se continua o mesmo.
    unidade = case when v_orig is not null then coalesce(pa.unidade, (select o.unidade from public.pre_agendamentos o where o.conversa_id = v_orig)) else pa.unidade end,
    atualizado_em = now()
  where pa.conversa_id = p_conversa and pa.status not in ('agendado','cancelado');
  return true;
end $function$;

