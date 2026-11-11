-- public.mensagem_inserida()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.mensagem_inserida()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_token text; v_nome text;
begin
  update public.conversas set
    ultima_mensagem = left(new.texto, 140),
    atualizado_em = now(),
    nao_lidas_agente = case when new.autor = 'cliente' then nao_lidas_agente + 1 else nao_lidas_agente end,
    cliente_aguarda_desde = case
      when new.autor = 'cliente' then coalesce(cliente_aguarda_desde, new.criado_em)
      when new.autor = 'agente' and new.agente_id is not null then null
      else cliente_aguarda_desde end
  where id = new.conversa_id;
  if new.autor = 'agente' and new.agente_id is not null then
    update public.conversas c set cliente_aguarda_desde = null
    where c.id <> new.conversa_id and c.status <> 'encerrada' and c.cliente_aguarda_desde is not null
      and (c.id in (select g2.conversa_id from public.conversa_grupo g1
                      join public.conversa_grupo g2 on g2.grupo_id = g1.grupo_id
                     where g1.conversa_id = new.conversa_id)
           or c.contato_id = (select x.contato_id from public.conversas x where x.id = new.conversa_id));
  end if;
  if new.autor = 'cliente' then
    update public.contatos set ultimo_contato_em = now()
    where id = (select contato_id from public.conversas where id = new.conversa_id);
  end if;
  select token into v_token from public.conversa_segredo where conversa_id = new.conversa_id;
  if v_token is not null then
    select nome into v_nome from public.agentes where id = new.agente_id;
    if v_nome is null and new.autor = 'agente' then v_nome := 'Assistente virtual'; end if;
    begin
      perform realtime.send(
        jsonb_build_object('id', new.id, 'autor', new.autor, 'texto', new.texto,
                           'criado_em', new.criado_em, 'agente', v_nome, 'opcoes', new.opcoes),
        'msg', 'conversa:' || v_token, false);
    exception when others then null;
    end;
  end if;
  return new;
end $function$;

