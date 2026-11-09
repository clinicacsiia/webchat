-- Cronômetro de resposta: a resposta de uma PESSOA zera o relógio de todas as conversas abertas da mesma pessoa (09/11/2026).
-- Problema: duas conversas "unidas" (mesmo grupo ou mesmo contato). O atendente respondia na mais recente e o relógio da
-- mais antiga continuava ligado; a lista usa a espera mais antiga do grupo, então o contador não parava (e a conversa subia
-- para "Precisam de atenção" mesmo já respondida).
-- Aplicar em partes (cada bloco separado), como no restante do projeto.

-- Parte 1: ao inserir resposta de pessoa (agente_id preenchido), zera também as conversas abertas da mesma pessoa.
-- (O resto da função é igual ao de supabase/espera-longa.sql, Parte 2.)
create or replace function public.mensagem_inserida()
returns trigger language plpgsql security definer set search_path to '' as $$
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
end $$;

-- Parte 2: conserta o que já está errado agora: conversa aberta cujo relógio ficou para trás porque uma pessoa da equipe
-- respondeu depois, em outra conversa da mesma pessoa.
update public.conversas c set cliente_aguarda_desde = null
where c.status <> 'encerrada' and c.cliente_aguarda_desde is not null
  and exists (
    select 1 from public.mensagens m
    where m.autor = 'agente' and m.agente_id is not null
      and m.criado_em > c.cliente_aguarda_desde
      and m.conversa_id <> c.id
      and (m.conversa_id in (select g2.conversa_id from public.conversa_grupo g1
                               join public.conversa_grupo g2 on g2.grupo_id = g1.grupo_id
                              where g1.conversa_id = c.id)
           or m.conversa_id in (select x.id from public.conversas x where x.contato_id = c.contato_id)));
