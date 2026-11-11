-- public.agendamento_fechar(p_conversa uuid, p_desfecho text, p_nota text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.agendamento_fechar(p_conversa uuid, p_desfecho text, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id bigint;
begin
  perform public.pessoa_equipe();
  v_id := public.agendamento_fechar_interno(p_conversa, p_desfecho, 'equipe', (select auth.uid()), p_nota);
  if v_id is null then raise exception 'Não há exame em aberto nesta conversa.' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true, 'fechamento_id', v_id);
end $function$;

