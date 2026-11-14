-- public.klingo_catalogo_cru_disparar(p_acao text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_catalogo_cru_disparar(p_acao text DEFAULT 'catalogo'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if v_base = '' or v_seg is null then return; end if;
  perform net.http_post(url := v_base || 'klingo-catalogo-api', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', p_acao), timeout_milliseconds := 120000);
exception when others then null;
end $function$;

