-- public.pmarc_disparar(p_modo text, p_extra jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_disparar(p_modo text DEFAULT 'rapido'::text, p_extra jsonb DEFAULT '{}'::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id bigint;
begin
  if p_modo not in ('rapido', 'completo', 'enriquecer') then raise exception 'Modo inválido.' using errcode = '22023'; end if;
  update public.pmarc_estado set tentativa_em = now() where id;
  select net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/pmarc-cadastrar',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := jsonb_build_object('modo', p_modo) || coalesce(p_extra, '{}'::jsonb),
    timeout_milliseconds := 120000) into v_id;
  return v_id;
end $function$;

