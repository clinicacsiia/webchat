-- public.agendamento_perguntar(p_conversa uuid, p_modo text, p_item text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.agendamento_perguntar(p_conversa uuid, p_modo text, p_item text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a record; f record; v_dest uuid; v_item text; v_motor text; v_passo text; v_nome text;
begin
  perform public.pessoa_equipe();
  if p_modo = 'fechar' then
    select * into a from public.v_agendamento_aberto where conversa_id = p_conversa order by quando nulls last limit 1;
    if not found then raise exception 'Não há exame em aberto nesta conversa.' using errcode = '22023'; end if;
    v_item := coalesce(nullif(btrim(a.exames), ''), 'marcado') || coalesce(' (' || to_char(a.quando, 'DD/MM "às" HH24:MI') || ')', '');
    v_passo := 'exame_aberto';
  elsif p_modo = 'remarcar' then
    select * into f from public.v_remarcacao_pendente where conversa_id = p_conversa order by fechado_em desc limit 1;
    if not found then raise exception 'Não há remarcação pendente nesta conversa.' using errcode = '22023'; end if;
    v_item := coalesce(nullif(btrim(f.exames), ''), 'o seu exame') || coalesce(' (' || to_char(f.quando, 'DD/MM') || ')', '');
    v_passo := 'remarcar_falta';
  else
    raise exception 'Modo inválido.' using errcode = '22023';
  end if;
  v_item := coalesce(nullif(btrim(p_item), ''), v_item);
  select c.id, c.motor into v_dest, v_motor from public.conversas c where c.id = any (public.pessoa_membros(p_conversa)) order by c.atualizado_em desc limit 1;
  if v_motor = 'fluxo' then
    update public.conversas set ia_ativa = true, status = 'aguardando', agente_id = null where id = v_dest;
    insert into public.conversa_fluxo (conversa_id) values (v_dest) on conflict (conversa_id) do nothing;
    perform public.fluxo_set(v_dest, jsonb_build_object('pos_passo', v_passo, 'pos_origem', p_conversa, 'pos_item', left(v_item, 200),
      'identidade_feita', true, 'atalho_feito', true, 'confirmado', false));
    if p_modo = 'remarcar' then
      update public.agendamento_fechamento set remarcacao = 'pedida', atualizado_em = now() where id = f.fechamento_id and remarcacao = 'pendente';
    end if;
    perform public.fluxo_perguntar(v_dest, v_passo, null);
    return jsonb_build_object('ok', true, 'canal', 'botoes', 'conversa_id', v_dest);
  end if;
  select initcap(lower(split_part(btrim(coalesce(nullif(btrim(cv.nome_informado), ''), ct.nome)), ' ', 1))) into v_nome
    from public.conversas cv join public.contatos ct on ct.id = cv.contato_id where cv.id = v_dest;
  perform public.fluxo_dizer(v_dest, case p_modo
    when 'fechar' then 'Olá, ' || coalesce(v_nome, '') || '! O seu exame ' || v_item || ' ainda está em aberto no nosso sistema. Você compareceu, quer cancelar ou remarcar? Responda por aqui.'
    else 'Olá, ' || coalesce(v_nome, '') || '! Quer remarcar ' || v_item || '? Responda por aqui que um atendente te ajuda.' end);
  if p_modo = 'remarcar' then
    update public.agendamento_fechamento set remarcacao = 'pedida', atualizado_em = now() where id = f.fechamento_id and remarcacao = 'pendente';
  end if;
  return jsonb_build_object('ok', true, 'canal', 'mensagem', 'conversa_id', v_dest);
end $function$;

