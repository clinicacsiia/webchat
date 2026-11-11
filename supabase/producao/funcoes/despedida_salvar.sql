-- public.despedida_salvar(p_texto text, p_mime text, p_base64 text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.despedida_salvar(p_texto text, p_mime text DEFAULT NULL::text, p_base64 text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_txt text := nullif(btrim(coalesce(p_texto, '')), ''); v_bin bytea; v_id bigint; v_b0 int; v_b1 int; v_b2 int; v_b3 int;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só o administrador pode alterar a despedida.' using errcode = '42501'; end if;
  if v_txt is not null and char_length(v_txt) > 600 then raise exception 'O texto da despedida pode ter até 600 caracteres.' using errcode = '22023'; end if;
  if nullif(p_base64, '') is not null then
    if p_mime not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'Envie uma imagem JPG, PNG ou WebP.' using errcode = '22023'; end if;
    if length(p_base64) > 2800000 then raise exception 'A imagem é grande demais (máximo de cerca de 2 MB).' using errcode = '22023'; end if;
    begin v_bin := decode(regexp_replace(p_base64, '^data:[^,]*,', ''), 'base64'); exception when others then raise exception 'Imagem inválida.' using errcode = '22023'; end;
    if length(v_bin) < 12 then raise exception 'Imagem inválida.' using errcode = '22023'; end if;
    v_b0 := get_byte(v_bin, 0); v_b1 := get_byte(v_bin, 1); v_b2 := get_byte(v_bin, 2); v_b3 := get_byte(v_bin, 3);
    if not ((p_mime = 'image/jpeg' and v_b0 = 255 and v_b1 = 216 and v_b2 = 255)
         or (p_mime = 'image/png' and v_b0 = 137 and v_b1 = 80 and v_b2 = 78 and v_b3 = 71)
         or (p_mime = 'image/webp' and v_b0 = 82 and v_b1 = 73 and v_b2 = 70 and v_b3 = 70 and get_byte(v_bin, 8) = 87 and get_byte(v_bin, 9) = 69 and get_byte(v_bin, 10) = 66 and get_byte(v_bin, 11) = 80)) then
      raise exception 'O arquivo não é uma imagem do tipo informado.' using errcode = '22023';
    end if;
  else
    v_bin := null; p_mime := null;
  end if;
  if v_txt is null and v_bin is null then
    update public.config set valor = '' where chave = 'despedida_versao_atual';
    return jsonb_build_object('ok', true, 'versao', null);
  end if;
  insert into public.despedida_versao (texto, mime, dados, criado_por) values (v_txt, p_mime, v_bin, (select auth.uid())) returning id into v_id;
  update public.config set valor = v_id::text where chave = 'despedida_versao_atual';
  return jsonb_build_object('ok', true, 'versao', v_id);
end $function$;

