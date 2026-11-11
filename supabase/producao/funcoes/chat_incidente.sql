-- public.chat_incidente(p_conversa uuid, p_token text, p_codigo text, p_tipo text, p_detalhe jsonb)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_incidente(p_conversa uuid, p_token text, p_codigo text, p_tipo text, p_detalhe jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cod text := upper(btrim(coalesce(p_codigo, '')));
  v_tipo text := upper(btrim(coalesce(p_tipo, '')));
  v_det jsonb := coalesce(p_detalhe, '{}'::jsonb);
  v_conv uuid; v_id bigint;
begin
  if v_cod !~ '^CSI-[0-9]{6}-[0-9]{4}-[A-Z]{3}-[A-Z0-9]{4}$' or v_tipo !~ '^[A-Z]{3}$' then
    return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido');
  end if;
  if (select count(*) from public.incidente_chat where criado_em > now() - interval '1 minute') >= 60 then
    return jsonb_build_object('ok', false, 'motivo', 'limite');
  end if;
  if p_conversa is not null then
    select conversa_id into v_conv from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  end if;
  if jsonb_typeof(v_det) <> 'object' then v_det := '{}'::jsonb; end if;
  if pg_column_size(v_det) > 20000 then v_det := jsonb_build_object('truncado', true, 'rotulo', left(coalesce(v_det ->> 'rotulo', ''), 80)); end if;
  insert into public.incidente_chat (codigo, tipo, conversa_id, passo, versao, detalhe)
  values (v_cod, v_tipo, v_conv, left(v_det ->> 'passo', 40), left(v_det ->> 'app', 40), v_det)
  on conflict (codigo) do nothing returning id into v_id;
  if v_id is not null and v_conv is not null and v_tipo <> 'DIA' then
    begin
      perform public.fluxo_nota(v_conv, 'Problema técnico no chat do paciente, código ' || v_cod || ' (' || left(coalesce(v_det ->> 'rotulo', v_tipo), 60) || ')');
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('ok', true, 'codigo', v_cod, 'novo', v_id is not null);
end $function$;

