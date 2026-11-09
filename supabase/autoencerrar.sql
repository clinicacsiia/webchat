-- FLUXOGRAMA: entrada (mensagem de uma PESSOA da equipe sem resposta do paciente; rotina agendada a cada 5 minutos) -> validação (só conta mensagem de pessoa, não do assistente; conversa em atendimento; 24 h corridas pelo relógio do servidor; sem exame em aberto nem remarcação pendente; todas as conversas abertas da mesma pessoa também vencidas; conversa sem marco confiável nunca fecha) -> lógica (modo desligado | simulacao | ligado; o fechamento é UMA instrução atômica que reconfere estado e prazo; motivo Não respondido, origem inatividade; a despedida vem do gatilho de encerramento) -> saída (conversa encerrada + registro de auditoria só com contagens e ids técnicos).
-- Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-08 da Atualização do WebChat). Decisão D3: 24 h corridas; só mensagem de pessoa conta.
-- Pré-requisitos: encerramento-motivo.sql (motivo_encerramento e origem), despedida.sql (opcional; a despedida sai do gatilho de qualquer encerramento), pessoa-unica.sql (pessoa_membros, v_agendamento_aberto, v_remarcacao_pendente). Aditivo e idempotente. Nenhum comando destrutivo.
-- LIGAR (nesta ordem): Configurações > Encerramento e avaliação > "Encerramento automático": Simulação (só conta e registra), olhar a contagem por alguns dias, depois Ligado.
-- DESLIGAR: update public.config set valor = 'desligado' where chave = 'autoencerrar_modo';  (efeito imediato)  ou  select cron.unschedule('autoencerrar-vigia');
-- CORREÇÃO AUDITADA: select * from public.autoencerramento_fechada order by fechada_em desc;  lista só as conversas fechadas pela rotina (id técnico, sem nome). Reabrir uma conversa é pelo botão Reabrir do painel, uma a uma; nunca em massa.
-- Conversas anteriores a esta atualização NÃO têm marco confiável e nunca são fechadas pela rotina.

-- ===== PARTE 1: marco, chaves e auditoria =====
alter table public.conversas add column if not exists aguarda_paciente_desde timestamptz;
comment on column public.conversas.aguarda_paciente_desde is 'Momento da última mensagem de uma PESSOA da equipe sem resposta do paciente. Nulo = não está aguardando o paciente (ou conversa antiga sem marco).';
insert into public.config (chave, valor) values ('autoencerrar_modo', 'desligado'), ('autoencerrar_horas', '24') on conflict (chave) do nothing;

create table if not exists public.autoencerramento_execucao (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(),
  modo text not null,
  elegiveis integer not null,
  fechadas integer not null
);
create table if not exists public.autoencerramento_fechada (
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  fechada_em timestamptz not null default now(),
  aguarda_paciente_desde timestamptz,
  primary key (conversa_id, fechada_em)
);
alter table public.autoencerramento_execucao enable row level security;
alter table public.autoencerramento_fechada enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'autoencerramento_execucao' and policyname = 'autoencerramento_execucao_select') then
    create policy autoencerramento_execucao_select on public.autoencerramento_execucao for select using ((select public.papel_atual()) = 'admin');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'autoencerramento_fechada' and policyname = 'autoencerramento_fechada_select') then
    create policy autoencerramento_fechada_select on public.autoencerramento_fechada for select using ((select public.papel_atual()) = 'admin');
  end if;
end $$;
grant select on public.autoencerramento_execucao, public.autoencerramento_fechada to authenticated;

-- ===== PARTE 2: o marco anda com as mensagens =====
-- Pessoa da equipe escreveu (agente_id preenchido; o assistente não tem agente_id e NÃO conta): começa ou reinicia o prazo.
-- O paciente escreveu: zera. Mensagens de sistema (despedida, "entrou na conversa") não mexem.
create or replace function public.mensagem_aguarda_paciente_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.autor = 'agente' and new.agente_id is not null then
    update public.conversas set aguarda_paciente_desde = now() where id = new.conversa_id and status = 'em_atendimento';
  elsif new.autor = 'cliente' then
    update public.conversas set aguarda_paciente_desde = null where id = new.conversa_id and aguarda_paciente_desde is not null;
  end if;
  return new;
end $$;
revoke all on function public.mensagem_aguarda_paciente_trg() from public, anon, authenticated;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'mensagem_aguarda_paciente' and tgrelid = 'public.mensagens'::regclass) then
    create trigger mensagem_aguarda_paciente after insert on public.mensagens for each row execute function public.mensagem_aguarda_paciente_trg();
  end if;
end $$;

-- Mudou de estado (assumir, reabrir, encerrar): o prazo anterior não vale mais (evita fechar logo depois de reabrir).
create or replace function public.conversa_limpa_aguarda_paciente_trg() returns trigger
language plpgsql set search_path to '' as $$
begin
  if new.status is distinct from old.status then new.aguarda_paciente_desde := null; end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'conversa_limpa_aguarda_paciente' and tgrelid = 'public.conversas'::regclass) then
    create trigger conversa_limpa_aguarda_paciente before update of status on public.conversas for each row execute function public.conversa_limpa_aguarda_paciente_trg();
  end if;
end $$;

-- ===== PARTE 3: quem está elegível =====
create or replace function public.autoencerrar_horas() returns integer
language sql stable security definer set search_path to '' as $$
  select coalesce((select case when valor ~ '^[0-9]+$' and valor::int between 1 and 720 then valor::int end from public.config where chave = 'autoencerrar_horas'), 24)
$$;
revoke all on function public.autoencerrar_horas() from public, anon, authenticated;

create or replace function public.autoencerrar_candidatas() returns setof uuid
language sql stable security definer set search_path to '' as $$
  select c.id from public.conversas c
   where c.status = 'em_atendimento' and c.aguarda_paciente_desde is not null
     and c.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())
     and not exists (select 1 from public.v_agendamento_aberto v where v.conversa_id = any (public.pessoa_membros(c.id)))
     and not exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = any (public.pessoa_membros(c.id)))
     -- pessoa unida: toda conversa ainda aberta da pessoa também precisa estar vencida (senão a pessoa ainda está sendo atendida)
     and not exists (select 1 from public.conversas m where m.id = any (public.pessoa_membros(c.id)) and m.status <> 'encerrada'
                        and not (m.status = 'em_atendimento' and m.aguarda_paciente_desde is not null
                                 and m.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())))
$$;
revoke all on function public.autoencerrar_candidatas() from public, anon, authenticated;

-- ===== PARTE 4: a rotina =====
create or replace function public.autoencerrar_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_modo text; v_id uuid; v_eleg integer := 0; v_fech integer := 0; v_desde timestamptz; v_ok uuid;
begin
  select coalesce((select valor from public.config where chave = 'autoencerrar_modo'), 'desligado') into v_modo;
  if v_modo not in ('simulacao', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  -- Trava a execução: duas rotinas ao mesmo tempo não fecham a mesma conversa duas vezes.
  if not pg_try_advisory_xact_lock(hashtext('autoencerrar_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  for v_id in select * from public.autoencerrar_candidatas() loop
    v_eleg := v_eleg + 1;
    if v_modo = 'ligado' then
      select aguarda_paciente_desde into v_desde from public.conversas where id = v_id;
      -- Fechamento atômico: reconfere estado e prazo no próprio UPDATE (resposta ou mudança de estado no meio do caminho invalida).
      update public.conversas set status = 'encerrada', ia_ativa = false, atualizado_em = now(),
             motivo_encerramento = 'nao_respondido', encerramento_origem = 'inatividade'
       where id = v_id and status = 'em_atendimento' and aguarda_paciente_desde is not null
         and aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())
       returning id into v_ok;
      if v_ok is not null then
        v_fech := v_fech + 1;
        insert into public.autoencerramento_fechada (conversa_id, aguarda_paciente_desde) values (v_id, v_desde) on conflict do nothing;
        v_ok := null;
      end if;
    end if;
  end loop;
  insert into public.autoencerramento_execucao (modo, elegiveis, fechadas) values (v_modo, v_eleg, v_fech);
  return jsonb_build_object('modo', v_modo, 'elegiveis', v_eleg, 'fechadas', v_fech);
end $$;
revoke all on function public.autoencerrar_vigiar() from public, anon, authenticated;
grant execute on function public.autoencerrar_vigiar() to service_role;

-- Resumo para o painel (administrador): quantas conversas a rotina fecharia agora e as últimas execuções.
create or replace function public.autoencerrar_resumo() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Apenas administradores.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'modo', coalesce((select valor from public.config where chave = 'autoencerrar_modo'), 'desligado'),
    'horas', public.autoencerrar_horas(),
    'elegiveis_agora', (select count(*) from public.autoencerrar_candidatas()),
    'aguardando_paciente', (select count(*) from public.conversas where status = 'em_atendimento' and aguarda_paciente_desde is not null),
    'ultimas', coalesce((select jsonb_agg(x) from (select em, modo, elegiveis, fechadas from public.autoencerramento_execucao order by id desc limit 5) x), '[]'::jsonb));
end $$;
revoke all on function public.autoencerrar_resumo() from public, anon;
grant execute on function public.autoencerrar_resumo() to authenticated;

-- ===== PARTE 5: agendamento (a cada 5 minutos; só lê a chave, então ligado em 'desligado' não faz nada) =====
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('autoencerrar-vigia', '*/5 * * * *', 'select public.autoencerrar_vigiar()');
  end if;
end $$;
