-- FLUXOGRAMA: entrada (banco com o módulo da fila de assinatura: fila-biometria.sql, instalação nova ou v1 + fila-biometria-v2-delta.sql) -> validação (fila_aviso_segredo existe; o resultado não cita mais o n8n) -> lógica (o aviso de link vai para a Edge Function fila-emitir-link com o segredo do Vault no cabeçalho e SÓ o id do atendimento no corpo; fila_entrar e fila_reenviar_link passam a usar a função nova) -> saída (módulo sem referência ao n8n; fila_n8n_autorizado continua como o porteiro por cabeçalho, agora usado pelas Edge Functions)
-- Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial. Plano em docs/plano-sair-do-n8n.md.
--
-- Pré-requisitos: supabase/fila-chegada.sql já aplicado (cria fila_aviso_segredo, o segredo compartilhado com as Edge Functions).
-- ROLLBACK: fila_avisar_n8n e as versões antigas de fila_entrar / fila_reenviar_link estão em fila-biometria.sql / fila-biometria-v2-delta.sql.
-- Nota de nome: a função fila_n8n_autorizado() mantém o nome por histórico; ela só confere o cabeçalho x-fila-segredo.

insert into public.config (chave, valor) values ('fila_link_url', '') on conflict (chave) do nothing;   -- URL da Edge Function fila-emitir-link (vazio = sem envio)

create or replace function public.fila_avisar_link(p_atendimento uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare v_url text; v_seg text;
begin
  select valor into v_url from public.config where chave = 'fila_link_url';
  v_seg := public.fila_aviso_segredo();
  if coalesce(v_url, '') = '' or coalesce(v_seg, '') = '' then return; end if;
  if not exists (select 1 from public.atendimentos where id = p_atendimento) then return; end if;
  begin
    -- Só o id vai no corpo: nome e e-mail a função busca no banco, com o segredo do módulo.
    perform net.http_post(url := v_url, body := jsonb_build_object('atendimento_uuid', p_atendimento),
                          headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
  exception when others then
    raise warning 'fila_avisar_link: %', sqlerrm;   -- falha de rede nunca desfaz a entrada na fila
  end;
end $$;
revoke all on function public.fila_avisar_link(uuid) from public, anon, authenticated;

-- fila_entrar e fila_reenviar_link: trocam só o nome da função chamada e da chave de configuração, partindo da definição do banco.
do $$
declare f text; d text;
begin
  foreach f in array array['public.fila_entrar(text,text,text)', 'public.fila_reenviar_link(uuid)'] loop
    d := pg_get_functiondef(f::regprocedure);
    if d like '%fila_avisar_n8n%' or d like '%fila_webhook_url%' then
      d := replace(replace(d, 'fila_avisar_n8n', 'fila_avisar_link'), 'fila_webhook_url', 'fila_link_url');
      if d like '%n8n%' then raise exception '% ainda cita o n8n; nada foi alterado', f; end if;
      execute d;
    end if;
  end loop;
end $$;

-- Remoção (parte destrutiva; pede confirmação no Supabase)
drop function if exists public.fila_avisar_n8n(uuid);
delete from public.config where chave = 'fila_webhook_url';
