-- public.previsao_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.previsao_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_modo text := coalesce((select valor from public.config where chave = 'pedido_horario_modo'), 'desligado');
  r record; v_slots jsonb; v_s jsonb; v_msg text; v_novas integer := 0; v_perdidas integer := 0; v_fechadas integer := 0; v_vistos integer := 0;
begin
  if v_modo not in ('teste', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('previsao_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  -- pedido que virou agendado ou cancelado, ou conversa encerrada: sai da lista
  update public.pedido_previsao p set status = case when pa.status = 'agendado' then 'atendida' else 'cancelada' end, atualizada_em = now()
    from public.pre_agendamentos pa, public.conversas c
   where pa.conversa_id = p.conversa_id and c.id = p.conversa_id and p.status in ('aguardando', 'vaga_encontrada')
     and (pa.status in ('agendado', 'cancelado') or c.status = 'encerrada');
  get diagnostics v_fechadas = row_count;
  for r in
    select p.*, c.alerta_agenda, c.status as cstatus
      from public.pedido_previsao p join public.conversas c on c.id = p.conversa_id join public.pre_agendamentos pa on pa.conversa_id = p.conversa_id
     where p.status in ('aguardando', 'vaga_encontrada') and pa.status = 'pronto' and c.status in ('aguardando', 'em_atendimento')
       and (v_modo = 'ligado' or public.previsao_ativa(p.conversa_id))
  loop
    begin
      v_vistos := v_vistos + 1;
      v_slots := public.previsao_buscar(r.conversa_id, r.turno, greatest(r.de, (now() at time zone 'America/Bahia')::date), r.ate, public.previsao_antec_min(r.antecedencia));
      v_s := v_slots -> 0;
      if v_s is not null then
        v_msg := left('Vaga aberta dentro da previsão do paciente: ' || public.pedido_slot_texto(v_s) || '. Oferecer ao paciente (a previsão NÃO é agendamento).', 300);
        if r.status <> 'vaga_encontrada' or r.vaga is distinct from v_s then
          update public.pedido_previsao set status = 'vaga_encontrada', vaga = v_s, vaga_em = coalesce(vaga_em, now()), atualizada_em = now() where conversa_id = r.conversa_id;
          v_novas := v_novas + 1;
        end if;
        if r.alerta_agenda is null or r.alerta_agenda like 'Vaga aberta%' then
          update public.conversas set alerta_agenda = v_msg, atualizado_em = now() where id = r.conversa_id and alerta_agenda is distinct from v_msg;
        end if;
      elsif r.status = 'vaga_encontrada' then
        update public.pedido_previsao set status = 'aguardando', vaga = null, vaga_em = null, atualizada_em = now() where conversa_id = r.conversa_id;
        update public.conversas set alerta_agenda = null where id = r.conversa_id and alerta_agenda like 'Vaga aberta%';
        v_perdidas := v_perdidas + 1;
      end if;
    exception when others then
      raise warning 'previsao_vigiar: % (%)', sqlerrm, r.conversa_id;
    end;
  end loop;
  return jsonb_build_object('modo', v_modo, 'vistos', v_vistos, 'vagas_novas', v_novas, 'vagas_que_sumiram', v_perdidas, 'encerradas_da_lista', v_fechadas);
end $function$
;
