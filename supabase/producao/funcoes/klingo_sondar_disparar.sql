-- public.klingo_sondar_disparar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_sondar_disparar()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if v_base = '' or v_seg is null or public.klingo_mestre() = 'nao' then return; end if;   -- só gasta chamadas do Klingo com o autoatendimento ligado
  if not exists (select 1 from public.klingo_exames_sondar(1)) then return; end if;
  perform net.http_post(url := v_base || 'klingo-sincronizar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', 'exames'), timeout_milliseconds := 120000);
exception when others then null;
end $function$;

