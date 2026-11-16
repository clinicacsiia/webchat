-- public.consulta_atendida_disparar(p_de date, p_ate date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.consulta_atendida_disparar(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id bigint;
begin
  if p_de is null and not public.jornada_klingo_expediente(now()) then return null; end if;
  select net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-atendimentos-klingo',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := case when p_de is null then '{}'::jsonb else jsonb_build_object('de', p_de, 'ate', p_ate) end,
    timeout_milliseconds := 120000) into v_id;
  return v_id;
exception when others then return null;
end $function$;

