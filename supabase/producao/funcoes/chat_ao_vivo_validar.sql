-- public.chat_ao_vivo_validar(p_conversa uuid, p_token text, p_de date, p_ate date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.chat_ao_vivo_validar(p_conversa uuid, p_token text, p_de date, p_ate date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_hoje date := (now() at time zone 'America/Bahia')::date; v_n integer;
begin
  perform public.chat_valida(p_conversa, p_token);
  if coalesce((select valor from public.config where chave = 'agenda_ao_vivo'), 'sim') <> 'sim' then
    return jsonb_build_object('ok', false, 'motivo', 'desligado');
  end if;
  if p_de is null or p_ate is null or p_ate < p_de or p_ate - p_de > 14 or p_de < v_hoje - 1 or p_ate > v_hoje + 62 then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  select count(*) into v_n from public.agenda_ao_vivo_pedido where conversa_id = p_conversa and em > now() - interval '10 minutes';
  if v_n >= 40 then return jsonb_build_object('ok', false, 'motivo', 'limite'); end if;
  insert into public.agenda_ao_vivo_pedido (conversa_id) values (p_conversa);
  if random() < 0.05 then delete from public.agenda_ao_vivo_pedido where em < now() - interval '1 day'; end if;
  return jsonb_build_object('ok', true);
end $function$;

