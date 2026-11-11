-- public.fluxo_proximo_assunto(p_conversa uuid, d jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_proximo_assunto(p_conversa uuid, d jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_res text;
begin
  if d ->> 'assunto' is null then return 'assunto'; end if;
  if coalesce((d ->> 'assunto_resolvido')::boolean, false) then return 'assunto_fim'; end if;
  if d ->> 'assunto' = 'Resultado de exame' and not coalesce((d ->> 'assunto_resultado_feito')::boolean, false) then
    select nullif(btrim(texto), '') into v_res from public.fluxo_texto where chave = 'resultado_orientacao';
    if v_res is not null then return 'assunto_resultado'; end if;
  end if;
  if d ->> 'assunto' in ('Remarcar', 'Cancelar') then
    if d ->> 'assunto_item' is not null and d ->> 'assunto' = 'Cancelar' and not coalesce((d ->> 'assunto_confirmado')::boolean, false) then
      return 'assunto_confirma';
    end if;
    if d ->> 'assunto_item' is null and not coalesce((d ->> 'assunto_qual_feito')::boolean, false)
       and jsonb_array_length(public.fluxo_assunto_futuros(p_conversa)) > 0 then
      return 'assunto_qual';
    end if;
  end if;
  return 'assunto_texto';
end $function$;

