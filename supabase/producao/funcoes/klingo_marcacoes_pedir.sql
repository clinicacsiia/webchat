-- public.klingo_marcacoes_pedir(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_marcacoes_pedir(p_conversa uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; v_pa uuid; v_op uuid;
begin
  if not public.klingo_ativo(p_conversa, 'klingo_api_consultar') then return null; end if;
  d := public.klingo_dados_conversa(p_conversa);
  if d ->> 'cpf' is null or d ->> 'nascimento' is null then return null; end if;
  v_pa := (d ->> 'pre_agendamento_id')::uuid;
  select id into v_op from public.klingo_operacao where conversa_id = p_conversa and tipo = 'ler_vouchers' and estado in ('pendente', 'executando') and criado_em > now() - interval '3 minutes' order by criado_em desc limit 1;
  if v_op is null then
    insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, detalhe)
    values (p_conversa, v_pa, 'ler_vouchers', 'ler:' || p_conversa::text || ':' || gen_random_uuid()::text, '{}'::jsonb) returning id into v_op;
    perform public.klingo_operacao_disparar(v_op);
    perform public.klingo_medir('op_criada');
  end if;
  perform public.fluxo_set(p_conversa, jsonb_build_object('marc_estado', 'consultando', 'marc_op', v_op, 'marc_voucher', null, 'marc_acao', null));
  return v_op;
end $function$;

