-- FLUXOGRAMA: entrada (período livre de/até, unidade, "incluir testes") -> validação (só administrador e atendente; período limitado; testes fora por padrão) -> lógica (PESSOAS ÚNICAS por dia = quem teve o primeiro atendimento humano naquele dia; REENTRADAS = vezes em que a mesma pessoa voltou (conversa nova ou reaberta) no mesmo dia depois do primeiro contato; SEM ATENDIMENTO HUMANO = conversas do dia que nenhuma pessoa atendeu até o fim do dia; CONCLUÍDAS pela data/hora real do encerramento; EM ANDAMENTO é a foto de agora; dia já fechado vem do congelamento, nunca é recalculado) -> saída (JSON único para cartões, tabela por dia e gráfico, mesma regra de data para tudo)
-- Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (IND-01, IND-04, IND-05; decisões Q-01, Q-03 e C-1 do dono de 10/11/2026).
-- Pré-requisitos: etapa0-eventos-e-teste.sql (conversas.teste, primeiro_humano_em, conversa_evento), indicadores-unidade.sql (painel_conversa_pessoa_un), conversa_encerramento, pessoa-unica.sql.
-- Regras (fuso America/Sao_Paulo em tudo):
--   * Pessoa = conversas da mesma pessoa juntas (conversa_grupo), igual ao painel.
--   * Entrada (principal): pessoa-dia em que alguma conversa teve o 1º atendimento humano (primeiro_humano_em = assumiu ou respondeu).
--   * Contato = conversa criada ou reaberta naquele dia. Reentradas do dia = contatos - 1, só em dia em que a pessoa é Entrada. Reaberturas só existem a partir de 10/11/2026 (o histórico anterior não guardava).
--   * Sem atendimento humano = conversa criada no dia sem primeiro_humano_em até 24h do mesmo dia (foto de fim de dia; quem foi atendido no dia seguinte aparece como Entrada nesse dia seguinte).
--   * Concluída = linha de conversa_encerramento (cada fechamento conta uma vez, na data real). Reencerrada = a conversa já tinha sido fechada antes. Cruzou a meia-noite = criada em dia anterior ao do fechamento.
--   * Testes (conversas.teste) ficam fora, a não ser que se peça para incluir.
--   * Dia FECHADO (ind_fechamento) vem das tabelas congeladas; nada altera ou apaga (gatilho). Enquanto config.indicadores_fechar = 'nao', nenhum dia é congelado e tudo é calculado ao vivo.
-- Unidade desconhecida (sem unidade para a pessoa) aparece em TODAS as unidades (regra de ouro do painel).
-- ROLLBACK: drop function public.painel_indicadores_v2(date, date, text, boolean), public.painel_indicadores_jornada_v2(date, date, text, boolean), public.ind_fechar_pendentes(), public.ind_fechar_dia(date),
--           public.ind_calc_pessoas(date, date), public.ind_calc_conclusoes(date, date), public.ind_calc_semhumano(date, date); (as tabelas ind_* podem ficar)

insert into public.config (chave, valor) values ('indicadores_fechar', 'nao') on conflict (chave) do nothing;

-- ===== Tabelas do congelamento =====
create table if not exists public.ind_fechamento (dia date primary key, fechado_em timestamptz not null default now(), regra_versao integer not null default 1, resumo jsonb);
create table if not exists public.ind_pessoa_dia (
  dia date not null, pessoa text not null, teste boolean not null, unidades text[] not null default '{}',
  contatos integer not null, entrou boolean not null, reentradas integer not null, transferencias integer not null default 0,
  primary key (dia, pessoa, teste));
create table if not exists public.ind_conclusao_dia (
  dia date not null, ordem integer not null, pessoa text, teste boolean not null, unidades text[] not null default '{}',
  origem text, motivo text, cruzou boolean not null, mais24 boolean not null, reencerrada boolean not null,
  primary key (dia, ordem));
create table if not exists public.ind_semhumano_dia (
  dia date not null, ordem integer not null, pessoa text, teste boolean not null, unidades text[] not null default '{}',
  primary key (dia, ordem));
comment on table public.ind_fechamento is 'Dias já fechados dos indicadores. Fechado = congelado: ind_pessoa_dia, ind_conclusao_dia e ind_semhumano_dia deste dia não mudam mais. Sem dado de paciente (a pessoa é um código do agrupamento).';
do $$ declare t text; begin
  foreach t in array array['ind_fechamento', 'ind_pessoa_dia', 'ind_conclusao_dia', 'ind_semhumano_dia'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

create or replace function public.ind_imutavel_trg() returns trigger language plpgsql set search_path to '' as $$
begin
  raise exception 'Dia fechado dos indicadores não pode ser alterado nem apagado.' using errcode = '42501';
end $$;
do $$ declare t text; begin
  foreach t in array array['ind_fechamento', 'ind_pessoa_dia', 'ind_conclusao_dia', 'ind_semhumano_dia'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_imutavel' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before update or delete on public.%I for each row execute function public.ind_imutavel_trg()', t || '_imutavel', t);
      execute format('create trigger %I before truncate on public.%I for each statement execute function public.ind_imutavel_trg()', t || '_imutavel_t', t);
    end if;
  end loop;
end $$;

-- ===== Cálculo ao vivo (também é o que o congelamento grava) =====
create or replace function public.ind_calc_pessoas(p_de date, p_ate date)
returns table (dia date, pessoa text, teste boolean, unidades text[], contatos integer, entrou boolean, reentradas integer, transferencias integer)
language sql stable security definer set search_path to '' as $$
  with pu as (select x.conversa_id, x.pessoa, x.chaves from public.painel_conversa_pessoa_un() x),
  cv as (select c.id, pu.pessoa, coalesce(pu.chaves, '{}') as chaves, c.teste, c.criado_em, c.primeiro_humano_em from public.conversas c join pu on pu.conversa_id = c.id),
  ev as (
    select cv.pessoa, cv.teste, cv.chaves, (cv.criado_em at time zone 'America/Sao_Paulo')::date as d, 1 as contato, 0 as transf, false as ent from cv
    union all
    select cv.pessoa, cv.teste, cv.chaves, (e.em at time zone 'America/Sao_Paulo')::date, case when e.tipo = 'reaberta' then 1 else 0 end, case when e.tipo = 'transferida' then 1 else 0 end, false
      from public.conversa_evento e join cv on cv.id = e.conversa_id where e.tipo in ('reaberta', 'transferida')
    union all
    select cv.pessoa, cv.teste, cv.chaves, (cv.primeiro_humano_em at time zone 'America/Sao_Paulo')::date, 0, 0, true from cv where cv.primeiro_humano_em is not null)
  select ev.d, ev.pessoa, ev.teste, ev.chaves, sum(ev.contato)::integer, bool_or(ev.ent),
         case when bool_or(ev.ent) then greatest(sum(ev.contato) - 1, 0)::integer else 0 end, sum(ev.transf)::integer
    from ev where ev.d between p_de and p_ate
   group by ev.d, ev.pessoa, ev.teste, ev.chaves
$$;

create or replace function public.ind_calc_conclusoes(p_de date, p_ate date)
returns table (dia date, pessoa text, teste boolean, unidades text[], origem text, motivo text, cruzou boolean, mais24 boolean, reencerrada boolean)
language sql stable security definer set search_path to '' as $$
  select (ce.encerrada_em at time zone 'America/Sao_Paulo')::date, pu.pessoa, c.teste, coalesce(pu.chaves, '{}'),
         coalesce(ce.origem, 'sem_origem'), coalesce(ce.motivo, 'sem_motivo'),
         (c.criado_em at time zone 'America/Sao_Paulo')::date < (ce.encerrada_em at time zone 'America/Sao_Paulo')::date,
         ce.encerrada_em - c.criado_em > interval '24 hours',
         exists (select 1 from public.conversa_encerramento x where x.conversa_id = ce.conversa_id and x.encerrada_em < ce.encerrada_em)
    from public.conversa_encerramento ce
    join public.conversas c on c.id = ce.conversa_id
    join public.painel_conversa_pessoa_un() pu on pu.conversa_id = c.id
   where (ce.encerrada_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
$$;

create or replace function public.ind_calc_semhumano(p_de date, p_ate date)
returns table (dia date, pessoa text, teste boolean, unidades text[])
language sql stable security definer set search_path to '' as $$
  select (c.criado_em at time zone 'America/Sao_Paulo')::date, pu.pessoa, c.teste, coalesce(pu.chaves, '{}')
    from public.conversas c
    join public.painel_conversa_pessoa_un() pu on pu.conversa_id = c.id
   where (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
     and (c.primeiro_humano_em is null
          or c.primeiro_humano_em >= (((c.criado_em at time zone 'America/Sao_Paulo')::date + 1)::timestamp at time zone 'America/Sao_Paulo'))
$$;
revoke all on function public.ind_calc_pessoas(date, date), public.ind_calc_conclusoes(date, date), public.ind_calc_semhumano(date, date) from public, anon, authenticated;
grant execute on function public.ind_calc_pessoas(date, date), public.ind_calc_conclusoes(date, date), public.ind_calc_semhumano(date, date) to service_role;

-- ===== Congelamento =====
create or replace function public.ind_fechar_dia(p_dia date) returns boolean
language plpgsql security definer set search_path to '' as $$
declare v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; v_resumo jsonb;
begin
  if p_dia is null or p_dia >= v_hoje then raise exception 'Só se fecha um dia que já terminou.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('ind_fechar_dia'));
  if exists (select 1 from public.ind_fechamento f where f.dia = p_dia) then return false; end if;
  insert into public.ind_pessoa_dia (dia, pessoa, teste, unidades, contatos, entrou, reentradas, transferencias)
    select dia, pessoa, teste, unidades, contatos, entrou, reentradas, transferencias from public.ind_calc_pessoas(p_dia, p_dia);
  insert into public.ind_conclusao_dia (dia, ordem, pessoa, teste, unidades, origem, motivo, cruzou, mais24, reencerrada)
    select dia, row_number() over (order by pessoa, origem, motivo)::integer, pessoa, teste, unidades, origem, motivo, cruzou, mais24, reencerrada from public.ind_calc_conclusoes(p_dia, p_dia);
  insert into public.ind_semhumano_dia (dia, ordem, pessoa, teste, unidades)
    select dia, row_number() over (order by pessoa)::integer, pessoa, teste, unidades from public.ind_calc_semhumano(p_dia, p_dia);
  select jsonb_build_object(
    'pessoas', (select count(distinct pessoa) from public.ind_pessoa_dia where dia = p_dia and entrou and not teste),
    'reentradas', (select coalesce(sum(reentradas), 0) from public.ind_pessoa_dia where dia = p_dia and not teste),
    'concluidas', (select count(*) from public.ind_conclusao_dia where dia = p_dia and not teste),
    'sem_humano', (select count(*) from public.ind_semhumano_dia where dia = p_dia and not teste)) into v_resumo;
  insert into public.ind_fechamento (dia, resumo) values (p_dia, v_resumo);
  return true;
end $$;
revoke all on function public.ind_fechar_dia(date) from public, anon, authenticated;
grant execute on function public.ind_fechar_dia(date) to service_role;

-- Fecha, em ordem, todos os dias que já terminaram e ainda não foram fechados (só se config.indicadores_fechar = 'sim').
create or replace function public.ind_fechar_pendentes() returns integer
language plpgsql security definer set search_path to '' as $$
declare v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; v_d date; v_n integer := 0;
begin
  if coalesce((select valor from public.config where chave = 'indicadores_fechar'), 'nao') <> 'sim' then return 0; end if;
  v_d := coalesce((select max(f.dia) + 1 from public.ind_fechamento f), (select min((c.criado_em at time zone 'America/Sao_Paulo')::date) from public.conversas c));
  while v_d is not null and v_d < v_hoje loop
    if public.ind_fechar_dia(v_d) then v_n := v_n + 1; end if;
    v_d := v_d + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.ind_fechar_pendentes() from public, anon, authenticated;
grant execute on function public.ind_fechar_pendentes() to service_role;

-- ===== O painel =====
create or replace function public.painel_indicadores_v2(p_de date default null, p_ate date default null, p_unidade text default null, p_incluir_teste boolean default false) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date := least(coalesce(p_ate, (now() at time zone 'America/Sao_Paulo')::date), (now() at time zone 'America/Sao_Paulo')::date);
  v_de date;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_ult date; v_vivo date; v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  select max(f.dia) into v_ult from public.ind_fechamento f where f.dia <= v_ate;
  v_vivo := greatest(v_de, coalesce(v_ult + 1, v_de));

  with
  p0 as (
    select dia, pessoa, teste, unidades, contatos, entrou, reentradas, transferencias from public.ind_pessoa_dia where dia between v_de and v_ate
    union all select dia, pessoa, teste, unidades, contatos, entrou, reentradas, transferencias from public.ind_calc_pessoas(v_vivo, v_ate)),
  pf as (select * from p0 where (p_incluir_teste or not teste) and (v_un is null or cardinality(unidades) = 0 or v_un = any (unidades))),
  c0 as (
    select dia, pessoa, teste, unidades, origem, motivo, cruzou, mais24, reencerrada from public.ind_conclusao_dia where dia between v_de and v_ate
    union all select dia, pessoa, teste, unidades, origem, motivo, cruzou, mais24, reencerrada from public.ind_calc_conclusoes(v_vivo, v_ate)),
  cf as (select * from c0 where (p_incluir_teste or not teste) and (v_un is null or cardinality(unidades) = 0 or v_un = any (unidades))),
  s0 as (
    select dia, pessoa, teste, unidades from public.ind_semhumano_dia where dia between v_de and v_ate
    union all select dia, pessoa, teste, unidades from public.ind_calc_semhumano(v_vivo, v_ate)),
  sf as (select * from s0 where (p_incluir_teste or not teste) and (v_un is null or cardinality(unidades) = 0 or v_un = any (unidades))),
  pu as (select x.conversa_id, x.chaves from public.painel_conversa_pessoa_un() x
          where v_un is null or x.chaves is null or cardinality(x.chaves) = 0 or v_un = any (x.chaves)),
  dias as (select d::date as dia from generate_series(v_de, v_ate, interval '1 day') d),
  pd as (select dia, count(distinct pessoa) filter (where entrou) as pessoas, coalesce(sum(reentradas), 0) as reentradas,
                count(distinct pessoa) filter (where reentradas > 0) as voltaram, coalesce(sum(transferencias), 0) as transf from pf group by dia),
  cd as (select dia, count(*) as concluidas from cf group by dia),
  sd as (select dia, count(*) as sem_humano from sf group by dia)
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate, 'fechado_ate', v_ult),
    'unidade', v_un, 'incluir_teste', coalesce(p_incluir_teste, false), 'gerado_em', now(),
    'pessoas', jsonb_build_object(
        'unicas_no_periodo', (select count(distinct pessoa) filter (where entrou) from pf),
        'soma_dos_dias', (select coalesce(sum(pessoas), 0) from pd)),
    'reentradas', jsonb_build_object(
        'total', (select coalesce(sum(reentradas), 0) from pd),
        'pessoas_que_voltaram', (select count(distinct pessoa) filter (where reentradas > 0) from pf)),
    'sem_atendimento_humano', jsonb_build_object(
        'total', (select count(*) from sf),
        'ainda_sem_pessoa_agora', (select count(*) from public.conversas c join pu on pu.conversa_id = c.id
                                    where c.primeiro_humano_em is null and (p_incluir_teste or not c.teste)
                                      and (c.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate)),
    'conclusoes', jsonb_build_object(
        'total', (select count(*) from cf),
        'por_origem', coalesce((select jsonb_object_agg(o.origem, o.n) from (select origem, count(*) as n from cf group by origem) o), '{}'::jsonb),
        'por_motivo', coalesce((select jsonb_object_agg(m.motivo, m.n) from (select motivo, count(*) as n from cf group by motivo) m), '{}'::jsonb),
        'cruzaram_meia_noite', (select count(*) filter (where cruzou) from cf),
        'mais_de_24h', (select count(*) filter (where mais24) from cf),
        'reencerradas', (select count(*) filter (where reencerrada) from cf)),
    'transferencias', (select coalesce(sum(transf), 0) from pd),
    'agora', jsonb_build_object(
        'aguardando', (select count(*) from public.conversas c join pu on pu.conversa_id = c.id where c.status = 'aguardando' and (p_incluir_teste or not c.teste)),
        'em_atendimento', (select count(*) from public.conversas c join pu on pu.conversa_id = c.id where c.status = 'em_atendimento' and (p_incluir_teste or not c.teste))),
    'testes', jsonb_build_object('conversas_criadas_no_periodo', (select count(*) from public.conversas c where c.teste and (c.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate)),
    'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', d.dia, 'pessoas', coalesce(pd.pessoas, 0), 'reentradas', coalesce(pd.reentradas, 0),
              'pessoas_que_voltaram', coalesce(pd.voltaram, 0), 'sem_humano', coalesce(sd.sem_humano, 0), 'concluidas', coalesce(cd.concluidas, 0),
              'transferencias', coalesce(pd.transf, 0), 'fechado', (v_ult is not null and d.dia <= v_ult)) order by d.dia)
            from dias d left join pd on pd.dia = d.dia left join sd on sd.dia = d.dia left join cd on cd.dia = d.dia), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.painel_indicadores_v2(date, date, text, boolean) from public, anon;
grant execute on function public.painel_indicadores_v2(date, date, text, boolean) to authenticated;

-- ===== Na clínica: quem veio do chat, do agendamento ao atendimento (mesmo período livre; a pessoa entra no dia do 1º ATENDIMENTO humano) =====
create or replace function public.painel_indicadores_jornada_v2(p_de date default null, p_ate date default null, p_unidade text default null, p_incluir_teste boolean default false) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_ate date := least(coalesce(p_ate, (now() at time zone 'America/Sao_Paulo')::date), (now() at time zone 'America/Sao_Paulo')::date);
  v_de date;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;

  with sal as (select valor as v from public.config where chave = 'ia_segredo'),
  cv as (
    select c.id, pu.pessoa, c.criado_em, c.primeiro_humano_em, public.pessoa_ficha(c.id) ->> 'nome' as nome,
           case when length(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g')) >= 8
                then encode(sha256(convert_to(right(regexp_replace(ct.telefone, '\D', '', 'g'), 8) || coalesce((select v from sal), ''), 'UTF8')), 'hex') end as fh
      from public.conversas c
      join public.contatos ct on ct.id = c.contato_id
      join public.painel_conversa_pessoa_un() pu on pu.conversa_id = c.id
     where (p_incluir_teste or not c.teste)
       and (v_un is null or pu.chaves is null or cardinality(pu.chaves) = 0 or v_un = any (pu.chaves))),
  pf as (
    select pessoa, min(criado_em) as pri, (min(primeiro_humano_em) at time zone 'America/Sao_Paulo')::date as dia
      from cv where primeiro_humano_em is not null group by pessoa
    having (min(primeiro_humano_em) at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
  lig as (
    select cv.pessoa, p.prontuario, false as por_marcacao
      from cv join public.jornada_paciente p on p.fone_chave = cv.fh and public.nome_confere(p.nome, cv.nome)
    union
    select cv.pessoa, c.paciente_chave, true
      from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id
              join public.jornada_exame e on e.marcacao_id = any (pa.klingo_marcacoes)
              join public.jornada_card c on c.id = e.card_id),
  ex as (
    select distinct pf.pessoa, e.id as exame, e.status
      from pf join lig on lig.pessoa = pf.pessoa
              join public.jornada_card c on c.paciente_chave = lig.prontuario
              join public.jornada_exame e on e.card_id = c.id
     where e.status <> 'pedido' and (lig.por_marcacao or e.agendado_em >= pf.pri)),
  pp as (
    select pessoa,
           bool_or(status = 'atendido') as atendido,
           bool_or(status = 'faltou') as faltou,
           bool_or(status in ('cancelado', 'remarcado')) as cancrem,
           bool_or(status in ('agendado', 'confirmado')) as pendente
      from ex group by pessoa),
  t as (
    select pf.dia, pf.pessoa, (pp.pessoa is not null) as marcou, coalesce(pp.atendido, false) as atendido,
           coalesce(pp.faltou, false) as faltou, coalesce(pp.cancrem, false) as cancrem, coalesce(pp.pendente, false) as pendente
      from pf left join pp on pp.pessoa = pf.pessoa),
  d as (
    select dia, count(*) as pessoas, count(*) filter (where marcou) as marcaram,
           count(*) filter (where atendido) as atendidos, count(*) filter (where faltou) as faltaram,
           count(*) filter (where cancrem) as cancelaram_remarcaram, count(*) filter (where pendente) as por_vir
      from t group by dia)
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'total', (select jsonb_build_object('pessoas', coalesce(sum(pessoas), 0), 'marcaram', coalesce(sum(marcaram), 0),
                'atendidos', coalesce(sum(atendidos), 0), 'faltaram', coalesce(sum(faltaram), 0), 'cancelaram_remarcaram', coalesce(sum(cancelaram_remarcaram), 0),
                'por_vir', coalesce(sum(por_vir), 0)) from d),
    'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', d.dia, 'pessoas', d.pessoas, 'marcaram', d.marcaram, 'atendidos', d.atendidos,
                'faltaram', d.faltaram, 'cancelaram_remarcaram', d.cancelaram_remarcaram, 'por_vir', d.por_vir) order by d.dia) from d), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.painel_indicadores_jornada_v2(date, date, text, boolean) from public, anon;
grant execute on function public.painel_indicadores_jornada_v2(date, date, text, boolean) to authenticated;

-- ===== Rotina diária (00:10 de Brasília = 03:10 UTC): só fecha dias quando config.indicadores_fechar = 'sim' =====
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'indicadores-fechar-dia') then
    perform cron.schedule('indicadores-fechar-dia', '10 3 * * *', 'select public.ind_fechar_pendentes()');
  end if;
end $$;
