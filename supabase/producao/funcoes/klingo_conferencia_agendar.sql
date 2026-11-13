-- public.klingo_conferencia_agendar(p_dias integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_conferencia_agendar(p_dias integer DEFAULT 4)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select valor from public.config where chave = 'klingo_conferir_ativo'), 'nao') <> 'sim' then return 'desligado'; end if;
  perform net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-conferir',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := jsonb_build_object('dias', least(greatest(coalesce(p_dias, 4), 1), 31)),
    timeout_milliseconds := 120000);
  return 'chamado';
end $function$;

