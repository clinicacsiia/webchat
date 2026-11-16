-- public.painel_marcacao_cancelar(p_conversa uuid, p_voucher text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_marcacao_cancelar(p_conversa uuid, p_voucher text)
 RETURNS jsonb
 LANGUAGE plpgsql
SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

