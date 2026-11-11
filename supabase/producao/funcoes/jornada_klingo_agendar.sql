-- public.jornada_klingo_agendar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_klingo_agendar()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  e       public.jornada_sync_estado%rowtype;
  v_agora timestamptz := now();
  v_modo  text;
begin
  perform pg_advisory_xact_lock(hashtext('jornada_klingo_agendar'));
  select * into e from public.jornada_sync_estado where id;
  if e.klingo_proximo_em is not null and v_agora < e.klingo_proximo_em then
    return 'aguardando';
  end if;
  if e.klingo_tentativa_em is not null and (e.klingo_fim_em is null or e.klingo_fim_em < e.klingo_tentativa_em) and v_agora < e.klingo_tentativa_em + interval '150 seconds' then
    return 'em andamento';
  end if;
  v_modo := case
    when e.klingo_completo_em is null
      or v_agora - e.klingo_completo_em > case when public.jornada_klingo_expediente(v_agora) then interval '10 minutes' else interval '60 minutes' end then 'completo'
    else 'rapido'
  end;
  update public.jornada_sync_estado set klingo_tentativa_em = v_agora, klingo_modo = v_modo where id;
  perform net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-jornada-klingo',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := jsonb_build_object('modo', v_modo),
    timeout_milliseconds := 120000);
  return v_modo;
end $function$;

