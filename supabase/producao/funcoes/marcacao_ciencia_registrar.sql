-- public.marcacao_ciencia_registrar(p_conversa uuid, p_token text, p_aparelho jsonb DEFAULT '{}'::jsonb, p_motivo text DEFAULT NULL::text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.marcacao_ciencia_registrar(p_conversa uuid, p_token text, p_aparelho jsonb DEFAULT '{}'::jsonb, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_h jsonb; v_ip text; v_ap jsonb := '{}'::jsonb; k text; v_id bigint; v_em timestamptz;
begin
  perform public.app_pin_exigir();
  perform public.chat_valida(p_conversa, p_token);
  if (select count(*) from public.marcacao_ciencia where conversa_id = p_conversa and em > now() - interval '1 hour') >= 5 then
    raise exception 'Muitas confirmações em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  begin v_h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then v_h := null; end;
  v_ip := nullif(btrim(coalesce(v_h ->> 'cf-connecting-ip', v_h ->> 'x-real-ip',
                                (string_to_array(coalesce(v_h ->> 'x-forwarded-for', ''), ','))[cardinality(string_to_array(coalesce(v_h ->> 'x-forwarded-for', ''), ','))], '')), '');
  if jsonb_typeof(p_aparelho) = 'object' then
    foreach k in array array['aparelho', 'idioma', 'tela', 'fuso', 'navegador'] loop
      if p_aparelho ->> k is not null then v_ap := v_ap || jsonb_build_object(k, left(btrim(p_aparelho ->> k), 160)); end if;
    end loop;
  end if;
  insert into public.marcacao_ciencia (conversa_id, ip, aparelho, motivo, versao_texto)
  values (p_conversa, left(v_ip, 64), v_ap, left(nullif(btrim(coalesce(p_motivo, '')), ''), 120), 'pre-marcacao-v1')
  returning id, em into v_id, v_em;
  perform public.fluxo_nota(p_conversa, 'CIÊNCIA DA PRÉ-MARCAÇÃO registrada em ' || to_char(v_em at time zone 'America/Bahia', 'DD/MM/YYYY HH24:MI:SS') || ' (Bahia): o paciente confirmou que a pré-marcação NÃO garante o horário.');
  return jsonb_build_object('ok', true, 'id', v_id, 'em', v_em);
end $function$;

