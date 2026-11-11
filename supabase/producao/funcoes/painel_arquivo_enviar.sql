-- public.painel_arquivo_enviar(p_conversa uuid, p_nome text, p_mime text, p_base64 text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_arquivo_enviar(p_conversa uuid, p_nome text, p_mime text, p_base64 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_bin bytea; v_id bigint; v_msg bigint; v_nome text; v_pdf boolean;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') then raise exception 'Envie uma foto (JPG, PNG) ou um PDF.' using errcode = '22023'; end if;
  if length(coalesce(p_base64, '')) > 7000000 then raise exception 'O arquivo é grande demais (máximo 5 MB).' using errcode = '22023'; end if;
  if (select count(*) from public.conversa_anexo where conversa_id = p_conversa and tipo = 'equipe_arquivo') >= 20 then raise exception 'Limite de arquivos desta conversa atingido.' using errcode = '54000'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = '22023'; end if;
  begin v_bin := decode(regexp_replace(p_base64, '^data:[^,]*,', ''), 'base64'); exception when others then raise exception 'Arquivo inválido.' using errcode = '22023'; end;
  v_pdf := p_mime = 'application/pdf';
  if v_pdf and convert_from(substring(v_bin from 1 for 5), 'LATIN1') <> '%PDF-' then raise exception 'Esse arquivo não é um PDF.' using errcode = '22023'; end if;
  if not v_pdf and not (substring(v_bin from 1 for 2) = '\xffd8'::bytea or substring(v_bin from 1 for 4) = '\x89504e47'::bytea or substring(v_bin from 1 for 4) = '\x52494646'::bytea) then
    raise exception 'Esse arquivo não é uma imagem válida.' using errcode = '22023'; end if;
  v_nome := left(coalesce(nullif(btrim(regexp_replace(coalesce(p_nome, ''), '[[:cntrl:]<>"]', '', 'g')), ''), case when v_pdf then 'documento.pdf' else 'foto.jpg' end), 120);
  insert into public.conversa_anexo (conversa_id, tipo, mime, dados, nome) values (p_conversa, 'equipe_arquivo', p_mime, v_bin, v_nome) returning id into v_id;
  insert into public.mensagens (conversa_id, autor, agente_id, texto, opcoes)
    values (p_conversa, 'agente', (select auth.uid()), case when v_pdf then 'Documento enviado: ' else 'Foto enviada: ' end || v_nome,
            jsonb_build_object('tipo', 'arquivo', 'id', v_id, 'nome', v_nome, 'mime', p_mime))
    returning id into v_msg;
  return jsonb_build_object('ok', true, 'id', v_id, 'mensagem_id', v_msg);
end $function$;

