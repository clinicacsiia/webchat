-- public.klingo_operacao_criar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_operacao_criar(p_conversa uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; e jsonb; o public.klingo_oferta; v_chave text; v_op uuid; v_rem jsonb; v_tipo text;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  e := pa.escolha_horario -> 0;
  select * into o from public.klingo_oferta where conversa_id = p_conversa and chave = e ->> 'klingo_chave';
  select f.dados -> 'remarcando' into v_rem from public.conversa_fluxo f where f.conversa_id = p_conversa;
  v_tipo := case when jsonb_typeof(v_rem) = 'object' then 'remarcar' else 'marcar' end;
  v_chave := v_tipo || ':' || pa.id::text || ':' || coalesce(v_rem ->> 'voucher', '') || ':' || (e ->> 'klingo_chave');
  insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, detalhe)
  values (p_conversa, pa.id, v_tipo, v_chave, jsonb_build_object('chave', e ->> 'klingo_chave', 'data', e ->> 'data', 'hora', e ->> 'hora', 'procedimento', o.procedimento, 'plano', o.plano)
          || case when v_tipo = 'remarcar' then jsonb_build_object('remarcacao', v_rem ->> 'voucher') else '{}'::jsonb end)
  on conflict (chave_idem) do nothing returning id into v_op;
  if v_op is null then select id into v_op from public.klingo_operacao where chave_idem = v_chave; return v_op; end if;
  perform public.klingo_operacao_disparar(v_op);
  perform public.klingo_medir('op_criada');
  return v_op;
end $function$;

