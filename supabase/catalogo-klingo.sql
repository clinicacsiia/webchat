-- Já aplicado no projeto webchat-atendimento (migrações catalogo_klingo e seguintes).
-- Catálogo copiado de relatórios de cadastro do Klingo (sem dado de paciente) para a IA consultar:
--   13981 procedimentos e preparo | 13984 agenda por profissional | 12301 operadoras e planos.
-- RLS ligado e sem policies: só funções security definer e service_role acessam.

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_cron;

create table public.catalogo_procedimento (
  id integer primary key,
  nome text not null,
  tuss text,
  especialidade text,
  classe text,
  idade_min integer,
  idade_max integer,
  sexo text,
  preparo text,
  busca tsvector not null
);
create index catalogo_procedimento_busca on public.catalogo_procedimento using gin (busca);

create table public.catalogo_agenda (
  id bigint generated always as identity primary key,
  unidade text, local text,
  profissional_id integer, profissional text,
  especialidade text,
  procedimento_id integer, procedimento text,
  dia_num integer, dia text, hora_ini text, hora_fim text,
  duracao_min integer, operadoras text,
  tele boolean, vagas_extras integer,
  vig_ini date, vig_fim date
);
create index catalogo_agenda_proc on public.catalogo_agenda (procedimento_id);

create table public.catalogo_plano (
  id bigint generated always as identity primary key,
  operadora text, plano text, produto text,
  busca tsvector not null
);
create index catalogo_plano_busca on public.catalogo_plano using gin (busca);

create table public.catalogo_meta (
  tipo text primary key,
  linhas integer not null,
  atualizado_em timestamptz not null default now()
);

alter table public.catalogo_procedimento enable row level security;
alter table public.catalogo_agenda enable row level security;
alter table public.catalogo_plano enable row level security;
alter table public.catalogo_meta enable row level security;

-- Substitui (ou, com p_anexar, acrescenta lotes ao) catálogo. DELETE precisa de WHERE no Supabase.
create or replace function public.catalogo_substituir(p_tipo text, p_linhas jsonb, p_anexar boolean default false)
returns integer language plpgsql security definer set search_path to '' as $$
declare n integer;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' or jsonb_array_length(p_linhas) = 0 then
    raise exception 'Catálogo vazio: nada foi alterado.';
  end if;
  if p_tipo = 'procedimento' then
    if not p_anexar then delete from public.catalogo_procedimento where true; end if;
    insert into public.catalogo_procedimento (id, nome, tuss, especialidade, classe, idade_min, idade_max, sexo, preparo, busca)
    select x.id, x.nome, x.tuss, x.especialidade, x.classe, x.idade_min, x.idade_max, x.sexo, x.preparo,
           to_tsvector('portuguese', extensions.unaccent(coalesce(x.nome,'') || ' ' || coalesce(x.especialidade,'') || ' ' || coalesce(x.classe,'')))
    from jsonb_to_recordset(p_linhas) as x(id int, nome text, tuss text, especialidade text, classe text, idade_min int, idade_max int, sexo text, preparo text)
    on conflict (id) do nothing;
    select count(*) into n from public.catalogo_procedimento;
  elsif p_tipo = 'agenda' then
    if not p_anexar then delete from public.catalogo_agenda where true; end if;
    insert into public.catalogo_agenda (unidade, local, profissional_id, profissional, especialidade, procedimento_id, procedimento, dia_num, dia, hora_ini, hora_fim, duracao_min, operadoras, tele, vagas_extras, vig_ini, vig_fim)
    select x.unidade, x.local, x.profissional_id, x.profissional, x.especialidade, x.procedimento_id, x.procedimento, x.dia_num, x.dia, x.hora_ini, x.hora_fim, x.duracao_min, x.operadoras, x.tele, x.vagas_extras, x.vig_ini, x.vig_fim
    from jsonb_to_recordset(p_linhas) as x(unidade text, local text, profissional_id int, profissional text, especialidade text, procedimento_id int, procedimento text, dia_num int, dia text, hora_ini text, hora_fim text, duracao_min int, operadoras text, tele boolean, vagas_extras int, vig_ini date, vig_fim date);
    select count(*) into n from public.catalogo_agenda;
  elsif p_tipo = 'plano' then
    if not p_anexar then delete from public.catalogo_plano where true; end if;
    insert into public.catalogo_plano (operadora, plano, produto, busca)
    select x.operadora, x.plano, x.produto, to_tsvector('simple', extensions.unaccent(coalesce(x.operadora,'') || ' ' || coalesce(x.plano,'')))
    from jsonb_to_recordset(p_linhas) as x(operadora text, plano text, produto text);
    select count(*) into n from public.catalogo_plano;
  else
    raise exception 'Tipo desconhecido: %', p_tipo;
  end if;
  insert into public.catalogo_meta (tipo, linhas, atualizado_em) values (p_tipo, n, now())
    on conflict (tipo) do update set linhas = excluded.linhas, atualizado_em = excluded.atualizado_em;
  return n;
end $$;
revoke all on function public.catalogo_substituir(text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.catalogo_substituir(text, jsonb, boolean) to service_role;

-- Porta de entrada para carga por n8n ou script, protegida pelo segredo da IA (config.ia_segredo).
create or replace function public.ia_catalogo_carregar(p_segredo text, p_tipo text, p_linhas jsonb, p_anexar boolean default false)
returns integer language plpgsql security definer set search_path to '' as $$
declare v_seg text;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then
    raise exception 'Não autorizado.' using errcode = '28000';
  end if;
  return public.catalogo_substituir(p_tipo, p_linhas, p_anexar);
end $$;
revoke all on function public.ia_catalogo_carregar(text, text, jsonb, boolean) from public;
grant execute on function public.ia_catalogo_carregar(text, text, jsonb, boolean) to anon, authenticated;

-- O que a IA consulta a cada mensagem do paciente: procedimentos, agenda semanal e planos que combinam
-- com o que ele escreveu nas últimas mensagens. Siglas e erros comuns viram o termo do cadastro; a sigla
-- e o termo por extenso entram juntos na busca ("TC DO CRÂNIO" e classe "TOMOGRAFIA ...").
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
        from public.catalogo_procedimento p where p.busca @@ v_q
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
        from public.catalogo_plano c where c.busca @@ v_qp
        group by c.operadora order by max(ts_rank(c.busca, v_qp)) desc limit 6) g;

  return r || jsonb_build_object('procedimentos', v_procs, 'agenda', v_agenda, 'planos', v_planos);
end $$;
revoke all on function public.ia_catalogo(text, uuid) from public;
grant execute on function public.ia_catalogo(text, uuid) to anon, authenticated;
