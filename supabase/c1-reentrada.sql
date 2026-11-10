-- FLUXOGRAMA: entrada (paciente toca "Nova conversa" num aparelho que já guarda uma conversa; ou escreve numa conversa encerrada; ou a rotina de inatividade fecha uma conversa; ou a equipe transfere) -> validação (o token da conversa antiga prova que ELA está neste aparelho; encerrada há mais de reabrir_dias (2) não reabre; conversa fechada pelo próprio paciente por "nova conversa" não reabre por mensagem) -> lógica (encerra a antiga e abre a nova NA MESMA CHAMADA; guarda o aceite da "previsão", o motivo da reentrada informado pelo paciente e o que a regra automática diria; remarcação pendente passa para a conversa nova; transferência reinicia as 24 h; inatividade tem texto próprio e avisa a equipe) -> saída (chat_reentrada_estado, chat_nova_conversa, chat_previsao_aceitar, chat_enviar com janela, notificações da equipe e eventos na linha do tempo)
-- Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial da Etapa C1 (Q-04, Q-05, Q-10 e seções E, F, G, H, I do planejamento de 10/11/2026).
-- Pré-requisitos: etapa0-eventos-e-teste.sql, autoencerrar.sql, despedida.sql, encerramento-motivo.sql, pessoa-unica.sql. Aditivo; funções antigas continuam (o PWA com cache antigo segue funcionando: chat_iniciar não muda).
-- Chaves em config: reabrir_dias (2), despedida_inatividade_ativa (sim) e despedida_inatividade_texto (TEXTO PROPOSTO: o dono precisa aprovar/editar), previsao_texto (idem).
-- DESLIGAR por partes: update public.config set valor = '36500' where chave = 'reabrir_dias';  (volta a reabrir sempre)   |   update public.config set valor = 'nao' where chave = 'despedida_inatividade_ativa';  (volta a despedida única)
-- ROLLBACK: drop function public.chat_reentrada_estado(uuid, text), public.chat_nova_conversa(uuid, text, text, text, text, boolean, boolean, text, text, text, text, text, jsonb, text, text, text), public.chat_previsao_aceitar(uuid, text), public.conversa_transferida_reinicia_trg();
--           drop trigger conversas_zz_transferencia on public.conversas;  (chat_enviar, autoencerrar_candidatas, autoencerrar_vigiar e conversa_status_mudou: reaplicar as versões de encerramento-motivo.sql/autoencerrar.sql/despedida.sql)

-- ===== PARTE 1: colunas, chaves e valores novos de motivo/origem =====
insert into public.config (chave, valor) values
  ('reabrir_dias', '2'),
  ('despedida_inatividade_ativa', 'sim'),
  ('despedida_inatividade_texto', 'Como não recebemos resposta nas últimas 24 horas, encerramos este atendimento por enquanto. Seu histórico fica salvo. Quando quiser continuar, é só enviar uma mensagem aqui (até 2 dias depois) ou abrir uma nova conversa. Estamos à disposição!'),
  ('previsao_texto', 'Os dias e horários que mostramos aqui são uma PREVISÃO. Quem confirma o seu agendamento é uma pessoa da nossa equipe.')
on conflict (chave) do nothing;

alter table public.conversas add column if not exists previsao_aceita_em timestamptz;
alter table public.conversas add column if not exists reentrada_de uuid references public.conversas (id) on delete set null;
alter table public.conversas add column if not exists reentrada_motivo text;
alter table public.conversas add column if not exists reentrada_motivo_auto text;
alter table public.conversas add column if not exists reentrada_texto_informado boolean;
comment on column public.conversas.previsao_aceita_em is 'Quando o paciente marcou que está ciente de que os horários são previsão e a equipe confirma.';
comment on column public.conversas.reentrada_de is 'Conversa anterior (do mesmo aparelho) que foi encerrada ou retomada quando esta nasceu.';
comment on column public.conversas.reentrada_motivo is 'O que o paciente respondeu ao voltar: sem_retorno ou outro_assunto. O texto digitado NÃO fica aqui (vira a primeira mensagem da conversa).';
comment on column public.conversas.reentrada_motivo_auto is 'O que a regra automática diria (sem_retorno se a anterior terminou sem resposta de pessoa ou por inatividade; senão outro_assunto). Só quando a anterior é do mesmo dia.';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversas_reentrada_motivo_ck') then
    alter table public.conversas add constraint conversas_reentrada_motivo_ck check (reentrada_motivo is null or reentrada_motivo in ('sem_retorno', 'outro_assunto'));
  end if;
end $$;
create index if not exists conversas_reentrada_de_idx on public.conversas (reentrada_de) where reentrada_de is not null;

-- ===== PARTE 2: notificações da equipe (sino do painel) =====
create table if not exists public.equipe_notificacao (
  id bigint generated always as identity primary key,
  agente_id uuid references public.agentes (id) on delete cascade,
  tipo text not null,
  conversa_id uuid references public.conversas (id) on delete cascade,
  detalhe jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  lida_em timestamptz
);
create index if not exists equipe_notificacao_destino_idx on public.equipe_notificacao (agente_id, criado_em desc) where lida_em is null;
alter table public.equipe_notificacao enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'equipe_notificacao' and policyname = 'equipe_notificacao_select') then
    create policy equipe_notificacao_select on public.equipe_notificacao for select
      using ((select public.papel_atual()) in ('admin', 'atendente') and (agente_id = (select auth.uid()) or (agente_id is null and (select public.papel_atual()) = 'admin')));
  end if;
end $$;
grant select on public.equipe_notificacao to authenticated;

create or replace function public.equipe_notificacao_lida(p_ids bigint[] default null) returns integer
language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  update public.equipe_notificacao set lida_em = now()
   where lida_em is null and agente_id = (select auth.uid()) and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.equipe_notificacao_lida(bigint[]) from public, anon;
grant execute on function public.equipe_notificacao_lida(bigint[]) to authenticated;

-- ===== PARTE 3: estado da conversa guardada no aparelho (só quem tem o token) =====
create or replace function public.chat_reentrada_estado(p_conversa uuid, p_token text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare c public.conversas; v_dias integer; v_ult timestamptz; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select c2.* into c from public.conversas c2 join public.conversa_segredo s on s.conversa_id = c2.id where c2.id = p_conversa and s.token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  v_dias := coalesce((select case when valor ~ '^[0-9]+$' then valor::int end from public.config where chave = 'reabrir_dias'), 2);
  select greatest(c.criado_em, coalesce(max(m.criado_em), c.criado_em)) into v_ult from public.mensagens m where m.conversa_id = c.id;
  return jsonb_build_object(
    'status', c.status, 'aberta', c.status <> 'encerrada', 'encerrada_em', c.encerrada_em, 'janela_dias', v_dias,
    'pode_voltar', c.status <> 'encerrada' or (c.encerrada_em > now() - make_interval(days => v_dias) and coalesce(c.encerramento_origem, '') <> 'paciente'),
    'mesmo_dia', (v_ult at time zone 'America/Sao_Paulo')::date = v_hoje,
    'teve_resposta_humana', c.primeiro_humano_em is not null,
    'em_atendimento', c.status = 'em_atendimento');
end $$;
revoke all on function public.chat_reentrada_estado(uuid, text) from public;
grant execute on function public.chat_reentrada_estado(uuid, text) to anon, authenticated;

-- ===== PARTE 4: "ciente de que é previsão" (aparelho/PWA que já tem a conversa) =====
create or replace function public.chat_previsao_aceitar(p_conversa uuid, p_token text) returns boolean
language plpgsql security definer set search_path to '' as $$
begin
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  update public.conversas set previsao_aceita_em = coalesce(previsao_aceita_em, now()) where id = p_conversa;
  return true;
end $$;
revoke all on function public.chat_previsao_aceitar(uuid, text) from public;
grant execute on function public.chat_previsao_aceitar(uuid, text) to anon, authenticated;

-- ===== PARTE 5: nova conversa (encerra a antiga e abre a nova numa chamada só) =====
create or replace function public.chat_nova_conversa(
  p_conversa_anterior uuid, p_token_anterior text,
  p_nome text, p_telefone text, p_email text default null, p_aceite boolean default false, p_aceite_previsao boolean default false,
  p_origem text default null, p_unidade text default null, p_medico text default null, p_paciente_tipo text default 'proprio', p_paciente_nome text default null,
  p_irmaos jsonb default null, p_irmaos_modo text default null, p_motivo text default null, p_motivo_texto text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  a public.conversas; v_dias integer; v_ult timestamptz; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), ''); v_texto text := nullif(left(btrim(coalesce(p_motivo_texto, '')), 1000), '');
  v_mesmo_dia boolean := false; v_auto text; v_res jsonb; v_nova uuid; v_rep record;
begin
  if v_motivo is not null and v_motivo not in ('sem_retorno', 'outro_assunto') then raise exception 'Motivo inválido.' using errcode = '22023'; end if;
  if p_conversa_anterior is not null then
    select c2.* into a from public.conversas c2 join public.conversa_segredo s on s.conversa_id = c2.id
     where c2.id = p_conversa_anterior and s.token = p_token_anterior for update of c2;
    if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
    -- duas abas do mesmo aparelho: a segunda recebe a conversa nova que a primeira acabou de criar
    select c3.id, s2.token into v_rep from public.conversas c3 join public.conversa_segredo s2 on s2.conversa_id = c3.id
     where c3.reentrada_de = a.id and c3.criado_em > now() - interval '2 minutes' order by c3.criado_em desc limit 1;
    if v_rep.id is not null then
      return jsonb_build_object('conversa_id', v_rep.id, 'token', v_rep.token, 'repetida', true, 'respostas', public.chat_respostas(v_rep.id, 0));
    end if;
    select greatest(a.criado_em, coalesce(max(m.criado_em), a.criado_em)) into v_ult from public.mensagens m where m.conversa_id = a.id;
    v_mesmo_dia := (v_ult at time zone 'America/Sao_Paulo')::date = v_hoje;
    if v_mesmo_dia then
      v_auto := case when a.primeiro_humano_em is null or a.encerramento_origem = 'inatividade' then 'sem_retorno' else 'outro_assunto' end;
    end if;
    -- encerra a antiga (se ainda aberta) ANTES de criar a nova, na mesma transação
    if a.status <> 'encerrada' then
      update public.conversas set status = 'encerrada', ia_ativa = false, atualizado_em = now(),
             motivo_encerramento = 'nova_conversa', encerramento_origem = 'paciente'
       where id = a.id;
      if a.status = 'em_atendimento' and a.agente_id is not null then
        insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
        values (a.agente_id, 'paciente_abriu_nova', a.id, jsonb_build_object('aviso', 'O paciente encerrou esta conversa para abrir uma nova.'));
      end if;
    end if;
  end if;
  v_res := public.chat_iniciar(p_nome, p_telefone, p_email, v_texto, p_aceite, p_origem, p_unidade, p_medico, p_paciente_tipo, p_paciente_nome, p_irmaos, p_irmaos_modo);
  v_nova := (v_res ->> 'conversa_id')::uuid;
  update public.conversas set
      previsao_aceita_em = case when coalesce(p_aceite_previsao, false) then now() end,
      reentrada_de = p_conversa_anterior,
      reentrada_motivo = case when v_mesmo_dia then v_motivo end,
      reentrada_motivo_auto = v_auto,
      reentrada_texto_informado = case when v_mesmo_dia and v_motivo is not null then v_texto is not null end
   where id = v_nova;
  if p_conversa_anterior is not null then
    -- a conversa nova herda a remarcação pendente da antiga (C-21)
    if exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = p_conversa_anterior) then
      begin perform public.agendamento_preparar_remarcacao(v_nova, p_conversa_anterior); exception when others then null; end;
    end if;
    begin
      update public.conversa_evento set detalhe = detalhe || jsonb_build_object('reentrada_de', p_conversa_anterior, 'motivo', case when v_mesmo_dia then v_motivo end,
             'motivo_auto', v_auto, 'texto_informado', case when v_mesmo_dia and v_motivo is not null then v_texto is not null end)
       where conversa_id = v_nova and tipo = 'criada';
    exception when others then null; end;
  end if;
  return v_res;
end $$;
revoke all on function public.chat_nova_conversa(uuid, text, text, text, text, boolean, boolean, text, text, text, text, text, jsonb, text, text, text) from public;
grant execute on function public.chat_nova_conversa(uuid, text, text, text, text, boolean, boolean, text, text, text, text, text, jsonb, text, text, text) to anon, authenticated;

-- ===== PARTE 6: motivo e origem novos =====
alter table public.conversas drop constraint if exists conversas_encerramento_origem_ck;
alter table public.conversas add constraint conversas_encerramento_origem_ck check (encerramento_origem is null or encerramento_origem in ('equipe', 'sistema', 'inatividade', 'paciente'));
alter table public.conversas drop constraint if exists conversas_motivo_encerramento_ck;
alter table public.conversas add constraint conversas_motivo_encerramento_ck check (motivo_encerramento is null or motivo_encerramento in ('agendado', 'apenas_informacoes', 'nao_respondido', 'desistiu', 'outro', 'nova_conversa'));
alter table public.conversa_encerramento drop constraint if exists conversa_encerramento_origem_check;
alter table public.conversa_encerramento add constraint conversa_encerramento_origem_check check (origem is null or origem in ('equipe', 'sistema', 'inatividade', 'paciente'));
alter table public.conversa_encerramento drop constraint if exists conversa_encerramento_motivo_check;
alter table public.conversa_encerramento add constraint conversa_encerramento_motivo_check check (motivo is null or motivo in ('agendado', 'apenas_informacoes', 'nao_respondido', 'desistiu', 'outro', 'nova_conversa'));

-- ===== PARTE 7: escrever numa conversa encerrada (janela única de reabrir_dias) =====
create or replace function public.chat_enviar(p_conversa uuid, p_token text, p_texto text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_txt text; v_id bigint; c public.conversas; v_dias integer;
begin
  v_txt := btrim(coalesce(p_texto, ''));
  if v_txt = '' or char_length(v_txt) > 4000 then raise exception 'Mensagem inválida.' using errcode = '22023'; end if;
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  select * into c from public.conversas where id = p_conversa;
  if c.status = 'encerrada' then
    v_dias := coalesce((select case when valor ~ '^[0-9]+$' then valor::int end from public.config where chave = 'reabrir_dias'), 2);
    -- o paciente abriu outra conversa: a antiga não reabre por mensagem (só a equipe reabre) — evita a aba velha ressuscitar
    if c.encerramento_origem = 'paciente' then
      raise exception 'Esta conversa foi encerrada porque você abriu uma nova. Continue pela conversa nova.' using errcode = '22023';
    end if;
    if c.encerrada_em is not null and c.encerrada_em < now() - make_interval(days => v_dias) then
      raise exception 'Esta conversa foi encerrada há mais de % dias. Abra uma nova conversa (o histórico fica salvo).', v_dias using errcode = '22023';
    end if;
  end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  update public.conversas set
    status = case when status = 'encerrada' then 'aguardando' else status end,
    agente_id = case when status = 'encerrada' then null else agente_id end
  where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_id;
  return jsonb_build_object('id', v_id, 'respostas', public.chat_respostas(p_conversa, v_id - 1));
end $$;

-- ===== PARTE 8: encerramento por inatividade =====
-- (a) exame em aberto deixa de impedir (o exame vive na Jornada); remarcação pendente continua impedindo (C-4 / C-30).
create or replace function public.autoencerrar_candidatas() returns setof uuid
language sql stable security definer set search_path to '' as $$
  select c.id from public.conversas c
   where c.status = 'em_atendimento' and c.aguarda_paciente_desde is not null
     and c.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())
     and not exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = any (public.pessoa_membros(c.id)))
     and not exists (select 1 from public.conversas m where m.id = any (public.pessoa_membros(c.id)) and m.status <> 'encerrada'
                        and not (m.status = 'em_atendimento' and m.aguarda_paciente_desde is not null
                                 and m.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())))
$$;
revoke all on function public.autoencerrar_candidatas() from public, anon, authenticated;

-- (b) a rotina avisa a atendente responsável (sino do painel); o registro fica na linha do tempo (conversa_evento 'autoencerrada').
create or replace function public.autoencerrar_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_modo text; v_id uuid; v_eleg integer := 0; v_fech integer := 0; v_desde timestamptz; v_ok uuid; v_ag uuid;
begin
  select coalesce((select valor from public.config where chave = 'autoencerrar_modo'), 'desligado') into v_modo;
  if v_modo not in ('simulacao', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('autoencerrar_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  for v_id in select * from public.autoencerrar_candidatas() loop
    v_eleg := v_eleg + 1;
    if v_modo = 'ligado' then
      select aguarda_paciente_desde, agente_id into v_desde, v_ag from public.conversas where id = v_id;
      update public.conversas set status = 'encerrada', ia_ativa = false, atualizado_em = now(),
             motivo_encerramento = 'nao_respondido', encerramento_origem = 'inatividade'
       where id = v_id and status = 'em_atendimento' and aguarda_paciente_desde is not null
         and aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())
       returning id into v_ok;
      if v_ok is not null then
        v_fech := v_fech + 1;
        insert into public.autoencerramento_fechada (conversa_id, aguarda_paciente_desde) values (v_id, v_desde) on conflict do nothing;
        insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
        values (v_ag, 'autoencerrada', v_id, jsonb_build_object('aviso', 'Conversa encerrada por falta de resposta do paciente.', 'horas', public.autoencerrar_horas()));
        v_ok := null;
      end if;
    end if;
  end loop;
  insert into public.autoencerramento_execucao (modo, elegiveis, fechadas) values (v_modo, v_eleg, v_fech);
  return jsonb_build_object('modo', v_modo, 'elegiveis', v_eleg, 'fechadas', v_fech);
end $$;
revoke all on function public.autoencerrar_vigiar() from public, anon, authenticated;
grant execute on function public.autoencerrar_vigiar() to service_role;

-- (c) texto próprio de inatividade (uma vez); os demais encerramentos seguem a despedida única de sempre.
create or replace function public.conversa_status_mudou() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_nome text; v_txt text;
begin
  if new.status is distinct from old.status then
    if new.status = 'em_atendimento' and new.agente_id is not null then
      select nome into v_nome from public.agentes where id = new.agente_id;
      insert into public.mensagens (conversa_id, autor, texto)
      values (new.id, 'sistema', coalesce(v_nome, 'Um atendente') || ' entrou na conversa.');
    elsif new.status = 'encerrada' then
      if new.encerramento_origem = 'inatividade' and coalesce((select valor from public.config where chave = 'despedida_inatividade_ativa'), 'nao') = 'sim'
         and nullif(btrim(coalesce((select valor from public.config where chave = 'despedida_inatividade_texto'), '')), '') is not null then
        select valor into v_txt from public.config where chave = 'despedida_inatividade_texto';
        insert into public.mensagens (conversa_id, autor, texto) values (new.id, 'sistema', btrim(v_txt));
      elsif new.encerramento_origem = 'paciente' then
        null;   -- o próprio paciente abriu outra conversa: não precisa de despedida
      else
        perform public.despedida_publicar(new.id, new.encerrada_em);
      end if;
      insert into public.conversa_encerramento (conversa_id, encerrada_em, motivo, origem, por)
      values (new.id, new.encerrada_em, new.motivo_encerramento, new.encerramento_origem, new.encerrada_por)
      on conflict (conversa_id, encerrada_em) do nothing;
    end if;
  end if;
  return new;
end $$;

-- ===== PARTE 9: transferência reinicia as 24 h =====
create or replace function public.conversa_transferida_reinicia_trg() returns trigger
language plpgsql set search_path to '' as $$
begin
  if old.agente_id is not null and new.agente_id is not null and new.agente_id is distinct from old.agente_id
     and new.status = 'em_atendimento' and new.aguarda_paciente_desde is not null then
    new.aguarda_paciente_desde := now();
  end if;
  return new;
end $$;
revoke all on function public.conversa_transferida_reinicia_trg() from public, anon, authenticated;
create or replace trigger conversas_zz_transferencia before update of agente_id on public.conversas for each row execute function public.conversa_transferida_reinicia_trg();
