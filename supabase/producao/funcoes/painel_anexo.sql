-- public.painel_anexo(p_id bigint)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_anexo(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select jsonb_build_object('mime', a.mime, 'base64', encode(a.dados, 'base64'), 'ocr', a.ocr_texto, 'criado_em', a.criado_em,
    'ocr_linhas', a.ocr_linhas, 'ia', case when a.ia_leitura is not null then public.ocr_ia_grupos(a.id) end, 'ia_modelo', a.ia_modelo, 'ia_ms', a.ia_ms,
    'ia_erro', a.ia_erro, 'escolha', a.escolha, 'gabarito', a.gabarito, 'gabarito_em', a.gabarito_em,
    'itens', coalesce((select jsonb_agg(jsonb_build_object('procedimento_id', i.procedimento_id, 'procedimento', i.procedimento, 'lado', i.lado) order by i.id)
                       from public.pre_agendamento_itens i where i.conversa_id = a.conversa_id and i.ativo), '[]'::jsonb))
    into r
  from public.conversa_anexo a where a.id = p_id;
  return r;
end $function$;

