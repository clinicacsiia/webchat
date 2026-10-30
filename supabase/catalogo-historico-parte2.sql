-- Fase 1, parte 2. JÁ APLICADO no projeto webchat-atendimento (catalogo_sincronizar pelo SQL Editor; o resto pelo MCP).
-- Pode rodar mais de uma vez sem problema. Pré-requisito: parte 1 (colunas ativo/hash e tabela catalogo_mudanca).
-- Contém um "delete from catalogo_agenda where true" dentro da função: é a troca da grade de agenda, depois de registrar o que mudou.
-- O editor vai pedir confirmação de comando destrutivo: confirme.

-- 1) Compara o relatório do Klingo com o catálogo, registra o que mudou e só marca como removido o que sumiu.
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

-- 2) Segurança: toda linha de agenda que entrar (inclusive pela carga antiga) recebe o hash.
create or replace function public.catalogo_agenda_hash_trg()
returns trigger language plpgsql set search_path to '' as $$
begin
  new.hash := coalesce(new.hash, md5(row(new.unidade, new.local, new.profissional_id, new.profissional, new.especialidade,
    new.procedimento_id, new.procedimento, new.dia_num, new.dia, new.hora_ini, new.hora_fim, new.duracao_min, new.operadoras,
    new.tele, new.vagas_extras, new.vig_ini, new.vig_fim)::text));
  return new;
end $$;
drop trigger if exists catalogo_agenda_hash on public.catalogo_agenda;
create trigger catalogo_agenda_hash before insert on public.catalogo_agenda
  for each row execute function public.catalogo_agenda_hash_trg();

-- 3) ia_catalogo e 4) catalogo_limpeza: versões vigentes em supabase/catalogo-precos.sql (incluem preços e demanda).

-- 5) Histórico de mudanças para a tela do painel (só administrador).
create or replace function public.catalogo_mudancas(p_limite integer default 200)
returns table (detectada_em timestamptz, tipo text, evento text, chave text, descricao text, campo text, antes text, depois text)
language plpgsql security definer set search_path to '' as $$
begin
  if (select public.papel_atual()) is distinct from 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  return query
    select m.detectada_em, m.tipo, m.evento, m.chave, m.descricao, m.campo, m.antes, m.depois
    from public.catalogo_mudanca m order by m.id desc limit least(greatest(p_limite, 1), 1000);
end $$;
revoke all on function public.catalogo_mudancas(integer) from public, anon;
grant execute on function public.catalogo_mudancas(integer) to authenticated;

-- Conferência: deve mostrar as 5 funções e o gatilho.
select (select count(*) from pg_proc where proname in ('catalogo_sincronizar','catalogo_agenda_hash_trg','ia_catalogo','catalogo_limpeza','catalogo_mudancas')) as funcoes_de_5,
       (select count(*) from pg_trigger where tgname = 'catalogo_agenda_hash') as gatilho;
