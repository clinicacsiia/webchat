-- public.agendamento_reconhecer_disparar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_reconhecer_disparar()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare e public.agendamento_reconhecer_estado%rowtype;
begin
  if coalesce((select valor from public.config where chave = 'agendamento_reconhecer'), 'nao') <> 'sim' then return; end if;
  perform pg_advisory_xact_lock(hashtext('agendamento_reconhecer_disparar'));
  select * into e from public.agendamento_reconhecer_estado where id;
  if e.proximo_em is not null and now() < e.proximo_em then return; end if;
  if e.iniciou_em is not null and (e.terminou_em is null or e.terminou_em < e.iniciou_em) and now() < e.iniciou_em + interval '150 seconds' then return; end if;
  if jsonb_array_length(public.agendamento_reconhecer_alvos(14)) = 0 then return; end if;
  update public.agendamento_reconhecer_estado set iniciou_em = now() where id;
  perform net.http_post(url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-reconhecer',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := '{"aplicar":true,"dias":14}'::jsonb, timeout_milliseconds := 100000);
end $function$;

