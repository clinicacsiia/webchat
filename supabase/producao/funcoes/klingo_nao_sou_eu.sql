-- public.klingo_nao_sou_eu(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_nao_sou_eu(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- apaga os dados guardados do paciente no pedido desta conversa e pede tudo de novo, sem preenchimento prévio
  update public.pre_agendamentos set paciente = '{}'::jsonb, atualizado_em = now() where conversa_id = p_conversa and status = 'rascunho';
  perform public.fluxo_set(p_conversa, jsonb_build_object('nao_sou_eu', true, 'cpf_confirmado', true, 'confirmado', false, 'g_ident', false, 'g_contato', false, 'g_endereco', false,
                                                         'mudou', 'mudou', 'digitado', '{}'::jsonb, 'cpf_nasc_refazer', null, 'cpf_tentativas', 0));
end $function$;

