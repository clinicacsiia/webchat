-- public.jornada_remarcar_pelo_chat(p_card bigint)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_remarcar_pelo_chat(p_card bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_conv uuid; v_item text; v_dest uuid; v_motor text; v_quando date;
begin
  perform public.pessoa_equipe();
  select p.conversa_id into v_conv from public.jornada_pessoas() p where p.card_id = p_card;
  if v_conv is null then raise exception 'Este paciente não está ligado a uma conversa do chat. Ligue para oferecer a nova data.' using errcode = '22023'; end if;
  select string_agg(distinct initcap(lower(e.procedimento)), ' + '), min(c.data_ref) into v_item, v_quando
    from public.jornada_card c join public.jornada_exame e on e.card_id = c.id where c.id = p_card and e.status = 'faltou';
  if v_item is null then raise exception 'Este cartão não tem exame com falta.' using errcode = '22023'; end if;
  v_item := v_item || ' (' || to_char(v_quando, 'DD/MM') || ')';
  select c.id, c.motor into v_dest, v_motor from public.conversas c where c.id = any (public.pessoa_membros(v_conv)) order by c.atualizado_em desc limit 1;
  if v_motor = 'fluxo' then
    update public.conversas set ia_ativa = true, status = 'aguardando', agente_id = null where id = v_dest;
    insert into public.conversa_fluxo (conversa_id) values (v_dest) on conflict (conversa_id) do nothing;
    perform public.fluxo_set(v_dest, jsonb_build_object('pos_passo', 'remarcar_falta', 'pos_origem', v_dest, 'pos_copiar', false, 'refazer', 'pedido', 'pos_item', left(v_item, 200),
      'identidade_feita', true, 'atalho_feito', true, 'confirmado', false));
    perform public.fluxo_perguntar(v_dest, 'remarcar_falta', null);
    return jsonb_build_object('ok', true, 'canal', 'botoes', 'conversa_id', v_dest);
  end if;
  perform public.fluxo_dizer(v_dest, 'Olá! Você não pôde comparecer a ' || v_item || '. Quer remarcar? Responda por aqui que um atendente te ajuda.');
  return jsonb_build_object('ok', true, 'canal', 'mensagem', 'conversa_id', v_dest);
end $function$;

