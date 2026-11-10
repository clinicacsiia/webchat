-- FLUXOGRAMA: entrada (quem lê conversas/mensagens pela API ou pelo painel; quem edita a estrutura de equipes) -> validação (pode_ver_conversa: TI/administrador e marketing veem como hoje; gerência vê tudo; supervisão e atendentes veem a unidade da equipe, a triagem do Call Center e as conversas que são delas; ninguém concede mais do que tem) -> lógica (config.permissao_modo: desligado = nada muda; OBSERVACAO = nada é bloqueado, e permissao_simular() mostra o que seria bloqueado por pessoa; ligado = a regra vale no banco) -> saída (org_equipe, org_membro, org_alteracao_log imutável, permissao_observacao, RLS de conversas e mensagens ligada à regra, funções org_* e permissao_*)
-- Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial da Etapa B (PERF-01/02/04; Q-11, Q-12, Q-13, Q-14). ATENÇÃO: a estrutura usa nomes provisórios ("Atendente 1..4"); as contas reais são ligadas depois com org_membro_vincular. NENHUMA conta foi criada e NENHUM papel foi alterado (a Carla Adrielle continua administradora até o dono autorizar).
-- Pré-requisitos: papel_atual(), agentes, conversas, mensagens, unidade_config. Aditivo (create if not exists / create or replace / alter policy). O PAPEL (admin/atendente/marketing) continua igual: o escopo fica nas tabelas novas (C-16).
-- DESLIGAR: update public.config set valor = 'desligado' where chave = 'permissao_modo';   (efeito imediato; 'observacao' = padrão, 'ligado' = bloqueia de verdade)
-- ROLLBACK: alter policy conversas_select on public.conversas using ((select public.papel_atual()) is not null);
--           alter policy mensagens_select on public.mensagens using ((select public.papel_atual()) = any (array['admin', 'atendente']));
--           (as tabelas e funções novas podem ficar)

insert into public.config (chave, valor) values ('permissao_modo', 'observacao') on conflict (chave) do nothing;

-- ===== PARTE 1: tabelas =====
create table if not exists public.org_equipe (
  id bigint generated always as identity primary key,
  nome text not null unique,
  unidade text,                       -- chave de unidade_config; nulo = a definir (ou transversal)
  transversal boolean not null default false,   -- atende todas as unidades (Call Center) e faz a triagem de conversa sem unidade
  ativa boolean not null default true,
  criado_em timestamptz not null default now()
);
create table if not exists public.org_membro (
  id bigint generated always as identity primary key,
  equipe_id bigint references public.org_equipe (id) on delete cascade,   -- nulo = função global (TI, gerência)
  agente_id uuid references public.agentes (id) on delete set null,       -- nulo = nome provisório ainda sem conta
  rotulo text,                                                            -- "Atendente 1": usado enquanto não há conta
  funcao text not null check (funcao in ('ti', 'gerente', 'supervisor', 'atendente')),
  ativo boolean not null default true,
  inicio date not null default current_date,
  fim date,
  check (agente_id is not null or rotulo is not null)
);
create unique index if not exists org_membro_conta_uq on public.org_membro (coalesce(equipe_id, 0), agente_id) where agente_id is not null and fim is null;
create unique index if not exists org_membro_rotulo_uq on public.org_membro (coalesce(equipe_id, 0), rotulo) where agente_id is null;
create index if not exists org_membro_agente_idx on public.org_membro (agente_id) where agente_id is not null;
create table if not exists public.org_alteracao_log (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(),
  por uuid,
  acao text not null,
  alvo text,
  antes jsonb,
  depois jsonb
);
create table if not exists public.permissao_observacao (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(),
  agente_id uuid,
  acao text not null,
  conversa_id uuid,
  unidade text,
  detalhe jsonb not null default '{}'::jsonb
);
alter table public.conversas add column if not exists unidade_responsavel text;
comment on column public.conversas.unidade_responsavel is 'Unidade que responde pela conversa agora (muda por transferência para unidade). Nulo = vale unidade_inicial (o que o paciente escolheu).';
alter table public.org_equipe enable row level security;
alter table public.org_membro enable row level security;
alter table public.org_alteracao_log enable row level security;
alter table public.permissao_observacao enable row level security;
-- leitura só pelas funções org_* (security definer); ninguém lê as tabelas direto, exceto o administrador
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'org_equipe' and policyname = 'org_equipe_select') then create policy org_equipe_select on public.org_equipe for select using ((select public.papel_atual()) = 'admin'); end if;
  if not exists (select 1 from pg_policies where tablename = 'org_membro' and policyname = 'org_membro_select') then create policy org_membro_select on public.org_membro for select using ((select public.papel_atual()) = 'admin'); end if;
  if not exists (select 1 from pg_policies where tablename = 'org_alteracao_log' and policyname = 'org_alteracao_log_select') then create policy org_alteracao_log_select on public.org_alteracao_log for select using ((select public.papel_atual()) = 'admin'); end if;
  if not exists (select 1 from pg_policies where tablename = 'permissao_observacao' and policyname = 'permissao_observacao_select') then create policy permissao_observacao_select on public.permissao_observacao for select using ((select public.papel_atual()) = 'admin'); end if;
end $$;
grant select on public.org_equipe, public.org_membro, public.org_alteracao_log, public.permissao_observacao to authenticated;

-- o log não se altera nem se apaga
create or replace function public.org_log_imutavel_trg() returns trigger language plpgsql set search_path to '' as $$
begin raise exception 'O registro de alterações não pode ser alterado nem apagado.' using errcode = '42501'; end $$;
create or replace trigger org_alteracao_log_imutavel before update or delete on public.org_alteracao_log for each row execute function public.org_log_imutavel_trg();

-- ===== PARTE 2: quem é quem =====
-- Nível de uma pessoa: admin (papel) = ti; senão a maior função ativa em org_membro.
create or replace function public.org_nivel_de(p_agente uuid, p_papel text) returns text
language sql stable security definer set search_path to '' as $$
  select case
    when p_papel = 'admin' then 'ti'
    else (select m.funcao from public.org_membro m
           where m.agente_id = p_agente and m.ativo and (m.fim is null or m.fim >= current_date)
           order by array_position(array['ti', 'gerente', 'supervisor', 'atendente'], m.funcao) limit 1)
  end
$$;
revoke all on function public.org_nivel_de(uuid, text) from public, anon, authenticated;

create or replace function public.org_nivel() returns text
language sql stable security definer set search_path to '' as $$
  select public.org_nivel_de((select auth.uid()), (select public.papel_atual()))
$$;
revoke all on function public.org_nivel() from public, anon;
grant execute on function public.org_nivel() to authenticated;

-- A regra de ver uma conversa, para uma pessoa qualquer (usada pela RLS e pela simulação).
create or replace function public.org_pode_ver(p_agente uuid, p_papel text, p_dono uuid, p_unidade text) returns boolean
language plpgsql stable security definer set search_path to '' as $$
declare v_nivel text;
begin
  if p_agente is null or p_papel is null then return false; end if;
  if p_papel in ('admin', 'marketing') then return true; end if;     -- TI/administrador e marketing: como hoje (Q-13)
  if p_dono = p_agente then return true; end if;                     -- a conversa que é minha
  v_nivel := public.org_nivel_de(p_agente, p_papel);
  if v_nivel in ('ti', 'gerente') then return true; end if;
  return exists (
    select 1 from public.org_membro m join public.org_equipe e on e.id = m.equipe_id
     where m.agente_id = p_agente and m.ativo and (m.fim is null or m.fim >= current_date) and e.ativa
       and (e.transversal                                      -- Call Center: todas as unidades + triagem
            or (p_unidade is not null and e.unidade = p_unidade)));
end $$;
revoke all on function public.org_pode_ver(uuid, text, uuid, text) from public, anon, authenticated;

create or replace function public.permissao_restringe() returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce((select valor = 'ligado' from public.config where chave = 'permissao_modo'), false)
$$;
revoke all on function public.permissao_restringe() from public, anon;
grant execute on function public.permissao_restringe() to authenticated;

create or replace function public.pode_ver_conversa(p_conversa uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select public.org_pode_ver((select auth.uid()), (select public.papel_atual()), c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial))
    from public.conversas c where c.id = p_conversa
$$;
revoke all on function public.pode_ver_conversa(uuid) from public, anon;
grant execute on function public.pode_ver_conversa(uuid) to authenticated;

-- ===== PARTE 3: a regra no banco (só aperta quando permissao_modo = 'ligado') =====
do $$ begin
  if exists (select 1 from pg_policies where tablename = 'conversas' and policyname = 'conversas_select') then
    alter policy conversas_select on public.conversas using ((select public.papel_atual()) is not null and (not (select public.permissao_restringe()) or public.pode_ver_conversa(id)));
  end if;
  if exists (select 1 from pg_policies where tablename = 'mensagens' and policyname = 'mensagens_select') then
    alter policy mensagens_select on public.mensagens using ((select public.papel_atual()) = any (array['admin', 'atendente']) and (not (select public.permissao_restringe()) or public.pode_ver_conversa(conversa_id)));
  end if;
end $$;

-- ===== PARTE 4: simulação (modo observação): o que cada pessoa deixaria de ver se o modo fosse "ligado" =====
create or replace function public.permissao_simular() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Apenas administradores.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'modo', coalesce((select valor from public.config where chave = 'permissao_modo'), 'desligado'),
    'sem_unidade_abertas', (select count(*) from public.conversas where not teste and status <> 'encerrada' and coalesce(unidade_responsavel, unidade_inicial) is null),
    'pessoas', coalesce((select jsonb_agg(x order by x.nome) from (
      select a.id, a.nome, a.papel, public.org_nivel_de(a.id, a.papel) as nivel,
             count(c.id) filter (where c.status <> 'encerrada') as abertas,
             count(c.id) filter (where c.status <> 'encerrada' and public.org_pode_ver(a.id, a.papel, c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial))) as abertas_visiveis,
             count(c.id) as total,
             count(c.id) filter (where public.org_pode_ver(a.id, a.papel, c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial))) as total_visiveis
        from public.agentes a cross join public.conversas c where a.ativo and not c.teste group by a.id, a.nome, a.papel) x), '[]'::jsonb));
end $$;
revoke all on function public.permissao_simular() from public, anon;
grant execute on function public.permissao_simular() to authenticated;

-- ===== PARTE 5: leitura e edição da estrutura =====
create or replace function public.org_estrutura() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_nivel text := public.org_nivel(); v_uid uuid := (select auth.uid());
begin
  if v_nivel is null or v_nivel = 'atendente' then raise exception 'Sem permissão para ver a estrutura.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'nivel', v_nivel,
    'modo', coalesce((select valor from public.config where chave = 'permissao_modo'), 'desligado'),
    'unidades', coalesce((select jsonb_agg(jsonb_build_object('chave', u.chave, 'rotulo', u.rotulo) order by u.ordem) from public.unidade_config u where u.ativo), '[]'::jsonb),
    'agentes', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome, 'papel', a.papel) order by a.nome) from public.agentes a where a.ativo), '[]'::jsonb),
    'globais', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'funcao', m.funcao, 'agente_id', m.agente_id, 'agente', a.nome, 'rotulo', m.rotulo) order by m.funcao, a.nome)
                          from public.org_membro m left join public.agentes a on a.id = m.agente_id where m.equipe_id is null and m.ativo), '[]'::jsonb),
    'equipes', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'unidade', e.unidade, 'transversal', e.transversal, 'ativa', e.ativa,
        'membros', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'funcao', m.funcao, 'agente_id', m.agente_id, 'agente', a.nome, 'rotulo', m.rotulo, 'ativo', m.ativo)
                                    order by array_position(array['supervisor', 'atendente'], m.funcao), m.id)
                               from public.org_membro m left join public.agentes a on a.id = m.agente_id where m.equipe_id = e.id), '[]'::jsonb)) order by e.nome)
      from public.org_equipe e
     where v_nivel in ('ti', 'gerente') or exists (select 1 from public.org_membro s where s.equipe_id = e.id and s.agente_id = v_uid and s.funcao = 'supervisor' and s.ativo)), '[]'::jsonb));
end $$;
revoke all on function public.org_estrutura() from public, anon;
grant execute on function public.org_estrutura() to authenticated;

create or replace function public.org_equipe_salvar(p_id bigint, p_nome text, p_unidade text default null, p_transversal boolean default false, p_ativa boolean default true) returns bigint
language plpgsql security definer set search_path to '' as $$
declare v_id bigint; v_antes jsonb;
begin
  if public.org_nivel() not in ('ti', 'gerente') then raise exception 'Somente TI e gerência alteram equipes.' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_nome, ''))) < 2 then raise exception 'Informe o nome da equipe.' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_unidade, '')), '') is not null and not exists (select 1 from public.unidade_config where chave = btrim(p_unidade)) then raise exception 'Unidade inválida.' using errcode = '22023'; end if;
  if p_id is null then
    insert into public.org_equipe (nome, unidade, transversal, ativa) values (btrim(p_nome), nullif(btrim(coalesce(p_unidade, '')), ''), coalesce(p_transversal, false), coalesce(p_ativa, true)) returning id into v_id;
    insert into public.org_alteracao_log (por, acao, alvo, depois) values ((select auth.uid()), 'equipe_criada', 'equipe:' || v_id, jsonb_build_object('nome', btrim(p_nome), 'unidade', p_unidade));
  else
    select to_jsonb(e) into v_antes from public.org_equipe e where e.id = p_id;
    update public.org_equipe set nome = btrim(p_nome), unidade = nullif(btrim(coalesce(p_unidade, '')), ''), transversal = coalesce(p_transversal, false), ativa = coalesce(p_ativa, true) where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Equipe não encontrada.' using errcode = '22023'; end if;
    insert into public.org_alteracao_log (por, acao, alvo, antes, depois) values ((select auth.uid()), 'equipe_alterada', 'equipe:' || v_id, v_antes, (select to_jsonb(e) from public.org_equipe e where e.id = v_id));
  end if;
  return v_id;
end $$;
revoke all on function public.org_equipe_salvar(bigint, text, text, boolean, boolean) from public, anon;
grant execute on function public.org_equipe_salvar(bigint, text, text, boolean, boolean) to authenticated;

-- Ninguém concede mais do que tem: TI cria qualquer função; gerência cria supervisor/atendente; supervisão só cria atendente na PRÓPRIA equipe.
create or replace function public.org_membro_salvar(p_id bigint, p_equipe bigint, p_agente uuid, p_rotulo text, p_funcao text, p_ativo boolean default true) returns bigint
language plpgsql security definer set search_path to '' as $$
declare v_nivel text := public.org_nivel(); v_uid uuid := (select auth.uid()); v_id bigint; v_antes jsonb; v_rot text := nullif(btrim(coalesce(p_rotulo, '')), '');
begin
  if v_nivel is null or v_nivel = 'atendente' then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_funcao not in ('ti', 'gerente', 'supervisor', 'atendente') then raise exception 'Função inválida.' using errcode = '22023'; end if;
  if p_agente is null and v_rot is null then raise exception 'Informe a conta ou um nome provisório.' using errcode = '22023'; end if;
  if p_funcao in ('ti', 'gerente') and p_equipe is not null then raise exception 'TI e gerência são funções gerais, sem equipe.' using errcode = '22023'; end if;
  if p_funcao in ('supervisor', 'atendente') and p_equipe is null then raise exception 'Escolha a equipe.' using errcode = '22023'; end if;
  if p_funcao = 'ti' and v_nivel <> 'ti' then raise exception 'Somente a TI concede a função de TI.' using errcode = '42501'; end if;
  if p_funcao in ('gerente', 'supervisor') and v_nivel not in ('ti', 'gerente') then raise exception 'Somente TI e gerência concedem essa função.' using errcode = '42501'; end if;
  if v_nivel = 'supervisor' and not exists (select 1 from public.org_membro s where s.equipe_id = p_equipe and s.agente_id = v_uid and s.funcao = 'supervisor' and s.ativo) then
    raise exception 'A supervisão só mexe na própria equipe.' using errcode = '42501';
  end if;
  if p_id is null then
    insert into public.org_membro (equipe_id, agente_id, rotulo, funcao, ativo) values (p_equipe, p_agente, v_rot, p_funcao, coalesce(p_ativo, true)) returning id into v_id;
    insert into public.org_alteracao_log (por, acao, alvo, depois) values (v_uid, 'membro_criado', 'membro:' || v_id, jsonb_build_object('equipe', p_equipe, 'agente', p_agente, 'rotulo', v_rot, 'funcao', p_funcao));
  else
    select to_jsonb(m) into v_antes from public.org_membro m where m.id = p_id;
    if v_antes is null then raise exception 'Membro não encontrado.' using errcode = '22023'; end if;
    if (v_antes ->> 'funcao') = 'ti' and v_nivel <> 'ti' or (v_antes ->> 'funcao') in ('gerente', 'supervisor') and v_nivel not in ('ti', 'gerente') then raise exception 'Sem permissão para alterar essa função.' using errcode = '42501'; end if;
    update public.org_membro set equipe_id = p_equipe, agente_id = p_agente, rotulo = v_rot, funcao = p_funcao, ativo = coalesce(p_ativo, true), fim = case when coalesce(p_ativo, true) then null else coalesce(fim, current_date) end where id = p_id returning id into v_id;
    insert into public.org_alteracao_log (por, acao, alvo, antes, depois) values (v_uid, 'membro_alterado', 'membro:' || v_id, v_antes, (select to_jsonb(m) from public.org_membro m where m.id = v_id));
  end if;
  return v_id;
end $$;
revoke all on function public.org_membro_salvar(bigint, bigint, uuid, text, text, boolean) from public, anon;
grant execute on function public.org_membro_salvar(bigint, bigint, uuid, text, text, boolean) to authenticated;

-- Liga um nome provisório ("Atendente 1") a uma conta real, sem mudar a função.
create or replace function public.org_membro_vincular(p_membro bigint, p_agente uuid) returns boolean
language plpgsql security definer set search_path to '' as $$
declare m public.org_membro;
begin
  select * into m from public.org_membro where id = p_membro;
  if not found then raise exception 'Membro não encontrado.' using errcode = '22023'; end if;
  perform public.org_membro_salvar(m.id, m.equipe_id, p_agente, case when p_agente is null then m.rotulo end, m.funcao, m.ativo);
  return true;
end $$;
revoke all on function public.org_membro_vincular(bigint, uuid) from public, anon;
grant execute on function public.org_membro_vincular(bigint, uuid) to authenticated;

create or replace function public.permissao_modo_definir(p_modo text) returns text
language plpgsql security definer set search_path to '' as $$
declare v_antes text;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Apenas administradores.' using errcode = '42501'; end if;
  if p_modo not in ('desligado', 'observacao', 'ligado') then raise exception 'Modo inválido.' using errcode = '22023'; end if;
  select valor into v_antes from public.config where chave = 'permissao_modo';
  update public.config set valor = p_modo where chave = 'permissao_modo';
  insert into public.org_alteracao_log (por, acao, alvo, antes, depois) values ((select auth.uid()), 'permissao_modo', 'config', to_jsonb(v_antes), to_jsonb(p_modo));
  return p_modo;
end $$;
revoke all on function public.permissao_modo_definir(text) from public, anon;
grant execute on function public.permissao_modo_definir(text) to authenticated;

-- ===== PARTE 6: a estrutura inicial (só nomes provisórios; nenhuma conta criada, nenhum papel mudado) =====
insert into public.org_equipe (nome, unidade, transversal) values
  ('Call Center', null, true), ('Equipe Carla Adrielle', null, false), ('Equipe Juliana', null, false), ('Equipe Luzia', 'csi', false)
on conflict (nome) do nothing;
insert into public.org_membro (equipe_id, agente_id, rotulo, funcao)
select e.id, a.id, null, 'supervisor' from public.org_equipe e join public.agentes a on a.nome = 'Carla Adrielle' where e.nome = 'Equipe Carla Adrielle'
   and not exists (select 1 from public.org_membro m where m.equipe_id = e.id and m.agente_id = a.id);
insert into public.org_membro (equipe_id, agente_id, rotulo, funcao)
select e.id, null, x.r, 'supervisor' from public.org_equipe e join (values ('Equipe Juliana', 'Juliana (sem conta ainda)'), ('Equipe Luzia', 'Luzia (sem conta ainda)')) x(eq, r) on x.eq = e.nome
 where not exists (select 1 from public.org_membro m where m.equipe_id = e.id and m.rotulo = x.r);
insert into public.org_membro (equipe_id, agente_id, rotulo, funcao)
select e.id, null, 'Atendente ' || n, 'atendente' from public.org_equipe e cross join generate_series(1, 4) n
 where not exists (select 1 from public.org_membro m where m.equipe_id = e.id and m.rotulo = 'Atendente ' || n);
insert into public.org_membro (equipe_id, agente_id, rotulo, funcao)
select null, a.id, null, 'ti' from public.agentes a where a.nome in ('Alisson', 'Jonathan')
   and not exists (select 1 from public.org_membro m where m.equipe_id is null and m.agente_id = a.id and m.funcao = 'ti');
