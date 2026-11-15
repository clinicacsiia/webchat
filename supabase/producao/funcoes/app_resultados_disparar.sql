-- public.app_resultados_disparar()
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.app_resultados_disparar()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if coalesce((select valor from public.config where chave = 'app_resultado_vigia'), 'nao') <> 'sim' or not public.app_modo() then return; end if;
  if v_base = '' or v_seg is null then return; end if;
  if not exists (select 1 from public.app_conversa ac join public.jornada_card jc on jc.conversa_id = ac.conversa_id join public.jornada_exame e on e.card_id = jc.id
                  where e.status = 'atendido' and e.agendado_para > now() - interval '90 days' limit 1) then return; end if;
  perform net.http_post(url := v_base || 'app-resultados-vigiar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('limite', 30), timeout_milliseconds := 120000);
exception when others then null;
end $function$;

