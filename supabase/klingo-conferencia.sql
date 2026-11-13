-- FLUXOGRAMA: entrada (a Edge Function `klingo-conferir` lê o relatório #14554 do Klingo e manda, em lotes, uma linha por marcação com MARCAS e não com dados: origem, status, datas, nome, hash do celular/CPF/e-mail, nascimento e quais campos vieram vazios) -> validação (id numérico, data de marcação válida; chave interna) -> lógica (liga a marcação à conversa do webchat pelo pedido (`pre_agendamentos.klingo_marcacoes`) ou por celular + nome; compara nome, nascimento, CPF, celular e e-mail com o que o paciente informou no chat; caso de FILHO: CPF, celular e e-mail do chat são do responsável, então diferença neles é esperada e nunca vira conflito nem pedido de cadastro) -> saída (tabela `klingo_conferencia` só com marcas e nomes de campos; avisos `klingo_conflito` e `klingo_dado_faltando` na aba Avisos; função `painel_indicadores_conferencia` para o bloco do painel)
-- Versão 1.0 — 13/11/2026 / Mudança: conferência Klingo x webchat (explica a divergência do indicador, mostra conflitos e dado faltando, manda aviso à equipe)
-- Pré-requisitos: jornada-paciente.sql (jornada_exame), pre-agendamentos.sql (klingo_marcacoes), pessoa-unica.sql (pessoa_ficha), paciente-aviso (paciente_aviso), indicadores-decisao.sql (ind_decisao_periodo), fila-unidade.sql (unidade_chave).
-- Privacidade: a tabela NÃO guarda CPF, e-mail, telefone nem nascimento. A Edge Function manda hash (SHA-256 de dado + `config.ia_segredo`, mesma conta do `fone_chave` da Jornada) e o banco só compara e descarta. O nome já existia em `jornada_paciente.nome`.
-- Regras:
--   * Origem da marcação = coluna "Marcação - Origem" do Klingo (Whatsapp, Telefone, Recepção); em branco vira `sem_origem`.
--   * Ligação com o webchat: 1º pelo pedido (`pre_agendamentos.klingo_marcacoes`); 2º por celular da conversa + nome que confere (`nome_confere`), conversa criada até o dia da marcação.
--   * Conflito (próprio): nome, nascimento, CPF, celular ou e-mail diferentes do chat. Conflito (filho): só nome e nascimento (a criança). CPF, celular e e-mail diferentes em filho ficam em `responsavel_diferente` (esperado).
--   * Dado faltando no Klingo: o chat tem celular/e-mail (e CPF, só se for pedido próprio) e o Klingo está vazio. Em filho nunca se sugere CPF; celular e e-mail são o contato do responsável.
--   * Avisos: um por conversa e tipo; atualizam sozinhos; fecham sozinhos quando o Klingo é corrigido; "Conferido" pela equipe não reabre enquanto os dados forem os mesmos.
-- ROLLBACK:
--   select cron.unschedule('klingo-conferir');
--   drop function public.painel_indicadores_conferencia(date, date, text, boolean);
--   drop function public.klingo_conferencia_agendar(integer); drop function public.klingo_conferir_avisos(); drop function public.klingo_conferir_lote(jsonb);
--   update public.paciente_aviso set resolvido_em = now() where tipo in ('klingo_conflito', 'klingo_dado_faltando') and resolvido_em is null;
--   delete from public.paciente_aviso where tipo in ('klingo_conflito', 'klingo_dado_faltando');
--   alter table public.paciente_aviso drop constraint paciente_aviso_tipo_check;
--   alter table public.paciente_aviso add constraint paciente_aviso_tipo_check check (tipo = any (array['klingo_ligado','klingo_varios','dado_diferente','cpf_diferente']));
--   drop table public.klingo_conferencia; delete from public.config where chave = 'klingo_conferir_ativo';

-- ===== PARTE 1: tabela (sem dado pessoal) e chave de liga/desliga =====
create table if not exists public.klingo_conferencia (
  m text primary key,
  marcado_em date not null,
  exame_em date,
  origem text not null default 'sem_origem',
  status_klingo text,
  unidade text,
  plano text,
  conversa_id uuid references public.conversas (id) on delete set null,
  ligacao text check (ligacao in ('pedido', 'telefone_nome')),
  paciente_tipo text,
  conflito text[] not null default '{}',
  responsavel_diferente text[] not null default '{}',
  falta_no_klingo text[] not null default '{}',
  vazios text[] not null default '{}',
  lido_em timestamptz not null default now()
);
comment on table public.klingo_conferencia is 'Uma linha por marcação do relatório #14554 do Klingo: origem, status, ligação com a conversa do webchat e QUAIS campos divergem ou faltam. Nunca guarda CPF, e-mail, telefone nem nascimento.';
create index if not exists klingo_conferencia_marcado_idx on public.klingo_conferencia (marcado_em);
create index if not exists klingo_conferencia_conversa_idx on public.klingo_conferencia (conversa_id) where conversa_id is not null;
alter table public.klingo_conferencia enable row level security;
insert into public.config (chave, valor) values ('klingo_conferir_ativo', 'nao') on conflict (chave) do nothing;

-- ===== PARTE 2: tipos novos de aviso =====
alter table public.paciente_aviso drop constraint if exists paciente_aviso_tipo_check;
alter table public.paciente_aviso add constraint paciente_aviso_tipo_check
  check (tipo = any (array['klingo_ligado', 'klingo_varios', 'dado_diferente', 'cpf_diferente', 'klingo_conflito', 'klingo_dado_faltando']));

-- ===== PARTE 3: recebe um lote, liga ao chat, compara e grava as marcas =====
-- Cada linha do lote: {m, em, para, o, s, u, pl, n, fh, fh2, nasc, cpfh, emh, vz[]}.
create or replace function public.klingo_conferir_lote(p_linhas jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_sal text := coalesce((select valor from public.config where chave = 'ia_segredo'), '');
  n integer := 0;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'O lote precisa ser uma lista.';
  end if;
  with
  l as materialized (
    select x ->> 'm' as m, (x ->> 'em')::date as em, public.data_ou_nula(x ->> 'para') as para,
           coalesce(nullif(btrim(x ->> 'o'), ''), 'sem_origem') as o, nullif(btrim(x ->> 's'), '') as s, x ->> 'u' as u, x ->> 'pl' as pl, nullif(btrim(x ->> 'n'), '') as n,
           nullif(x ->> 'fh', '') as fh, nullif(x ->> 'fh2', '') as fh2, public.data_ou_nula(x ->> 'nasc') as nasc,
           nullif(x ->> 'cpfh', '') as cpfh, nullif(x ->> 'emh', '') as emh,
           coalesce(array(select jsonb_array_elements_text(x -> 'vz')), '{}'::text[]) as vz
      from jsonb_array_elements(p_linhas) x
     where coalesce(x ->> 'm', '') ~ '^\d{1,12}$' and coalesce(x ->> 'em', '') ~ '^\d{4}-\d{2}-\d{2}$'),
  ch as materialized (
    select c.id, c.criado_em, coalesce(c.paciente_tipo, 'proprio') as tipo, public.pessoa_ficha(c.id) ->> 'nome' as nome,
           lower(nullif(btrim(coalesce(nullif(btrim(c.email_informado), ''), ct.email)), '')) as email_conv,
           case when length(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g')) >= 8
                then encode(sha256(convert_to(right(regexp_replace(ct.telefone, '\D', '', 'g'), 8) || v_sal, 'UTF8')), 'hex') end as fh_contato
      from public.conversas c join public.contatos ct on ct.id = c.contato_id
     where not c.teste),
  la as (
    select distinct on (l.m) l.m, pa.conversa_id, pa.paciente
      from l join public.pre_agendamentos pa on l.m = any (pa.klingo_marcacoes)
     order by l.m, pa.atualizado_em desc),
  lb as (
    select distinct on (l.m) l.m, ch.id as conversa_id
      from l join ch on ch.fh_contato is not null and ch.fh_contato in (coalesce(l.fh, '-'), coalesce(l.fh2, '-'))
     where not exists (select 1 from la where la.m = l.m)
       and public.nome_confere(l.n, ch.nome)
       and (ch.criado_em at time zone 'America/Sao_Paulo')::date <= l.em
     order by l.m, ch.criado_em desc),
  lk as (
    select la.m, la.conversa_id, 'pedido'::text as ligacao, la.paciente as pac from la
    union all
    select lb.m, lb.conversa_id, 'telefone_nome',
           coalesce((select p.paciente from public.pre_agendamentos p where p.conversa_id = lb.conversa_id order by p.atualizado_em desc limit 1), '{}'::jsonb) from lb),
  base as (
    select l.*, lk.conversa_id, lk.ligacao, coalesce(c.tipo, 'proprio') as tipo, lk.pac, c.nome as cnome_ficha, c.email_conv, c.fh_contato,
           case when lk.conversa_id is not null then (lk.pac ->> 'nome') end as cnome_pac,
           public.data_ou_nula(lk.pac ->> 'dt_nasc') as cnasc,
           case when length(regexp_replace(coalesce(lk.pac ->> 'cpf', ''), '\D', '', 'g')) = 11
                then encode(sha256(convert_to(regexp_replace(lk.pac ->> 'cpf', '\D', '', 'g') || v_sal, 'UTF8')), 'hex') end as ccpfh,
           lower(nullif(btrim(coalesce(nullif(btrim(lk.pac ->> 'email'), ''), c.email_conv)), '')) as cemail,
           array_remove(array[
             case when length(regexp_replace(coalesce(lk.pac ->> 'celular', ''), '\D', '', 'g')) >= 8
                  then encode(sha256(convert_to(right(regexp_replace(lk.pac ->> 'celular', '\D', '', 'g'), 8) || v_sal, 'UTF8')), 'hex') end,
             case when length(regexp_replace(coalesce(lk.pac ->> 'telefone', ''), '\D', '', 'g')) >= 8
                  then encode(sha256(convert_to(right(regexp_replace(lk.pac ->> 'telefone', '\D', '', 'g'), 8) || v_sal, 'UTF8')), 'hex') end,
             c.fh_contato], null) as ccel
      from l left join lk on lk.m = l.m left join ch c on c.id = lk.conversa_id),
  r as (
    select b.*,
           (b.tipo = 'filho') as filho,
           case when b.conversa_id is null then null
                when b.n is null or (b.cnome_pac is null and b.cnome_ficha is null) then 'sem_dado'
                when public.nome_confere(b.n, b.cnome_pac) or public.nome_confere(b.n, b.cnome_ficha) then 'igual' else 'diferente' end as r_nome,
           case when b.conversa_id is null then null when b.nasc is null or b.cnasc is null then 'sem_dado' when b.nasc = b.cnasc then 'igual' else 'diferente' end as r_nasc,
           case when b.conversa_id is null then null when b.cpfh is null or b.ccpfh is null then 'sem_dado' when b.cpfh = b.ccpfh then 'igual' else 'diferente' end as r_cpf,
           case when b.conversa_id is null then null when (b.fh is null and b.fh2 is null) or cardinality(b.ccel) = 0 then 'sem_dado'
                when (b.fh is not null and b.fh = any (b.ccel)) or (b.fh2 is not null and b.fh2 = any (b.ccel)) then 'igual' else 'diferente' end as r_cel,
           case when b.conversa_id is null then null when b.emh is null or b.cemail is null then 'sem_dado'
                when b.emh = encode(sha256(convert_to(b.cemail || v_sal, 'UTF8')), 'hex') then 'igual' else 'diferente' end as r_mail
      from base b)
  insert into public.klingo_conferencia as k (m, marcado_em, exame_em, origem, status_klingo, unidade, plano, conversa_id, ligacao, paciente_tipo, conflito, responsavel_diferente, falta_no_klingo, vazios, lido_em)
  select r.m, r.em, r.para, r.o, r.s, public.unidade_chave(r.u), case when coalesce(r.pl, '') ilike '%partic%' then 'particular' else 'convenio' end,
         r.conversa_id, r.ligacao, case when r.conversa_id is not null then r.tipo end,
         array_remove(array[case when r.r_nome = 'diferente' then 'nome' end, case when r.r_nasc = 'diferente' then 'nascimento' end,
                            case when not r.filho and r.r_cpf = 'diferente' then 'cpf' end, case when not r.filho and r.r_cel = 'diferente' then 'celular' end,
                            case when not r.filho and r.r_mail = 'diferente' then 'email' end]::text[], null),
         array_remove(array[case when r.filho and r.r_cpf = 'diferente' then 'cpf' end, case when r.filho and r.r_cel = 'diferente' then 'celular' end,
                            case when r.filho and r.r_mail = 'diferente' then 'email' end]::text[], null),
         case when r.conversa_id is null then '{}'::text[] else array_remove(array[
              case when 'celular' = any (r.vz) and cardinality(r.ccel) > 0 then 'celular' end,
              case when 'email' = any (r.vz) and r.cemail is not null then 'email' end,
              case when 'cpf' = any (r.vz) and not r.filho and r.ccpfh is not null then 'cpf' end]::text[], null) end,
         r.vz, now()
    from r
  on conflict (m) do update set marcado_em = excluded.marcado_em, exame_em = excluded.exame_em, origem = excluded.origem, status_klingo = excluded.status_klingo,
      unidade = excluded.unidade, plano = excluded.plano, conversa_id = excluded.conversa_id, ligacao = excluded.ligacao, paciente_tipo = excluded.paciente_tipo,
      conflito = excluded.conflito, responsavel_diferente = excluded.responsavel_diferente, falta_no_klingo = excluded.falta_no_klingo, vazios = excluded.vazios, lido_em = now();
  get diagnostics n = row_count;
  return jsonb_build_object('lidas', n, 'recebidas', jsonb_array_length(p_linhas));
end $$;
revoke all on function public.klingo_conferir_lote(jsonb) from public, anon, authenticated;
grant execute on function public.klingo_conferir_lote(jsonb) to service_role;

-- ===== PARTE 4: avisos (criar, atualizar, fechar sozinho), agendamento e rotina =====
create or replace function public.klingo_conferir_avisos() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_novos integer; v_fechados integer;
begin
  with prob as (
    select k.conversa_id, 'klingo_conflito'::text as tipo, k.m, x.campo, (k.paciente_tipo = 'filho') as filho
      from public.klingo_conferencia k cross join lateral unnest(k.conflito) as x(campo)
     where k.conversa_id is not null and k.status_klingo = 'Aberta' and k.marcado_em >= (now() at time zone 'America/Sao_Paulo')::date - 30
    union all
    select k.conversa_id, 'klingo_dado_faltando', k.m, x.campo, (k.paciente_tipo = 'filho')
      from public.klingo_conferencia k cross join lateral unnest(k.falta_no_klingo) as x(campo)
     where k.conversa_id is not null and k.status_klingo = 'Aberta' and k.marcado_em >= (now() at time zone 'America/Sao_Paulo')::date - 30),
  agg as (
    select p.conversa_id, p.tipo,
           jsonb_build_object('marcacoes', jsonb_agg(distinct p.m order by p.m), 'campos', jsonb_agg(distinct p.campo order by p.campo), 'filho', bool_or(p.filho)) as detalhe
      from prob p join public.conversas c on c.id = p.conversa_id and not c.teste
     group by p.conversa_id, p.tipo),
  ins as (
    insert into public.paciente_aviso (conversa_id, tipo, detalhe)
    select a.conversa_id, a.tipo, a.detalhe from agg a
     where not exists (select 1 from public.paciente_aviso r where r.conversa_id = a.conversa_id and r.tipo = a.tipo and r.resolvido_em is not null and r.detalhe = a.detalhe)
    on conflict (conversa_id, tipo) where resolvido_em is null do update set detalhe = excluded.detalhe
    returning 1),
  fim as (
    update public.paciente_aviso a set resolvido_em = now()
     where a.tipo in ('klingo_conflito', 'klingo_dado_faltando') and a.resolvido_em is null
       and not exists (select 1 from agg where agg.conversa_id = a.conversa_id and agg.tipo = a.tipo)
    returning 1)
  select (select count(*) from ins), (select count(*) from fim) into v_novos, v_fechados;
  return jsonb_build_object('avisos_criados_ou_atualizados', v_novos, 'avisos_fechados_sozinhos', v_fechados);
end $$;
revoke all on function public.klingo_conferir_avisos() from public, anon, authenticated;
grant execute on function public.klingo_conferir_avisos() to service_role;

create or replace function public.klingo_conferencia_agendar(p_dias integer default 4) returns text
language plpgsql security definer set search_path to '' as $$
begin
  if coalesce((select valor from public.config where chave = 'klingo_conferir_ativo'), 'nao') <> 'sim' then return 'desligado'; end if;
  perform net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-conferir',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := jsonb_build_object('dias', least(greatest(coalesce(p_dias, 4), 1), 31)),
    timeout_milliseconds := 120000);
  return 'chamado';
end $$;
revoke all on function public.klingo_conferencia_agendar(integer) from public, anon, authenticated;
grant execute on function public.klingo_conferencia_agendar(integer) to service_role;

-- ===== PARTE 5: função do indicador (bloco "Conferência Klingo x webchat") =====
create or replace function public.painel_indicadores_conferencia(p_de date default null, p_ate date default null, p_unidade text default null, p_incluir_teste boolean default false) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_out jsonb;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;

  with
  k as materialized (
    select k.*, e.status as st_banco, (c.id is not null) as tem_conversa
      from public.klingo_conferencia k
      left join public.jornada_exame e on e.marcacao_id = 'm' || k.m
      left join public.conversas c on c.id = k.conversa_id
     where k.marcado_em between v_de and v_ate
       and (v_un is null or k.unidade is null or k.unidade = v_un)
       and (p_incluir_teste or c.id is null or not c.teste)),
  pu as (select x.conversa_id, x.pessoa from public.painel_conversa_pessoa_un() x
          where v_un is null or x.chaves is null or cardinality(x.chaves) = 0 or v_un = any (x.chaves)),
  cv as (select c.id, pu.pessoa, c.primeiro_humano_em from public.conversas c join pu on pu.conversa_id = c.id
          where (p_incluir_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
  perd as (
    select pa.id as pre_id, pa.conversa_id, pa.atualizado_em from public.pre_agendamentos pa join cv on cv.id = pa.conversa_id
     where pa.status = 'agendado' and coalesce(cardinality(pa.klingo_marcacoes), 0) = 0
       and not exists (select 1 from public.klingo_conferencia z where z.conversa_id = pa.conversa_id)),
  dias as (select d::date as d from generate_series(v_de, v_ate, interval '1 day') d)
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'ultima_leitura', (select max(lido_em) from k),
    'dias_sem_leitura', coalesce((select jsonb_agg(d.d order by d.d) from dias d where not exists (select 1 from k where k.marcado_em = d.d)), '[]'::jsonb),
    'total', (select count(*) from k),
    'por_origem', coalesce((select jsonb_object_agg(o, n) from (select origem as o, count(*) as n from k group by 1) q), '{}'::jsonb),
    'por_status', coalesce((select jsonb_object_agg(coalesce(s, 'sem_status'), n) from (select status_klingo as s, count(*) as n from k group by 1) q), '{}'::jsonb),
    'explicacao', (select jsonb_build_object(
        'no_banco', count(*) filter (where st_banco is not null),
        'fora_do_banco', count(*) filter (where st_banco is null),
        'remarcadas', count(*) filter (where st_banco = 'remarcado'),
        'novas_marcacoes_indicador', count(*) filter (where st_banco is not null and st_banco <> 'remarcado'),
        'canceladas_no_klingo', count(*) filter (where status_klingo = 'Cancelada')) from k),
    'webchat', jsonb_build_object(
        'marcacoes_ligadas', (select count(*) from k where tem_conversa),
        'conversas_ligadas', (select count(distinct conversa_id) from k where tem_conversa),
        'por_ligacao', coalesce((select jsonb_object_agg(ligacao, n) from (select ligacao, count(*) as n from k where tem_conversa group by 1) q), '{}'::jsonb),
        'por_origem', coalesce((select jsonb_object_agg(o, n) from (select origem as o, count(*) as n from k where tem_conversa group by 1) q), '{}'::jsonb),
        'exames', (select jsonb_build_object(
            'atendido', count(*) filter (where st_banco = 'atendido'), 'faltou', count(*) filter (where st_banco = 'faltou'),
            'por_vir', count(*) filter (where st_banco in ('agendado', 'confirmado')), 'cancelado_ou_remarcado', count(*) filter (where st_banco in ('cancelado', 'remarcado')),
            'ainda_fora_do_banco', count(*) filter (where st_banco is null)) from k where tem_conversa),
        'pessoas_que_procuraram', (select count(distinct pessoa) from cv),
        'atendidas_pela_equipe', (select count(distinct pessoa) from cv where primeiro_humano_em is not null),
        'com_pedido_pronto', (select count(distinct cv.pessoa) from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id where pa.status in ('pronto', 'agendado')),
        'agendaram_no_chat', (select count(distinct cv.pessoa) from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id where pa.status = 'agendado'),
        'agendaram_e_ligadas_ao_klingo', (select count(distinct cv.pessoa) from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id
                                           where pa.status = 'agendado' and (coalesce(cardinality(pa.klingo_marcacoes), 0) > 0 or exists (select 1 from public.klingo_conferencia z where z.conversa_id = pa.conversa_id))),
        'agendadas_sem_marcacao_no_klingo', (select count(distinct conversa_id) from perd)),
    'qualidade_klingo', jsonb_build_object(
        'sem_cpf', (select count(*) from k where 'cpf' = any (vazios)), 'sem_email', (select count(*) from k where 'email' = any (vazios)),
        'sem_celular', (select count(*) from k where 'celular' = any (vazios))),
    'problemas', jsonb_build_object(
        'conflito', (select count(*) from k where cardinality(conflito) > 0),
        'dado_faltando', (select count(*) from k where cardinality(falta_no_klingo) > 0),
        'responsavel_diferente_esperado', (select count(*) from k where cardinality(responsavel_diferente) > 0 and cardinality(conflito) = 0),
        'filho_nos_ligados', (select count(*) from k where tem_conversa and paciente_tipo = 'filho')),
    'lista_problemas', coalesce((select jsonb_agg(x order by x ->> 'marcado_em' desc, x ->> 'm') from (
        select jsonb_build_object('m', k.m, 'marcado_em', k.marcado_em, 'origem', k.origem, 'status', k.status_klingo, 'conversa_id', k.conversa_id, 'nome', public.pessoa_ficha(k.conversa_id) ->> 'nome',
               'tipo', k.paciente_tipo, 'conflito', k.conflito, 'falta_no_klingo', k.falta_no_klingo, 'responsavel_diferente', k.responsavel_diferente) as x
          from k where cardinality(k.conflito) > 0 or cardinality(k.falta_no_klingo) > 0 order by k.marcado_em desc, k.m limit 200) q), '[]'::jsonb),
    'lista_ligadas', coalesce((select jsonb_agg(x order by x ->> 'marcado_em' desc, x ->> 'm') from (
        select jsonb_build_object('m', k.m, 'marcado_em', k.marcado_em, 'origem', k.origem, 'ligacao', k.ligacao, 'conversa_id', k.conversa_id, 'nome', public.pessoa_ficha(k.conversa_id) ->> 'nome',
               'tipo', k.paciente_tipo, 'exame', coalesce(k.st_banco, 'fora_do_banco'), 'status', k.status_klingo,
               'problema', (cardinality(k.conflito) > 0 or cardinality(k.falta_no_klingo) > 0)) as x
          from k where k.tem_conversa order by k.marcado_em desc, k.m limit 300) q), '[]'::jsonb),
    'lista_sem_marcacao', coalesce((select jsonb_agg(x order by x ->> 'atualizado_em' desc) from (
        select jsonb_build_object('conversa_id', p.conversa_id, 'nome', public.pessoa_ficha(p.conversa_id) ->> 'nome', 'atualizado_em', p.atualizado_em) as x from perd p order by p.atualizado_em desc limit 100) q), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.painel_indicadores_conferencia(date, date, text, boolean) from public, anon;
grant execute on function public.painel_indicadores_conferencia(date, date, text, boolean) to authenticated;

-- ===== PARTE 6 (aplicada à parte, depois de validar com a semana de 06 a 12/11/2026; não entra no clone de teste) =====
-- select cron.schedule('klingo-conferir', '23 9-23 * * *', $job$select public.klingo_conferencia_agendar(4)$job$);   -- de hora em hora, 06h23 às 20h23 de Brasília
-- update public.config set valor = 'sim' where chave = 'klingo_conferir_ativo';                                    -- liga; 'nao' desliga sem apagar nada
-- Primeira leitura (histórico): select net.http_post(url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-conferir', headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')), body := '{"de":"2026-11-06","ate":"2026-11-12"}'::jsonb, timeout_milliseconds := 120000);
-- Atenção: já existe public.klingo_conferir_agendar(uuid) (autoatendimento, outra função). A desta conferência se chama klingo_conferencia_agendar.
