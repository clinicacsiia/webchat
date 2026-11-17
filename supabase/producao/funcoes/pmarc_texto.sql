-- public.pmarc_texto(p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_texto(p_chave text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(nullif(btrim((select valor from public.config where chave = p_chave)), ''),
    case p_chave
      when 'previsao_marcacao_aviso' then 'Importante: esta é uma PREVISÃO de marcação. Ela ainda vai ser vista e confirmada pela nossa equipe, pelo webchat, pelo WhatsApp e por telefone.'
      when 'previsao_marcacao_final' then 'Anotamos o que você nos contou. A previsão vai ser vista e confirmada pela nossa equipe pelo webchat, pelo WhatsApp e por telefone. Se quiser, pode escrever aqui a qualquer momento.'
    end)
$function$;

