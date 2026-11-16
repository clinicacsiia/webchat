-- public.painel_disponibilidade_registrar(p_conversa uuid, p_dados jsonb)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_disponibilidade_registrar(p_conversa uuid, p_dados jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_r jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  v_r := public.disponibilidade_gravar(p_conversa, jsonb_build_object('aceita_notificacao', true, 'canais', jsonb_build_array('chat', 'equipe_contato')) || coalesce(p_dados, '{}'::jsonb));
  perform public.disponibilidade_evento_gravar((v_r ->> 'id')::uuid, 'registrada_pela_equipe', 'equipe', jsonb_build_object('origem', 'painel', 'agente', auth.uid()));
  insert into public.painel_oferta (conversa_id, tipo, estado) values (p_conversa, 'disponibilidade', 'aceito');
  return jsonb_build_object('ok', true, 'id', v_r ->> 'id', 'data_ini', v_r ->> 'data_ini', 'data_fim', v_r ->> 'data_fim', 'procedimento', v_r ->> 'procedimento');
end $function$;

