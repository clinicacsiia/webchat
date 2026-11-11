-- public.fila_avisar_n8n(p_atendimento uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_avisar_n8n(p_atendimento uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_url text;
  a public.atendimentos%rowtype;
  v_nome text;
begin
  select valor into v_url from public.config where chave = 'fila_webhook_url';
  if coalesce(v_url, '') = '' then return; end if;
  select * into a from public.atendimentos where id = p_atendimento;
  if not found then return; end if;
  select nome into v_nome from public.pacientes where id = a.paciente_id;
  begin
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('nome', v_nome, 'email_informado', a.email_informado,
                                 'paciente_id', a.paciente_id, 'atendimento_uuid', a.id),
      headers := '{"Content-Type":"application/json"}'::jsonb);
  exception when others then
    raise warning 'fila_avisar_n8n: %', sqlerrm;
  end;
end $function$;

