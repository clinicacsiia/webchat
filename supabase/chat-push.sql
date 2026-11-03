-- Push do chat do cliente (03/11/2026): avisa o celular/computador do cliente quando chega resposta, com o chat fechado ou em segundo plano.
-- Reaproveita as chaves VAPID e o segredo do Vault da fila (fila-chegada.sql). Sem dado de saúde no aviso: só "você recebeu uma resposta".
-- Parte 1 de 3: tabela e funções do navegador
create table if not exists public.chat_push_inscricao (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas(id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) <= 1000),
  p256dh text not null,
  auth text not null,
  criado_em timestamptz not null default now()
);
create index if not exists chat_push_inscricao_conversa_idx on public.chat_push_inscricao (conversa_id);
comment on table public.chat_push_inscricao is 'Aparelhos do cliente que aceitaram notificação no chat. Só as funções chat_push_* e a Edge Function chat-avisar (service_role) acessam.';
alter table public.chat_push_inscricao enable row level security;
revoke all on public.chat_push_inscricao from anon, authenticated;

insert into public.config (chave, valor) values ('chat_push_url', '') on conflict (chave) do nothing;   -- URL da função chat-avisar (vazio = sem push)

create or replace function public.chat_push_config() returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('vapid', coalesce((select valor from public.config where chave = 'fila_vapid_publica'), ''))
$$;

create or replace function public.chat_push_salvar(p_conversa uuid, p_token text, p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if not exists (select 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token) then
    raise exception 'Conversa não encontrada.' using errcode = '28000';
  end if;
  if coalesce(p_endpoint, '') !~ '^https://' or char_length(p_endpoint) > 1000 or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Inscrição de notificação inválida.' using errcode = '22023';
  end if;
  insert into public.chat_push_inscricao (conversa_id, endpoint, p256dh, auth) values (p_conversa, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set conversa_id = excluded.conversa_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.chat_push_remover(p_conversa uuid, p_token text, p_endpoint text) returns void
language sql security definer set search_path to '' as $$
  delete from public.chat_push_inscricao i using public.conversa_segredo s
   where i.endpoint = p_endpoint and i.conversa_id = p_conversa and s.conversa_id = p_conversa and s.token = p_token
$$;

grant execute on function public.chat_push_config() to anon, authenticated;
grant execute on function public.chat_push_salvar(uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.chat_push_remover(uuid, text, text) to anon, authenticated;

-- Parte 2 de 3: gatilho (resposta da equipe ou do assistente -> chama a função chat-avisar)
create or replace function public.chat_push_trg() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_url text; v_seg text;
begin
  if new.autor <> 'agente' then return null; end if;
  if not exists (select 1 from public.chat_push_inscricao where conversa_id = new.conversa_id) then return null; end if;
  select valor into v_url from public.config where chave = 'chat_push_url';
  v_seg := public.fila_aviso_segredo();
  if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
    begin
      perform net.http_post(url := v_url, body := jsonb_build_object('conversa', new.conversa_id, 'mensagem', new.id),
                            headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
    exception when others then null;   -- falha de rede não derruba o chat
    end;
  end if;
  return null;
end $$;
revoke all on function public.chat_push_trg() from public, anon, authenticated;

-- Parte 3 de 3: ligar o gatilho
create or replace trigger mensagens_chat_push after insert on public.mensagens
  for each row execute function public.chat_push_trg();
