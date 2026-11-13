-- public.klingo_conferir_agendar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_conferir_agendar(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; v_cpf text; v_dt date; v_url text; v_seg text; v_chave text;
begin
  select valor into v_url from public.config where chave = 'klingo_paciente_url';
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if coalesce(v_url, '') = '' or coalesce(v_seg, '') = '' then return; end if;
  select dados -> 'digitado' into d from public.conversa_fluxo where conversa_id = p_conversa;
  v_cpf := regexp_replace(coalesce(d ->> 'cpf', ''), '\D', '', 'g');
  if not public.fluxo_cpf_ok(v_cpf) then return; end if;
  v_dt := public.fluxo_ler_data(d ->> 'dt_nasc');
  if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then return; end if;
  v_chave := encode(sha256(convert_to(v_cpf || v_dt::text || v_seg, 'UTF8')), 'hex');
  if exists (select 1 from public.paciente_klingo_vinculo where conversa_id = p_conversa and chave = v_chave) then return; end if;
  insert into public.paciente_klingo_vinculo (conversa_id, situacao, chave) values (p_conversa, 'pendente', v_chave)
    on conflict (conversa_id) do update set situacao = 'pendente', prontuario = null, cadastro_faltando = '{}', historico = null, chave = v_chave, verificado_em = now();
  begin
    perform net.http_post(url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', v_seg),
      body := jsonb_build_object('acao', 'conferir', 'cpf', v_cpf, 'nascimento', v_dt::text, 'conversa', p_conversa), timeout_milliseconds := 60000);
  exception when others then
    update public.paciente_klingo_vinculo set situacao = 'erro', verificado_em = now() where conversa_id = p_conversa;
  end;
end $function$;

-- public.klingo_conferir_agendar(p_dias integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_conferir_agendar(p_dias integer DEFAULT 4)
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

