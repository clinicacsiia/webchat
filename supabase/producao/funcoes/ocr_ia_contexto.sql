-- public.ocr_ia_contexto(p_conversa uuid, p_token text, p_anexo bigint)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ocr_ia_contexto(p_conversa uuid, p_token text, p_anexo bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a record; v_tipo text;
begin
  perform public.chat_valida(p_conversa, p_token);
  select id, mime, dados, ia_leitura into a from public.conversa_anexo where id = p_anexo and conversa_id = p_conversa;
  if a.id is null then raise exception 'Foto não encontrada.' using errcode = '22023'; end if;
  if a.ia_leitura is not null then return jsonb_build_object('pronto', public.ocr_ia_grupos(p_anexo)); end if;
  select paciente_tipo into v_tipo from public.conversas where id = p_conversa;
  return jsonb_build_object(
    'mime', a.mime, 'base64', encode(a.dados, 'base64'), 'paciente', case when v_tipo = 'filho' then 'criança ou adolescente' else 'adulto' end,
    'catalogo', (select jsonb_agg(jsonb_build_array(x.id, x.nome, x.modalidade) order by x.id) from public.fluxo_exames x),
    'aprendido', coalesce((select jsonb_agg(jsonb_build_array(q.exemplo, q.procedimento_id) order by q.vezes desc)
                           from (select ap.exemplo, ap.procedimento_id, ap.vezes from public.ocr_aprendido ap
                                 join public.fluxo_exames x on x.id = ap.procedimento_id
                                 where ap.exemplo is not null order by ap.vezes desc, ap.atualizado_em desc limit 120) q), '[]'::jsonb));
end $function$;

