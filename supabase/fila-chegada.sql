-- FLUXOGRAMA: entrada (paciente logado toca "Cheguei", ou a recepção registra a chegada; equipe chama e conclui) -> validação (login do paciente em contas_paciente, papel da equipe, uma fila aberta por pessoa, só vale o dia de hoje) -> lógica (posição = quantos aguardando chegaram antes; gatilho gera avisos "chegou", "perto" e "sua vez" uma única vez cada, numa caixa de saída) -> saída (fila_chegada, fila_aviso, broadcast público sem dado pessoal, pg_net chama a Edge Function fila-avisar que envia o Web Push)
-- Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
-- Módulo: fila de chegada na clínica + avisos no celular do paciente (portal /minha-vez/).
-- Independente do módulo de assinatura biométrica (fila-biometria*.sql): usa tabelas próprias (fila_chegada, fila_aviso, push_inscricao).
-- Pré-requisitos: 00-base-snapshot.sql (papel_atual, config), contas-paciente.sql (contas_paciente), pacientes.sql. Extensão pg_net só para o envio do push (opcional: sem ela o aviso na tela continua).
-- Aditivo e idempotente. Nenhum comando destrutivo. Nenhum segredo neste arquivo: o segredo do envio vai no Vault (nome fila_aviso_segredo).
--
-- ROLLBACK: drop table public.fila_aviso, public.push_inscricao, public.fila_chegada cascade; e remover as funções fila_* abaixo; delete from public.config where chave like 'fila\_%' escape '\' (só as 4 chaves criadas aqui).

-- ============================================================
-- 1) Configuração
-- ============================================================
insert into public.config (chave, valor) values
  ('fila_aviso_antes', '2'),            -- avisa "está perto" quando restam N pessoas à frente
  ('fila_autochegada', 'sim'),          -- 'sim' = o paciente pode tocar "Cheguei"; 'nao' = só a recepção registra
  ('fila_push_url', ''),                -- URL da Edge Function fila-avisar (vazio = sem push com o site fechado)
  ('fila_vapid_publica', '')            -- chave pública VAPID (a privada fica só nos segredos da Edge Function)
on conflict (chave) do nothing;

-- Dia da clínica em Brasília: a fila zera todo dia.
create or replace function public.fila_dia(p timestamptz) returns date language sql immutable set search_path to '' as $$
  select (p at time zone 'America/Sao_Paulo')::date
$$;

-- ============================================================
-- 2) Tabelas
-- ============================================================
create table if not exists public.fila_chegada (
  id uuid primary key default gen_random_uuid(),
  conta_id uuid references auth.users(id) on delete set null,
  paciente_id uuid references public.pacientes(id) on delete set null,
  nome text not null check (char_length(btrim(nome)) between 1 and 120),
  senha integer not null,                                   -- número do dia (1, 2, 3...)
  status text not null default 'aguardando' check (status in ('aguardando', 'chamado', 'atendido', 'cancelado')),
  origem text not null default 'paciente' check (origem in ('paciente', 'recepcao')),
  chegou_em timestamptz not null default now(),
  chamado_em timestamptz,
  concluido_em timestamptz
);
comment on table public.fila_chegada is 'Fila de chegada na clínica (uma linha por visita). Escrita só pelas funções fila_*. O paciente nunca lê a tabela: vê só a própria posição por fila_minha_vez(). A equipe (admin/atendente) lê.';
create index if not exists fila_chegada_aberta_idx on public.fila_chegada (chegou_em, id) where status = 'aguardando';
create unique index if not exists fila_chegada_uma_aberta_por_conta on public.fila_chegada (conta_id) where status in ('aguardando', 'chamado') and conta_id is not null;

create table if not exists public.fila_aviso (
  id bigint generated always as identity primary key,
  fila_id uuid not null references public.fila_chegada(id) on delete cascade,
  conta_id uuid references auth.users(id) on delete cascade,
  tipo text not null check (tipo in ('chegada', 'perto', 'vez')),
  titulo text not null,
  corpo text not null,
  criado_em timestamptz not null default now(),
  enviado_em timestamptz,
  unique (fila_id, tipo)                                      -- cada aviso sai uma vez só
);
comment on table public.fila_aviso is 'Caixa de saída dos avisos. A Edge Function fila-avisar envia os que têm enviado_em nulo. Sem acesso do navegador.';

create table if not exists public.push_inscricao (
  id bigint generated always as identity primary key,
  conta_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) <= 1000),
  p256dh text not null,
  auth text not null,
  criado_em timestamptz not null default now()
);
comment on table public.push_inscricao is 'Aparelhos que aceitaram notificação (Web Push). Só as funções fila_push_* e a Edge Function (service_role) acessam.';

alter table public.fila_chegada enable row level security;
alter table public.fila_aviso enable row level security;
alter table public.push_inscricao enable row level security;
revoke all on public.fila_chegada, public.fila_aviso, public.push_inscricao from anon, authenticated;
grant select on public.fila_chegada to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fila_chegada' and policyname = 'fila_chegada_equipe') then
    create policy fila_chegada_equipe on public.fila_chegada for select to authenticated
      using ((select public.papel_atual()) = any (array['admin', 'atendente']));
  end if;
end $$;

-- ============================================================
-- 3) Avisos: gatilho gera "chegou", "perto" e "sua vez"
-- ============================================================
create or replace function public.fila_aviso_segredo() returns text language plpgsql stable security definer set search_path to '' as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'fila_aviso_segredo' limit 1;
  return v;
exception when others then return null;   -- sem Vault (ou sem o segredo): sem push, a tela continua funcionando
end $$;
revoke all on function public.fila_aviso_segredo() from public, anon, authenticated;

create or replace function public.fila_posicao(p_id uuid) returns integer language sql stable security definer set search_path to '' as $$
  select 1 + count(*)::int from public.fila_chegada o, public.fila_chegada m
   where m.id = p_id and o.status = 'aguardando' and public.fila_dia(o.chegou_em) = public.fila_dia(m.chegou_em)
     and (o.chegou_em, o.id) < (m.chegou_em, m.id)
$$;
revoke all on function public.fila_posicao(uuid) from public, anon, authenticated;

create or replace function public.fila_recalcular() returns void language plpgsql security definer set search_path to '' as $$
declare r record; v_antes int; v_url text; v_seg text; v_novo boolean := false; v_n int;
begin
  select coalesce(nullif(valor, '')::int, 2) into v_antes from public.config where chave = 'fila_aviso_antes';
  v_antes := greatest(coalesce(v_antes, 2), 1);

  -- Quem foi chamado: é a vez.
  for r in select id, conta_id from public.fila_chegada where status = 'chamado' and public.fila_dia(chegou_em) = public.fila_dia(now()) loop
    insert into public.fila_aviso (fila_id, conta_id, tipo, titulo, corpo)
    values (r.id, r.conta_id, 'vez', 'É a sua vez!', 'Pode se dirigir ao atendimento. A equipe está esperando você.')
    on conflict (fila_id, tipo) do nothing;
    get diagnostics v_n = row_count; v_novo := v_novo or v_n > 0;
  end loop;

  -- Quem aguarda: confirma a chegada e avisa quando restam poucos à frente.
  for r in select id, conta_id, public.fila_posicao(id) as pos from public.fila_chegada
            where status = 'aguardando' and public.fila_dia(chegou_em) = public.fila_dia(now()) loop
    insert into public.fila_aviso (fila_id, conta_id, tipo, titulo, corpo)
    values (r.id, r.conta_id, 'chegada', 'Sua chegada foi avisada', 'Você está na posição ' || r.pos || ' da fila. Vamos avisar quando estiver perto.')
    on conflict (fila_id, tipo) do nothing;
    get diagnostics v_n = row_count; v_novo := v_novo or v_n > 0;
    if r.pos - 1 <= v_antes and r.pos > 1 then
      insert into public.fila_aviso (fila_id, conta_id, tipo, titulo, corpo)
      values (r.id, r.conta_id, 'perto', 'Está perto da sua vez', case when r.pos - 1 = 1 then 'Falta 1 pessoa à sua frente.' else 'Faltam ' || (r.pos - 1) || ' pessoas à sua frente.' end || ' Fique por perto.')
      on conflict (fila_id, tipo) do nothing;
      get diagnostics v_n = row_count; v_novo := v_novo or v_n > 0;
    end if;
  end loop;

  -- Atualiza as telas abertas (sem dado pessoal: só "mudou", cada tela pergunta a própria posição).
  perform realtime.send(jsonb_build_object('evento', 'fila_mudou'), 'fila_mudou', 'fila-chegada', false);

  if v_novo then
    select valor into v_url from public.config where chave = 'fila_push_url';
    v_seg := public.fila_aviso_segredo();
    if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
      begin
        perform net.http_post(url := v_url, body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
      exception when others then null;   -- falha de rede não derruba a fila; a tela segue avisando
      end;
    end if;
  end if;
end $$;
revoke all on function public.fila_recalcular() from public, anon, authenticated;

create or replace function public.fila_chegada_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  perform public.fila_recalcular();
  return null;
end $$;
revoke all on function public.fila_chegada_trg() from public, anon, authenticated;
drop trigger if exists fila_chegada_aviso on public.fila_chegada;
create trigger fila_chegada_aviso after insert or update of status on public.fila_chegada
  for each statement execute function public.fila_chegada_trg();

-- ============================================================
-- 4) Paciente: Cheguei, minha vez, aparelhos
-- ============================================================
create or replace function public.fila_minha_vez() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := (select auth.uid()); r public.fila_chegada%rowtype; v_total int;
begin
  if v_uid is null then raise exception 'Entre na sua conta para ver a fila.' using errcode = '28000'; end if;
  select * into r from public.fila_chegada where conta_id = v_uid and status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) = public.fila_dia(now())
   order by chegou_em desc limit 1;
  select count(*)::int into v_total from public.fila_chegada where status = 'aguardando' and public.fila_dia(chegou_em) = public.fila_dia(now());
  if r.id is null then   -- (FOUND não serve aqui: o count acima o redefine)
    -- Atendido há pouco? Mostra o encerramento em vez de "fora da fila".
    if exists (select 1 from public.fila_chegada where conta_id = v_uid and status = 'atendido' and concluido_em > now() - interval '3 hours') then
      return jsonb_build_object('situacao', 'atendido', 'total', v_total);
    end if;
    return jsonb_build_object('situacao', 'fora', 'total', v_total,
      'pode_chegar', coalesce((select valor from public.config where chave = 'fila_autochegada'), 'sim') = 'sim');
  end if;
  if r.status = 'chamado' then
    return jsonb_build_object('situacao', 'chamado', 'senha', r.senha, 'total', v_total);
  end if;
  return jsonb_build_object('situacao', 'aguardando', 'senha', r.senha, 'posicao', public.fila_posicao(r.id), 'a_frente', public.fila_posicao(r.id) - 1, 'total', v_total);
end $$;

create or replace function public.fila_cheguei() returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := (select auth.uid()); c public.contas_paciente%rowtype; v_nome text; v_senha int;
begin
  if v_uid is null then raise exception 'Entre na sua conta para avisar que chegou.' using errcode = '28000'; end if;
  if coalesce((select valor from public.config where chave = 'fila_autochegada'), 'sim') <> 'sim' then
    raise exception 'Avise a recepção que você chegou.' using errcode = 'P0001';
  end if;
  select * into c from public.contas_paciente where id = v_uid;
  if not found then raise exception 'Só pacientes com conta podem avisar a chegada.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  -- Fila aberta de outro dia não vale mais.
  update public.fila_chegada set status = 'cancelado', concluido_em = now() where conta_id = v_uid and status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) < public.fila_dia(now());
  if not exists (select 1 from public.fila_chegada where conta_id = v_uid and status in ('aguardando', 'chamado')) then
    select nome into v_nome from public.pacientes where id = c.paciente_id;
    v_nome := coalesce(nullif(btrim(v_nome), ''), nullif(btrim(coalesce((select raw_user_meta_data ->> 'nome' from auth.users where id = v_uid), '')), ''), split_part(coalesce(c.email, 'Paciente'), '@', 1));
    select coalesce(max(senha), 0) + 1 into v_senha from public.fila_chegada where public.fila_dia(chegou_em) = public.fila_dia(now());
    insert into public.fila_chegada (conta_id, paciente_id, nome, senha, origem) values (v_uid, c.paciente_id, left(v_nome, 120), v_senha, 'paciente');
  end if;
  return public.fila_minha_vez();
end $$;

create or replace function public.fila_push_salvar(p_endpoint text, p_p256dh text, p_auth text) returns void language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'Entre na sua conta.' using errcode = '28000'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Inscrição de notificação inválida.' using errcode = '22023';
  end if;
  insert into public.push_inscricao (conta_id, endpoint, p256dh, auth) values (v_uid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set conta_id = excluded.conta_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.fila_push_remover(p_endpoint text) returns void language sql security definer set search_path to '' as $$
  delete from public.push_inscricao where endpoint = p_endpoint and conta_id = (select auth.uid())
$$;

create or replace function public.fila_config_publica() returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('vapid', coalesce((select valor from public.config where chave = 'fila_vapid_publica'), ''))
$$;

-- ============================================================
-- 5) Equipe: registrar chegada, chamar, concluir, cancelar
-- ============================================================
create or replace function public.fila_equipe_ok() returns void language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Só a equipe de atendimento pode mexer na fila.' using errcode = '42501';
  end if;
end $$;
revoke all on function public.fila_equipe_ok() from public, anon, authenticated;

-- Recepção registra quem chegou (com ou sem conta: sem conta não recebe aviso no celular, mas entra na fila).
create or replace function public.fila_registrar_chegada(p_nome text, p_conta uuid default null) returns uuid language plpgsql security definer set search_path to '' as $$
declare v_senha int; v_id uuid; v_pac uuid; v_nome text := left(btrim(coalesce(p_nome, '')), 120);
begin
  perform public.fila_equipe_ok();
  if p_conta is not null then
    select paciente_id into v_pac from public.contas_paciente where id = p_conta;
    if not found then raise exception 'Conta de paciente não encontrada.' using errcode = 'P0002'; end if;
    if v_nome = '' then v_nome := coalesce((select nome from public.pacientes where id = v_pac), (select split_part(email, '@', 1) from public.contas_paciente where id = p_conta), ''); end if;
    if exists (select 1 from public.fila_chegada where conta_id = p_conta and status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) = public.fila_dia(now())) then
      raise exception 'Essa pessoa já está na fila.' using errcode = 'P0001';
    end if;
  end if;
  if v_nome = '' then raise exception 'Informe o nome de quem chegou.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  select coalesce(max(senha), 0) + 1 into v_senha from public.fila_chegada where public.fila_dia(chegou_em) = public.fila_dia(now());
  insert into public.fila_chegada (conta_id, paciente_id, nome, senha, origem) values (p_conta, v_pac, v_nome, v_senha, 'recepcao') returning id into v_id;
  return v_id;
end $$;

create or replace function public.fila_chamar_proximo() returns uuid language plpgsql security definer set search_path to '' as $$
declare v_id uuid;
begin
  perform public.fila_equipe_ok();
  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  select id into v_id from public.fila_chegada where status = 'aguardando' and public.fila_dia(chegou_em) = public.fila_dia(now())
   order by chegou_em, id limit 1 for update skip locked;
  if v_id is null then return null; end if;
  update public.fila_chegada set status = 'chamado', chamado_em = now() where id = v_id;
  return v_id;
end $$;

create or replace function public.fila_mudar(p_id uuid, p_para text) returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.fila_equipe_ok();
  if p_para not in ('atendido', 'cancelado', 'chamado') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  update public.fila_chegada set status = p_para,
         chamado_em = case when p_para = 'chamado' then now() else chamado_em end,
         concluido_em = case when p_para in ('atendido', 'cancelado') then now() else concluido_em end
   where id = p_id and status in ('aguardando', 'chamado');
  if not found then raise exception 'Essa pessoa não está mais na fila.' using errcode = 'P0002'; end if;
end $$;

-- ============================================================
-- 6) Permissões e tempo real
-- ============================================================
revoke all on function public.fila_minha_vez(), public.fila_cheguei(), public.fila_push_salvar(text, text, text), public.fila_push_remover(text),
  public.fila_config_publica(), public.fila_registrar_chegada(text, uuid), public.fila_chamar_proximo(), public.fila_mudar(uuid, text) from public, anon;
grant execute on function public.fila_minha_vez(), public.fila_cheguei(), public.fila_push_salvar(text, text, text), public.fila_push_remover(text),
  public.fila_config_publica(), public.fila_registrar_chegada(text, uuid), public.fila_chamar_proximo(), public.fila_mudar(uuid, text) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fila_chegada') then
    alter publication supabase_realtime add table public.fila_chegada;
  end if;
end $$;
