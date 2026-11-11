-- public.ocr_ia_salvar(p_anexo bigint, p_leitura jsonb, p_modelo text, p_ms integer, p_erro text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ocr_ia_salvar(p_anexo bigint, p_leitura jsonb, p_modelo text, p_ms integer, p_erro text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.conversa_anexo set ia_leitura = case when jsonb_typeof(p_leitura) = 'object' then p_leitura end,
    ia_modelo = left(p_modelo, 60), ia_ms = p_ms, ia_erro = left(p_erro, 500), ia_em = now()
  where id = p_anexo;
  return case when p_leitura is null then null else public.ocr_ia_grupos(p_anexo) end;
end $function$;

