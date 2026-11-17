-- public.pmarc_estado_gravar(p_modo text, p_resultado jsonb, p_erro text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_estado_gravar(p_modo text, p_resultado jsonb DEFAULT NULL::jsonb, p_erro text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.pmarc_estado set
    completo_em = case when p_erro is null and p_modo = 'completo' then now() else completo_em end,
    rapido_em = case when p_erro is null and p_modo in ('rapido', 'completo') then now() else rapido_em end,
    resultado = case when p_erro is null then p_resultado else resultado end,
    erro = left(p_erro, 300)
  where id;
end $function$;

