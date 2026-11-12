-- public.klingo_revisao_disparar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_revisao_disparar()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if v_base = '' or v_seg is null or jsonb_array_length(public.klingo_revisao_pendentes(1)) = 0 then return; end if;
  perform net.http_post(url := v_base || 'klingo-identificar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', 'revisar', 'limite', 30), timeout_milliseconds := 120000);
exception when others then null;
end $function$;

