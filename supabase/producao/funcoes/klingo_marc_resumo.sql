-- public.klingo_marc_resumo(p_conversa uuid, p_voucher text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_marc_resumo(p_conversa uuid, p_voucher text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(nullif(m.procedimento, ''), 'Atendimento') || E'\n' || public.klingo_marc_quando(m.data, m.hora)
         || coalesce(E'\n' || nullif(m.unidade, ''), '') || coalesce(E'\nCom ' || nullif(m.profissional, ''), '') || E'\nProtocolo: ' || m.voucher
    from public.klingo_marcacao m where m.conversa_id = p_conversa and m.voucher = p_voucher
$function$;

