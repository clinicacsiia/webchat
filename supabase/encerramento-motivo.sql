-- FLUXOGRAMA: entrada (a equipe toca Encerrar no painel: update de conversas com status 'encerrada' e motivo_encerramento; o sistema também encerra sozinho) -> validação (gatilho conversa_antes_update: quem usa o painel precisa informar um motivo da lista, se config.encerramento_exige_motivo = 'sim'; sistema e motor não são barrados) -> lógica (grava motivo, autor e origem na conversa e uma linha em conversa_encerramento, que guarda cada fechamento) -> saída (o painel mostra o motivo; o histórico não se perde ao reabrir).
-- Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-03 da Atualização do WebChat). Decisão D1: 5 motivos.
-- Pré-requisitos: 00-base-snapshot.sql, cronometro-resposta.sql (conversa_antes_update atual), pessoa-unica.sql / aplicar-automacao.sql (conversa_encerrar_se_resolvida). Aditivo e idempotente. Nenhum comando destrutivo.
-- LIGAR: Configurações > Atualização do WebChat > "Exigir motivo ao encerrar" (config.encerramento_exige_motivo = 'sim'). Começa 'nao': o painel antigo em cache continua fechando conversas.
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'encerramento_exige_motivo';  (efeito imediato). Para voltar as funções: use as definições antigas de cronometro-resposta.sql (conversa_antes_update) e 00-base-snapshot.sql (conversa_status_mudou); as colunas e a tabela novas podem ficar.

-- ===== PARTE 1: colunas, tabela de histórico e chave =====
alter table public.conversas add column if not exists motivo_encerramento text;
alter table public.conversas add column if not exists encerrada_por uuid;
alter table public.conversas add column if not exists encerramento_origem text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversas_motivo_encerramento_ck') then
    alter table public.conversas add constraint conversas_motivo_encerramento_ck
      check (motivo_encerramento is null or motivo_encerramento in ('agendado', 'apenas_informacoes', 'nao_respondido', 'desistiu', 'outro'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'conversas_encerramento_origem_ck') then
    alter table public.conversas add constraint conversas_encerramento_origem_ck
      check (encerramento_origem is null or encerramento_origem in ('equipe', 'sistema', 'inatividade'));
  end if;
end $$;
comment on column public.conversas.motivo_encerramento is 'Motivo do último encerramento: agendado, apenas_informacoes, nao_respondido, desistiu ou outro. Nulo = sem motivo registrado (antes de 09/11/2026 ou chave desligada).';

create table if not exists public.conversa_encerramento (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  encerrada_em timestamptz not null,
  motivo text check (motivo is null or motivo in ('agendado', 'apenas_informacoes', 'nao_respondido', 'desistiu', 'outro')),
  origem text check (origem is null or origem in ('equipe', 'sistema', 'inatividade')),
  por uuid,
  unique (conversa_id, encerrada_em)
);
comment on table public.conversa_encerramento is 'Um registro por fechamento (a conversa pode ser reaberta e fechada de novo). Sem nome, telefone ou texto de conversa.';
alter table public.conversa_encerramento enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversa_encerramento' and policyname = 'conversa_encerramento_select') then
    create policy conversa_encerramento_select on public.conversa_encerramento for select
      using ((select public.papel_atual()) = any (array['admin', 'atendente']));
  end if;
end $$;
grant select on public.conversa_encerramento to authenticated;

insert into public.config (chave, valor) values ('encerramento_exige_motivo', 'nao') on conflict (chave) do nothing;

-- Fechamentos que já existem entram no histórico como "sem motivo registrado".
insert into public.conversa_encerramento (conversa_id, encerrada_em)
  select c.id, c.encerrada_em from public.conversas c where c.status = 'encerrada' and c.encerrada_em is not null
  on conflict (conversa_id, encerrada_em) do nothing;

-- ===== PARTE 2: gatilho antes do update (parte da definição atual do banco, com o bloco do motivo) =====
create or replace function public.conversa_antes_update() returns trigger
language plpgsql set search_path to '' as $$
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
  -- WC-03: motivo, autor e origem do encerramento.
  if new.status = 'encerrada' and old.status is distinct from 'encerrada' then
    if coalesce((select public.papel_atual()), '') <> '' then
      if new.motivo_encerramento is null
         and coalesce((select valor from public.config where chave = 'encerramento_exige_motivo'), 'nao') = 'sim' then
        raise exception 'MOTIVO_OBRIGATORIO: escolha o motivo do encerramento (se a lista não aparecer, atualize a página do painel).' using errcode = 'P0001';
      end if;
      new.encerrada_por := (select auth.uid());
      new.encerramento_origem := 'equipe';
    else
      new.encerramento_origem := coalesce(new.encerramento_origem, 'sistema');
    end if;
  elsif old.status = 'encerrada' and new.status is distinct from 'encerrada' then
    new.motivo_encerramento := null; new.encerrada_por := null; new.encerramento_origem := null;
  end if;
  return new;
end $$;

-- ===== PARTE 3: depois do update (mensagem de sistema como hoje + histórico do fechamento) =====
create or replace function public.conversa_status_mudou() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_nome text;
begin
  if new.status is distinct from old.status then
    if new.status = 'em_atendimento' and new.agente_id is not null then
      select nome into v_nome from public.agentes where id = new.agente_id;
      insert into public.mensagens (conversa_id, autor, texto)
      values (new.id, 'sistema', coalesce(v_nome, 'Um atendente') || ' entrou na conversa.');
    elsif new.status = 'encerrada' then
      insert into public.mensagens (conversa_id, autor, texto)
      values (new.id, 'sistema', 'Atendimento encerrado. Se precisar, é só mandar uma nova mensagem.');
      insert into public.conversa_encerramento (conversa_id, encerrada_em, motivo, origem, por)
      values (new.id, new.encerrada_em, new.motivo_encerramento, new.encerramento_origem, new.encerrada_por)
      on conflict (conversa_id, encerrada_em) do nothing;
    end if;
  end if;
  return new;
end $$;

-- ===== PARTE 4: quando o sistema encerra porque o exame foi resolvido, o motivo é Agendado =====
create or replace function public.conversa_encerrar_se_resolvida(p_conversa uuid) returns integer
language plpgsql security definer set search_path to '' as $$
declare v_mem uuid[] := public.pessoa_membros(p_conversa); v_n integer := 0; c record;
begin
  if exists (select 1 from public.v_agendamento_aberto v where v.conversa_id = any (v_mem)) then return 0; end if;
  if exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = any (v_mem)) then return 0; end if;
  for c in select id, status from public.conversas where id = any (v_mem) and status <> 'encerrada' loop
    if c.status = 'em_atendimento' then
      update public.conversas set alerta_agenda = 'Exame concluído e conferido no Klingo. Pode encerrar a conversa.' where id = c.id;
    else
      update public.conversas set status = 'encerrada', encerrada_em = now(), ia_ativa = false, alerta_agenda = null, atualizado_em = now(),
        motivo_encerramento = 'agendado', encerramento_origem = 'sistema' where id = c.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function public.conversa_encerrar_se_resolvida(uuid) from public, anon, authenticated;

-- ===== PARTE 5: resumo por motivo para a aba Indicadores (administrador e atendente; só contagens) =====
create or replace function public.encerramentos_resumo(p_dias integer default 30) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_desde timestamptz := case when coalesce(p_dias, 30) <= 0 then '-infinity'::timestamptz else now() - make_interval(days => least(p_dias, 3650)) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return jsonb_build_object('dias', coalesce(p_dias, 30),
    'total', (select count(*) from public.conversa_encerramento where encerrada_em >= v_desde),
    'automaticos', (select count(*) from public.conversa_encerramento where encerrada_em >= v_desde and origem = 'inatividade'),
    'por_motivo', coalesce((select jsonb_object_agg(m, n) from (select coalesce(motivo, 'sem_motivo') m, count(*) n from public.conversa_encerramento where encerrada_em >= v_desde group by 1) x), '{}'::jsonb));
end $$;
revoke all on function public.encerramentos_resumo(integer) from public, anon;
grant execute on function public.encerramentos_resumo(integer) to authenticated;
