-- public.painel_marcacoes_pedir(p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_marcacoes_pedir(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; v_op uuid; v_falta text[];
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  if not public.klingo_ativo(p_conversa, 'klingo_api_consultar') then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  d := public.klingo_dados_conversa(p_conversa);
  v_falta := array_remove(array[case when d ->> 'cpf' is null then 'CPF' end, case when d ->> 'nascimento' is null then 'data de nascimento' end], null);
  if cardinality(v_falta) > 0 then return jsonb_build_object('ok', false, 'motivo', 'dados_incompletos', 'faltando', to_jsonb(v_falta)); end if;
  -- se o paciente está no passo de ver marcações do chat, não mexe: o fluxo dele reagiria ao resultado
  if exists (select 1 from public.conversa_fluxo where conversa_id = p_conversa and passo like 'marc\_%') then return jsonb_build_object('ok', false, 'motivo', 'paciente_vendo'); end if;
  select id into v_op from public.klingo_operacao where conversa_id = p_conversa and tipo = 'ler_vouchers' and detalhe ->> 'por' = 'painel' and estado in ('pendente', 'executando') and criado_em > now() - interval '3 minutes' order by criado_em desc limit 1;
  if v_op is null then
    insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, origem, detalhe)
    values (p_conversa, nullif(d ->> 'pre_agendamento_id', '')::uuid, 'ler_vouchers', 'ler:' || p_conversa::text || ':' || gen_random_uuid()::text, 'equipe', jsonb_build_object('por', 'painel', 'agente', auth.uid())) returning id into v_op;
    perform public.klingo_operacao_disparar(v_op);
    perform public.klingo_medir('op_criada');
  end if;
  return jsonb_build_object('ok', true, 'op', v_op);
end $function$;

