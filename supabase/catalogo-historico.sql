-- Fase 1 do plano da memória da IA (docs/plano-ia-memoria-agendamento.md).
-- Já aplicado no projeto webchat-atendimento, em duas migrações:
--   catalogo_foto_referencia  (tabela catalogo_foto + foto de 29/10/2026, antes da limpeza no Klingo)
--   catalogo_historico        (o resto deste arquivo)
-- Antes: a sincronização apagava e regravava o catálogo, sem rastro. Agora ela compara com o que já existe,
-- guarda o que mudou em catalogo_mudanca e só marca como removido o que sumiu do Klingo.

-- ===== 1. Foto de referência (migração catalogo_foto_referencia) =====
-- create table public.catalogo_foto (id, tipo, motivo, referencia, tirada_em, linhas, dados jsonb) + RLS ligado, sem policies.
-- Linhas com referencia = true nunca são apagadas.

-- ===== 2. Histórico (migração catalogo_historico) =====
alter table public.catalogo_procedimento
  add column ativo boolean not null default true,
  add column visto_em timestamptz not null default now(),
  add column removido_em timestamptz,
  add column demanda_90d integer;
alter table public.catalogo_plano
  add column ativo boolean not null default true,
  add column visto_em timestamptz not null default now(),
  add column removido_em timestamptz;
alter table public.catalogo_agenda add column hash text;

update public.catalogo_agenda set hash = md5(row(unidade, local, profissional_id, profissional, especialidade, procedimento_id, procedimento,
  dia_num, dia, hora_ini, hora_fim, duracao_min, operadoras, tele, vagas_extras, vig_ini, vig_fim)::text);
create index catalogo_agenda_hash on public.catalogo_agenda (hash);
create unique index catalogo_plano_chave on public.catalogo_plano (operadora, plano, (coalesce(produto, '')));

create table public.catalogo_mudanca (
  id bigint generated always as identity primary key,
  lote uuid not null,
  detectada_em timestamptz not null default now(),
  tipo text not null check (tipo in ('procedimento','plano','agenda','preco')),
  evento text not null check (evento in ('novo','alterado','removido','reativado','bloqueado')),
  chave text not null,
  descricao text,
  campo text,
  antes text,
  depois text
);
create index catalogo_mudanca_data on public.catalogo_mudanca (detectada_em desc);
create index catalogo_mudanca_tipo on public.catalogo_mudanca (tipo, evento);
comment on table public.catalogo_mudanca is 'O que mudou no catálogo a cada sincronização (novo, alterado, removido, reativado). Sem dado de paciente.';
alter table public.catalogo_mudanca enable row level security;

-- Sincroniza um relatório com o catálogo comparando com o que já existe.
-- Recusa o relatório se vier com menos da metade das linhas ativas (relatório cortado não apaga o catálogo), salvo p_forcar.
create or replace function public.catalogo_sincronizar(p_tipo text, p_linhas jsonb, p_forcar boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_lote uuid := gen_random_uuid();
  v_antes integer; v_novas integer; v_total integer;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' or jsonb_array_length(p_linhas) = 0 then
    raise exception 'Catálogo vazio: nada foi alterado.';
  end if;
  perform pg_advisory_xact_lock(hashtext('catalogo_sincronizar:' || p_tipo));

  if p_tipo = 'procedimento' then
    create temp table _stg on commit drop as
      select distinct on (x.id) x.* from jsonb_to_recordset(p_linhas)
        as x(id int, nome text, tuss text, especialidade text, classe text, idade_min int, idade_max int, sexo text, preparo text)
      where x.id is not null order by x.id;
    select count(*) into v_antes from public.catalogo_procedimento where ativo;
    select count(*) into v_novas from pg_temp._stg;
    if not p_forcar and v_antes > 0 and v_novas < v_antes * 0.5 then
      raise exception 'Relatório de procedimentos veio com % linhas (hoje há % ativas): menos da metade, nada foi alterado.', v_novas, v_antes;
    end if;

    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'procedimento', 'novo', s.id::text, s.nome from pg_temp._stg s
      where not exists (select 1 from public.catalogo_procedimento p where p.id = s.id);
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'procedimento', 'reativado', s.id::text, s.nome from pg_temp._stg s
      join public.catalogo_procedimento p on p.id = s.id where not p.ativo;
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'procedimento', 'removido', p.id::text, p.nome from public.catalogo_procedimento p
      where p.ativo and not exists (select 1 from pg_temp._stg s where s.id = p.id);
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao, campo, antes, depois)
      select v_lote, 'procedimento', 'alterado', p.id::text, s.nome, c.campo, left(c.antes, 300), left(c.depois, 300)
      from pg_temp._stg s join public.catalogo_procedimento p on p.id = s.id
      cross join lateral (values
        ('nome', p.nome, s.nome), ('tuss', p.tuss, s.tuss), ('especialidade', p.especialidade, s.especialidade),
        ('classe', p.classe, s.classe), ('idade_min', p.idade_min::text, s.idade_min::text),
        ('idade_max', p.idade_max::text, s.idade_max::text), ('sexo', p.sexo, s.sexo), ('preparo', p.preparo, s.preparo)
      ) as c(campo, antes, depois)
      where c.antes is distinct from c.depois;

    update public.catalogo_procedimento p set
      nome = s.nome, tuss = s.tuss, especialidade = s.especialidade, classe = s.classe, idade_min = s.idade_min,
      idade_max = s.idade_max, sexo = s.sexo, preparo = s.preparo, ativo = true, removido_em = null, visto_em = now(),
      busca = to_tsvector('portuguese', extensions.unaccent(coalesce(s.nome,'') || ' ' || coalesce(s.especialidade,'') || ' ' || coalesce(s.classe,'')))
    from pg_temp._stg s where s.id = p.id;
    insert into public.catalogo_procedimento (id, nome, tuss, especialidade, classe, idade_min, idade_max, sexo, preparo, busca)
      select s.id, s.nome, s.tuss, s.especialidade, s.classe, s.idade_min, s.idade_max, s.sexo, s.preparo,
             to_tsvector('portuguese', extensions.unaccent(coalesce(s.nome,'') || ' ' || coalesce(s.especialidade,'') || ' ' || coalesce(s.classe,'')))
      from pg_temp._stg s where not exists (select 1 from public.catalogo_procedimento p where p.id = s.id);
    update public.catalogo_procedimento p set ativo = false, removido_em = now()
      where p.ativo and not exists (select 1 from pg_temp._stg s where s.id = p.id);
    select count(*) into v_total from public.catalogo_procedimento where ativo;

  elsif p_tipo = 'plano' then
    create temp table _stg on commit drop as
      select distinct on (x.operadora, x.plano, coalesce(x.produto, '')) x.* from jsonb_to_recordset(p_linhas)
        as x(operadora text, plano text, produto text)
      where x.operadora is not null and x.plano is not null order by x.operadora, x.plano, coalesce(x.produto, '');
    select count(*) into v_antes from public.catalogo_plano where ativo;
    select count(*) into v_novas from pg_temp._stg;
    if not p_forcar and v_antes > 0 and v_novas < v_antes * 0.5 then
      raise exception 'Relatório de planos veio com % linhas (hoje há % ativas): menos da metade, nada foi alterado.', v_novas, v_antes;
    end if;

    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'plano', 'novo', s.operadora || ' · ' || s.plano, s.produto from pg_temp._stg s
      where not exists (select 1 from public.catalogo_plano p where p.operadora = s.operadora and p.plano = s.plano and coalesce(p.produto,'') = coalesce(s.produto,''));
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'plano', 'reativado', s.operadora || ' · ' || s.plano, s.produto from pg_temp._stg s
      join public.catalogo_plano p on p.operadora = s.operadora and p.plano = s.plano and coalesce(p.produto,'') = coalesce(s.produto,'') where not p.ativo;
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'plano', 'removido', p.operadora || ' · ' || p.plano, p.produto from public.catalogo_plano p
      where p.ativo and not exists (select 1 from pg_temp._stg s where s.operadora = p.operadora and s.plano = p.plano and coalesce(s.produto,'') = coalesce(p.produto,''));

    update public.catalogo_plano p set ativo = true, removido_em = null, visto_em = now()
      from pg_temp._stg s where s.operadora = p.operadora and s.plano = p.plano and coalesce(s.produto,'') = coalesce(p.produto,'');
    insert into public.catalogo_plano (operadora, plano, produto, busca)
      select s.operadora, s.plano, s.produto, to_tsvector('simple', extensions.unaccent(coalesce(s.operadora,'') || ' ' || coalesce(s.plano,'')))
      from pg_temp._stg s
      where not exists (select 1 from public.catalogo_plano p where p.operadora = s.operadora and p.plano = s.plano and coalesce(p.produto,'') = coalesce(s.produto,''));
    update public.catalogo_plano p set ativo = false, removido_em = now()
      where p.ativo and not exists (select 1 from pg_temp._stg s where s.operadora = p.operadora and s.plano = p.plano and coalesce(s.produto,'') = coalesce(p.produto,''));
    select count(*) into v_total from public.catalogo_plano where ativo;

  elsif p_tipo = 'agenda' then
    -- Grade semanal: sem histórico linha a linha. As mudanças são resumidas por profissional, procedimento e unidade.
    create temp table _stg on commit drop as
      select x.*, md5(row(x.unidade, x.local, x.profissional_id, x.profissional, x.especialidade, x.procedimento_id, x.procedimento,
        x.dia_num, x.dia, x.hora_ini, x.hora_fim, x.duracao_min, x.operadoras, x.tele, x.vagas_extras, x.vig_ini, x.vig_fim)::text) as h
      from jsonb_to_recordset(p_linhas) as x(unidade text, local text, profissional_id int, profissional text, especialidade text,
        procedimento_id int, procedimento text, dia_num int, dia text, hora_ini text, hora_fim text, duracao_min int,
        operadoras text, tele boolean, vagas_extras int, vig_ini date, vig_fim date);
    select count(*) into v_antes from public.catalogo_agenda;
    select count(*) into v_novas from pg_temp._stg;
    if not p_forcar and v_antes > 0 and v_novas < v_antes * 0.5 then
      raise exception 'Relatório de agenda veio com % linhas (hoje há %): menos da metade, nada foi alterado.', v_novas, v_antes;
    end if;

    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'agenda',
             case when g.n > 0 and g.r > 0 then 'alterado' when g.n > 0 then 'novo' else 'removido' end,
             g.chave, g.n || ' horário(s) novo(s), ' || g.r || ' removido(s)'
      from (select u.chave, count(*) filter (where u.k = 'n') n, count(*) filter (where u.k = 'r') r
            from (select 'n' k, coalesce(s.profissional,'?') || ' · ' || coalesce(s.procedimento,'?') || ' · ' || coalesce(s.unidade,'?') chave
                  from pg_temp._stg s where not exists (select 1 from public.catalogo_agenda a where a.hash = s.h)
                  union all
                  select 'r', coalesce(a.profissional,'?') || ' · ' || coalesce(a.procedimento,'?') || ' · ' || coalesce(a.unidade,'?')
                  from public.catalogo_agenda a where not exists (select 1 from pg_temp._stg s where s.h = a.hash)) u
            group by u.chave) g;

    delete from public.catalogo_agenda where true;
    insert into public.catalogo_agenda (unidade, local, profissional_id, profissional, especialidade, procedimento_id, procedimento,
      dia_num, dia, hora_ini, hora_fim, duracao_min, operadoras, tele, vagas_extras, vig_ini, vig_fim, hash)
      select s.unidade, s.local, s.profissional_id, s.profissional, s.especialidade, s.procedimento_id, s.procedimento,
             s.dia_num, s.dia, s.hora_ini, s.hora_fim, s.duracao_min, s.operadoras, s.tele, s.vagas_extras, s.vig_ini, s.vig_fim, s.h
      from pg_temp._stg s;
    select count(*) into v_total from public.catalogo_agenda;
  else
    raise exception 'Tipo desconhecido: %', p_tipo;
  end if;

  insert into public.catalogo_meta (tipo, linhas, atualizado_em) values (p_tipo, v_total, now())
    on conflict (tipo) do update set linhas = excluded.linhas, atualizado_em = excluded.atualizado_em;

  return jsonb_build_object('tipo', p_tipo, 'antes', v_antes, 'recebidas', v_novas, 'ativas_agora', v_total,
    'mudancas', coalesce((select jsonb_object_agg(evento, n) from
      (select evento, count(distinct chave) n from public.catalogo_mudanca where lote = v_lote group by evento) m), '{}'::jsonb));
end $$;
revoke all on function public.catalogo_sincronizar(text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.catalogo_sincronizar(text, jsonb, boolean) to service_role;

-- A IA só oferece o que está ativo no Klingo.
-- (ia_catalogo: acrescentados "p.ativo and" na busca de procedimentos e "c.ativo and" na de planos; o resto igual.)
