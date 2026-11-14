-- public.fluxo_marc_iniciar(p_conversa uuid, p_assunto text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_marc_iniciar(p_conversa uuid, p_assunto text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_op uuid;
begin
  perform public.fluxo_set(p_conversa, '{"marc_estado": null, "marc_op": null, "marc_voucher": null, "marc_acao": null, "resultado_situacao": null, "resultado_feito": null, "resultado_estado": null, "resultado_op": null, "assunto_resolvido": null}'::jsonb);
  if p_assunto in ('Remarcar', 'Cancelar', 'Minhas marcações') then
    v_op := public.klingo_marcacoes_pedir(p_conversa);
    if v_op is null then perform public.fluxo_set(p_conversa, '{"marc_estado": "local"}'::jsonb); end if;
  end if;
end $function$;

