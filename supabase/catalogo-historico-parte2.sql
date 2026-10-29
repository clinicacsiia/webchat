-- Fase 1, parte 2: colar inteiro no SQL Editor do Supabase (projeto webchat-atendimento) e clicar em Run.
-- Pode rodar mais de uma vez sem problema. Pré-requisito: parte 1 já aplicada (colunas ativo/hash e tabela catalogo_mudanca).
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

-- 3) A IA só oferece o que está ativo no Klingo (igual à versão atual, com "p.ativo" e "c.ativo" acrescentados).
create or replace function public.ia_catalogo(p_segredo text, p_conversa uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_seg text; v_txt text; v_palavras text[]; v_q tsquery; v_qp tsquery;
  v_ids int[]; v_procs jsonb; v_agenda jsonb; v_planos jsonb; r jsonb;
  v_ignorar text[] := array['quero','queria','gostaria','preciso','marcar','agendar','agendamento','fazer','realizar','boa','bom','dia','tarde','noite','ola','favor','obrigado','obrigada','pode','poderia','tenho','minha','meu','para','paciente','plano','convenio','particular','valor','filho','filha','exame','exames','horario','horarios','atendimento','agenda','marcacao'];
  v_sin jsonb := jsonb_build_object(
    'rm','ressonancia','rnm','ressonancia','resonancia','ressonancia','ressonancea','ressonancia','ressonancias','ressonancia','resonancias','ressonancia',
    'tc','tomografia','tomo','tomografia','tomografias','tomografia','tomografica','tomografia','tomogafia','tomografia','tumografia','tomografia',
    'us','ultrassonografia','usg','ultrassonografia','ultrassom','ultrassonografia','ultrasom','ultrassonografia','ultrasson','ultrassonografia',
    'ultra','ultrassonografia','ultrasonografia','ultrassonografia','ultrassonografica','ultrassonografia','ecografia','ultrassonografia','ultrassons','ultrassonografia',
    'rx','radiografia','raio','radiografia','raios','radiografia','radiografias','radiografia',
    'mamo','mamografia','dexa','densitometria','eletro','eletrocardiograma','ecg','eletrocardiograma','eco','ecocardiograma');
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then
    raise exception 'Não autorizado.' using errcode = '28000';
  end if;

  select string_agg(texto, ' ') into v_txt
  from (select texto from public.mensagens where conversa_id = p_conversa and autor = 'cliente' order by id desc limit 4) t;

  select array_agg(distinct x)
  into v_palavras
  from unnest(regexp_split_to_array(lower(extensions.unaccent(coalesce(v_txt, ''))), '[^a-z0-9]+')) w,
       lateral unnest(array[w, coalesce(v_sin ->> w, w)]) x
  where (length(w) >= 4 or v_sin ? w) and not (w = any(v_ignorar));

  r := jsonb_build_object(
    'unidades', (select coalesce(jsonb_agg(u order by u), '[]'::jsonb) from (select distinct unidade u from public.catalogo_agenda where unidade is not null) x),
    'especialidades_com_agenda', (select coalesce(jsonb_agg(e order by e), '[]'::jsonb)
       from (select distinct especialidade e from public.catalogo_agenda where especialidade is not null and vig_fim >= current_date and profissional !~* 'teste') x));

  if v_palavras is null then
    return r || jsonb_build_object('procedimentos', '[]'::jsonb, 'agenda', '[]'::jsonb, 'planos', '[]'::jsonb);
  end if;

  v_q := to_tsquery('portuguese', array_to_string(v_palavras, ' | '));
  v_qp := to_tsquery('simple', array_to_string(v_palavras, ' | '));

  select coalesce(array_agg(id order by rk desc, tam), '{}'::int[]),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'nome', nome, 'especialidade', especialidade, 'classe', classe,
           'idade_min', idade_min, 'idade_max', idade_max, 'sexo', sexo, 'preparo', left(preparo, 1500)) order by rk desc, tam), '[]'::jsonb)
  into v_ids, v_procs
  from (select p.id, p.nome, p.especialidade, p.classe, p.idade_min, p.idade_max, p.sexo, p.preparo, length(p.nome) tam,
               (select count(*) from unnest(v_palavras) w where p.busca @@ to_tsquery('portuguese', w)) * 10 + ts_rank_cd(p.busca, v_q) rk
        from public.catalogo_procedimento p where p.ativo and p.busca @@ v_q
        order by rk desc, length(p.nome) limit 8) m;

  select coalesce(jsonb_agg(to_jsonb(g) - 'pos' order by g.pos, g.unidade, g.profissional), '[]'::jsonb) into v_agenda
  from (select d.unidade, d.local, d.profissional, d.procedimento, min(array_position(v_ids, d.procedimento_id)) pos,
               string_agg(d.dia || ' ' || d.hora_ini || '-' || d.hora_fim, '; ' order by d.dia_num, d.hora_ini) as dias
        from (select distinct a.unidade, a.local, a.profissional, a.procedimento, a.procedimento_id, a.dia_num, a.dia, a.hora_ini, a.hora_fim
              from public.catalogo_agenda a
              where a.procedimento_id = any(v_ids) and a.vig_fim >= current_date and a.vig_ini <= current_date + 60
                    and a.profissional !~* 'teste') d
        group by d.unidade, d.local, d.profissional, d.procedimento
        order by min(array_position(v_ids, d.procedimento_id)), d.unidade, d.profissional limit 12) g;

  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) into v_planos
  from (select c.operadora, (array_agg(c.plano order by c.plano))[1:5] as planos
        from public.catalogo_plano c where c.ativo and c.busca @@ v_qp
        group by c.operadora order by max(ts_rank(c.busca, v_qp)) desc limit 6) g;

  return r || jsonb_build_object('procedimentos', v_procs, 'agenda', v_agenda, 'planos', v_planos);
end $$;
revoke all on function public.ia_catalogo(text, uuid) from public;
grant execute on function public.ia_catalogo(text, uuid) to anon, authenticated;

-- 4) Lista do que limpar no cadastro do Klingo (só administrador).
create or replace function public.catalogo_limpeza()
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  if (select public.papel_atual()) is distinct from 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'gerado_em', now(),
    'sem_agenda_vigente', (
      select jsonb_build_object('total', count(*),
             'exemplos', coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'classe', x.classe) order by x.nome) filter (where x.rn <= 30), '[]'::jsonb))
      from (select p.id, p.nome, p.classe, row_number() over (order by p.nome) rn
            from public.catalogo_procedimento p
            where p.ativo and not exists (select 1 from public.catalogo_agenda a
                     where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')) x),
    'nomes_duplicados', (
      select coalesce(jsonb_agg(jsonb_build_object('nome', d.nome, 'ids', d.ids)), '[]'::jsonb)
      from (select min(nome) nome, jsonb_agg(id order by id) ids
            from public.catalogo_procedimento where ativo group by upper(trim(nome)) having count(*) > 1) d),
    'agenda_teste', (
      select jsonb_build_object('linhas', count(*), 'profissionais', coalesce(jsonb_agg(distinct profissional), '[]'::jsonb))
      from public.catalogo_agenda where profissional ~* 'teste'),
    'sem_preparo', (select count(*) from public.catalogo_procedimento where ativo and coalesce(preparo, '') = ''),
    'ativos', (select count(*) from public.catalogo_procedimento where ativo),
    'removidos', (select count(*) from public.catalogo_procedimento where not ativo));
end $$;
revoke all on function public.catalogo_limpeza() from public, anon;
grant execute on function public.catalogo_limpeza() to authenticated;

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
