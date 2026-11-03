-- FLUXOGRAMA: entrada (banco em produção com o motor `fluxo` e o n8n já desligado: config.n8n_webhook_url vazio) -> validação (cada troca confere que o resultado não cita mais o n8n; os DROP falham se alguma coisa ainda depende do objeto) -> lógica (transferência avisa a equipe por Web Push em vez do n8n; todo chat novo usa o motor; conversas antigas da IA passam para a equipe; remove o gatilho e as funções que só o n8n usava) -> saída (banco sem nenhuma referência ao n8n fora do módulo da fila, que está em saida-n8n-fila.sql)
-- Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial. Plano em docs/plano-sair-do-n8n.md.
--
-- Aplicar em PARTES (o Supabase expira a migração em 60 s e pede confirmação nos DROP):
--   parte 1 = seções 1 a 3 (create or replace e dados; sem nada destrutivo)
--   parte 2 = seção 4 (os DROP)
-- ROLLBACK: as definições antigas estão nos arquivos fase6-unidade-e-medico.sql (chat_iniciar), fase7-motor.sql (fluxo_transferir,
-- conversas_motor_trg), 00-base-snapshot.sql (gatilho e funções ia_*) e nas migrações do Supabase. Nenhum dado de paciente é apagado.

-- ===== 1. Endereço do aviso à equipe (vazio = sem aviso por push; o painel aberto continua avisando por som e tela) =====
insert into public.config (chave, valor) values ('equipe_push_url', '') on conflict (chave) do nothing;

-- ===== 2. Transferência para a equipe: sem n8n, com Web Push (Edge Function avisar-equipe) =====
create or replace function public.fluxo_transferir(p_conversa uuid, p_motivo text, p_urgencia text, p_avisar boolean) returns void
language plpgsql security definer set search_path to '' as $$
declare v_url text; v_seg text; v_on boolean := public.fluxo_equipe_online();
begin
  update public.conversas set ia_ativa = false,
    triagem_resumo = left(btrim(coalesce(p_motivo, '') || E'\n' || coalesce(public.fluxo_resumo(p_conversa), '')), 1000),
    triagem_urgencia = case when p_urgencia in ('baixa','media','alta') then p_urgencia else 'baixa' end
  where id = p_conversa;
  update public.conversa_fluxo set passo = case when passo = 'pronto' then 'pronto' else 'humano' end,
    dados = dados || jsonb_build_object('transferido_em', now()), atualizado_em = now() where conversa_id = p_conversa;
  if p_avisar then
    perform public.fluxo_dizer(p_conversa, public.fluxo_t(case when v_on then 'transferir_online' else 'transferir_offline' end, public.fluxo_ctx(p_conversa)),
                               jsonb_build_object('tipo', 'acompanhar'));
  end if;
  -- Aviso à equipe com o painel fechado: só o id da conversa e a urgência (nada de nome ou motivo). Falha de rede nunca desfaz a transferência.
  select valor into v_url from public.config where chave = 'equipe_push_url';
  v_seg := public.fila_aviso_segredo();
  if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
    begin
      perform net.http_post(url := v_url, body := jsonb_build_object('conversa', p_conversa, 'urgencia', p_urgencia),
                            headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
    exception when others then null;
    end;
  end if;
end $$;

-- chat_iniciar: tira só o bloco que avisava o n8n, partindo da definição que está no banco (a função é grande e é a porta de entrada
-- de todo paciente; não se reescreve à mão). Idempotente: se o bloco já não existe, não faz nada.
do $$
declare d text; novo text;
begin
  d := pg_get_functiondef('public.chat_iniciar(text,text,text,text,boolean,text,text,text,text,text,jsonb,text)'::regprocedure);
  if d like '%n8n%' then
    novo := regexp_replace(d, E'\n  select valor into v_url from public\\.config where chave = ''n8n_webhook_url'';\n  if coalesce\\(v_url, ''''\\) <> '''' then\n.*?\n  end if;\n', E'\n');
    if novo = d or novo like '%n8n%' then raise exception 'chat_iniciar: não consegui remover o bloco do n8n; nada foi alterado'; end if;
    execute novo;
  end if;
end $$;

-- ===== 3. O motor de regras é o único caminho =====
-- Toda conversa nova usa o motor (config.motor e a lista de telefones de teste deixam de valer). O valor 'ia' continua aceito na coluna
-- só para as conversas antigas.
create or replace function public.conversas_motor_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  new.motor := 'fluxo';
  return new;
end $$;

-- Conversas que a IA ainda atendia (motor 'ia', ativas): ninguém responde mais por elas. Passam para a equipe, que as vê na fila com o aviso.
update public.conversas
   set ia_ativa = false,
       triagem_resumo = left(btrim(coalesce(triagem_resumo, '') || E'\nO atendimento automático por IA foi encerrado em 03/11/2026: continuar com uma pessoa.'), 1000)
 where motor = 'ia' and status = 'aguardando' and ia_ativa;

-- ===== 4. Remoção (parte 2; os DROP pedem confirmação no Supabase e falham se algo ainda depender do objeto) =====
drop trigger if exists mensagens_avisar_n8n on public.mensagens;
drop function if exists public.avisar_n8n_mensagem();
drop function if exists public.ia_contexto(text, uuid);
drop function if exists public.ia_responder(text, uuid, text, text, text, boolean);
drop function if exists public.ia_responder_v2(text, uuid, text, text, text, boolean, jsonb);
drop function if exists public.ia_catalogo(text, uuid);
delete from public.config where chave in ('n8n_webhook_url', 'n8n_webhook_token');
