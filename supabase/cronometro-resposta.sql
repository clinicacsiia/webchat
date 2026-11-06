-- Cronômetro de resposta: desde quando o paciente espera uma resposta HUMANA.
-- O painel pinta a conversa de vermelho depois de 2 minutos e mostra um cronômetro até alguém responder.
-- Aplicar em partes (cada bloco separado), como no restante do projeto.

-- Parte 1: coluna
alter table public.conversas add column if not exists cliente_aguarda_desde timestamptz;

-- Parte 2: a mensagem do paciente começa a contar; a resposta de um atendente (ou do assistente) zera.
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
      when new.autor = 'agente' then null
      else cliente_aguarda_desde end
  where id = new.conversa_id;
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

-- Parte 3: ao encerrar zera; quando o assistente passa a conversa para a equipe, o relógio começa nesse momento.
create or replace function public.conversa_antes_update()
returns trigger language plpgsql set search_path to '' as $$
begin
  if new.status is distinct from old.status then
    new.encerrada_em := case when new.status = 'encerrada' then now() else null end;
    if old.status = 'encerrada' and new.status = 'aguardando' then
      new.ia_ativa := true; new.triagem_resumo := null; new.triagem_urgencia := null;
    end if;
    if new.status = 'encerrada' then new.cliente_aguarda_desde := null; end if;
  end if;
  if old.ia_ativa and not new.ia_ativa and new.status <> 'encerrada' then
    new.cliente_aguarda_desde := now();
  end if;
  return new;
end $$;

-- Parte 4: conversas abertas agora (sem assistente): conta desde a primeira mensagem do paciente depois da última resposta da equipe.
update public.conversas c set cliente_aguarda_desde = x.desde
from (
  select c2.id, (select min(m.criado_em) from public.mensagens m
                  where m.conversa_id = c2.id and m.autor = 'cliente'
                    and m.id > coalesce((select max(a.id) from public.mensagens a where a.conversa_id = c2.id and a.autor = 'agente'), 0)) as desde
  from public.conversas c2 where c2.status <> 'encerrada' and not (c2.ia_ativa and c2.status = 'aguardando')
) x
where x.id = c.id and x.desde is not null;
