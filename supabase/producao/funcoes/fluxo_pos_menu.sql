-- public.fluxo_pos_menu(p_conversa uuid, p_texto text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_pos_menu(p_conversa uuid, p_texto text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_it jsonb := jsonb_build_array(jsonb_build_object('valor', 'ver', 'rotulo', 'Ver a minha marcação'));
begin
  update public.conversa_fluxo set passo = 'pos_menu', atualizado_em = now() where conversa_id = p_conversa;
  if public.klingo_ativo(p_conversa, 'klingo_api_pos')
     and exists (select 1 from public.pre_agendamentos pa where pa.conversa_id = p_conversa and pa.agendado_origem = 'chat_api' and pa.status = 'agendado') then
    v_it := v_it || jsonb_build_object('valor', 'remarcar', 'rotulo', 'Remarcar') || jsonb_build_object('valor', 'cancelar', 'rotulo', 'Cancelar') || jsonb_build_object('valor', 'equipe', 'rotulo', 'Falar com a equipe');
  else
    v_it := v_it || jsonb_build_object('valor', 'equipe', 'rotulo', 'Remarcar, cancelar ou falar com a equipe');
  end if;
  v_it := v_it || jsonb_build_object('valor', 'fim', 'rotulo', 'Está tudo certo, obrigado');
  perform public.fluxo_dizer(p_conversa, coalesce(p_texto, public.fluxo_t('pos_menu', public.fluxo_ctx(p_conversa))), public.fluxo_escolha('pos_menu', v_it));
end $function$;

