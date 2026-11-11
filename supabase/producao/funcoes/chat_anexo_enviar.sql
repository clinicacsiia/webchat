-- public.chat_anexo_enviar(p_conversa uuid, p_token text, p_mime text, p_base64 text, p_ocr text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_anexo_enviar(p_conversa uuid, p_token text, p_mime text, p_base64 text, p_ocr text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_bin bytea; v_id bigint; v_msg bigint;
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'Envie uma foto (JPG ou PNG).' using errcode = '22023'; end if;
  if length(coalesce(p_base64, '')) > 2000000 then raise exception 'A foto é grande demais. Tente de novo.' using errcode = '22023'; end if;
  if (select count(*) from public.conversa_anexo where conversa_id = p_conversa) >= 6 then raise exception 'Limite de fotos desta conversa atingido.' using errcode = '54000'; end if;
  begin v_bin := decode(regexp_replace(p_base64, '^data:[^,]*,', ''), 'base64'); exception when others then raise exception 'Foto inválida.' using errcode = '22023'; end;
  insert into public.conversa_anexo (conversa_id, mime, dados, ocr_texto) values (p_conversa, p_mime, v_bin, left(p_ocr, 4000)) returning id into v_id;
  perform set_config('fluxo.entrada', '{"evento":"anexo"}', true);
  insert into public.mensagens (conversa_id, autor, texto, opcoes) values (p_conversa, 'cliente', 'Foto do pedido médico enviada.', jsonb_build_object('tipo', 'anexo', 'id', v_id))
  returning id into v_msg;
  perform set_config('fluxo.entrada', '', true);
  return jsonb_build_object('ok', true, 'id', v_id, 'mensagem_id', v_msg);
end $function$;

