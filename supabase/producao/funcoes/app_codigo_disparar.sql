-- public.app_codigo_disparar(p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_codigo_disparar(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if v_base = '' or v_seg is null then return; end if;
  perform net.http_post(url := v_base || 'app-codigo-enviar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('id', p_id), timeout_milliseconds := 20000);
exception when others then null;
end $function$;

