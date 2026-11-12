-- public.fluxo_voltar_passo(p_conversa uuid, p_op integer)
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.fluxo_voltar_passo(p_conversa uuid, p_op integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; v_motivo text;
begin
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb); v_motivo := d ->> 'motivo';
  case p_op
  when 1 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "g_carteira": false}');
  when 2 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "g_contato": false, "g_endereco": false}');
  when 3 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "g_ident": false}');
  when 4 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "mudou": null}');
  when 5 then
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null where conversa_id = p_conversa and status = 'rascunho';
    perform public.fluxo_set(p_conversa, '{"confirmado": false, "sem_horario": false}');
  when 6 then
    perform public.fluxo_set(p_conversa, jsonb_build_object('confirmado', false, 'plano_anterior', null, 'plano_trocado_de', null));
    update public.pre_agendamentos set plano = null where conversa_id = p_conversa and status = 'rascunho';
  when 7 then
    perform public.fluxo_set(p_conversa, '{"confirmado": false, "medico_feito": false}');
    update public.conversas set medico_preferido = null where id = p_conversa;
  when 8 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "refazer": "pedido"}');
  when 9 then
    if v_motivo = 'assunto' then perform public.fluxo_set(p_conversa, '{"assunto": null}'); end if;
  when 11 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "cpf_nasc_refazer": true}');   -- klingo-auto
  when 10 then
    perform public.fluxo_set(p_conversa, '{"confirmado": false, "motivo": null, "refazer": null, "medico_feito": false, "assunto": null}');
    update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
    update public.conversas set unidade_inicial = null, medico_preferido = null where id = p_conversa;
  else null;
  end case;
end $function$;

