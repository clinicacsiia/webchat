-- public.fluxo_proximo_assunto(p_conversa uuid, d jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_proximo_assunto(p_conversa uuid, d jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if d ->> 'assunto' is null then return 'assunto'; end if;
  if coalesce((d ->> 'assunto_resolvido')::boolean, false) then return 'assunto_fim'; end if;
  if d ->> 'assunto' = 'Resultado de exame' and not coalesce((d ->> 'resultado_feito')::boolean, false) then
    if d ->> 'resultado_situacao' is null then return 'resultado_situacao'; end if;
    if d ->> 'resultado_estado' = 'consultando' then return 'marc_consultando'; end if;
    return 'resultado_orientacao';
  end if;
  if public.fluxo_marc_ativo(p_conversa, d) then return public.fluxo_marc_proximo(p_conversa, d); end if;
  return 'assunto_texto';
end $function$;

