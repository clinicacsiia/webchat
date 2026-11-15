-- FLUXOGRAMA: entrada (linhas lidas de um relatório do Klingo com a HORA REAL: id da marcação, chegada, início e fim do atendimento; a leitura do relatório ainda não existe, ver docs/simulacao.md) -> validação (atendimento_hora_gravar só roda pelo servidor (service_role); hora fora de ordem ou exame de mais de 8 h é recusado e contado; nenhum dado de paciente entra: só o id da marcação e os horários) -> lógica (grava em atendimento_hora, uma linha por marcação, sem apagar o que já havia quando a nova leitura vem vazia; a simulação passa a usar a hora real no lugar da chegada aproximada e mede a duração do exame de verdade) -> saída (painel_simulacao_lacunas devolve, por situação do exame, quantas pessoas existem e que porcentagem tem cada dado, só contagem)
-- Versão 1.0 — 15/11/2026 / Mudança: criação (tabela atendimento_hora, atendimento_hora_gravar, sim_minuto e painel_simulacao_lacunas)
--
-- ROLLBACK (rodar no editor SQL do Supabase; pede confirmação por causa do drop):
--   drop function public.painel_simulacao_lacunas(integer);
--   drop function public.atendimento_hora_gravar(jsonb);
--   drop function public.sim_minuto(timestamptz);
--   drop table public.atendimento_hora;
-- (e reaplicar as versões 1.0 de painel_simulacao_dia e painel_simulacao_indicadores, no git, antes do drop da tabela)

create table if not exists public.atendimento_hora (
  marcacao_id text primary key,                 -- mesmo formato de jornada_exame.marcacao_id ('m22544')
  chegada_em  timestamptz,
  inicio_em   timestamptz,
  fim_em      timestamptz,
  fonte       text not null default 'relatorio',
  lido_em     timestamptz not null default now(),
  constraint atendimento_hora_ordem check (
    (inicio_em is null or chegada_em is null or inicio_em >= chegada_em)
    and (fim_em is null or inicio_em is null or fim_em >= inicio_em)
    and (fim_em is null or inicio_em is null or fim_em - inicio_em <= interval '8 hours'))
);
alter table public.atendimento_hora enable row level security;
revoke all on public.atendimento_hora from public, anon, authenticated;
create index if not exists atendimento_hora_fim on public.atendimento_hora (fim_em);

-- Minuto do dia em Salvador/São Paulo (0 a 1439)
create or replace function public.sim_minuto(p_quando timestamptz)
returns integer language sql immutable set search_path = ''
as $f$ select (extract(hour from p_quando at time zone 'America/Sao_Paulo') * 60 + extract(minute from p_quando at time zone 'America/Sao_Paulo'))::int $f$;

-- Grava a hora real. Entrada: [{"m":"m22544","chegada":"2026-11-14T08:50:00-03:00","inicio":"...","fim":"..."}, ...]. Só service_role.
create or replace function public.atendimento_hora_gravar(p_linhas jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $f$
declare
  r jsonb; v_ok integer := 0; v_ruim integer := 0;
  v_m text; v_c timestamptz; v_i timestamptz; v_f timestamptz;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'Entrada deve ser uma lista.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_linhas) > 5000 then
    raise exception 'No máximo 5000 linhas por chamada.' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_linhas) loop
    begin
      v_m := nullif(btrim(r ->> 'm'), '');
      v_c := nullif(r ->> 'chegada', '')::timestamptz; v_i := nullif(r ->> 'inicio', '')::timestamptz; v_f := nullif(r ->> 'fim', '')::timestamptz;
      if v_m is null or v_m !~ '^m[0-9]+$' or (v_c is null and v_i is null and v_f is null) then v_ruim := v_ruim + 1; continue; end if;
      insert into public.atendimento_hora as a (marcacao_id, chegada_em, inicio_em, fim_em, lido_em)
      values (v_m, v_c, v_i, v_f, now())
      on conflict (marcacao_id) do update
        set chegada_em = coalesce(excluded.chegada_em, a.chegada_em), inicio_em = coalesce(excluded.inicio_em, a.inicio_em),
            fim_em = coalesce(excluded.fim_em, a.fim_em), lido_em = now();
      v_ok := v_ok + 1;
    exception when others then
      v_ruim := v_ruim + 1;   -- hora fora de ordem, formato inválido ou exame de mais de 8 h
    end;
  end loop;
  return jsonb_build_object('gravadas', v_ok, 'recusadas', v_ruim);
end;
$f$;
revoke all on function public.atendimento_hora_gravar(jsonb) from public, anon, authenticated;
grant execute on function public.atendimento_hora_gravar(jsonb) to service_role;

-- O que falta nos dados: por situação do exame, quantas marcações e quantas pessoas, e quantas têm cada dado. Só contagem.
create or replace function public.painel_simulacao_lacunas(p_dias integer default 28)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $f$
declare
  v_tz text := 'America/Sao_Paulo';
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dias integer := greatest(7, least(coalesce(p_dias, 28), 90));
  v_de timestamptz; v_fut timestamptz; v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem a simulação.' using errcode = '42501';
  end if;
  v_de := (v_hoje - v_dias)::timestamp at time zone v_tz;
  v_fut := (v_hoje + 16)::timestamp at time zone v_tz;
  with e as (
    select x.id, x.status, k.paciente_chave, x.confirm_status, x.atendimento_id, x.cancelamento_motivo,
           (h.chegada_em is not null or exists (select 1 from public.jornada_evento v where v.card_id = x.card_id and v.para_coluna = 'em_atendimento' and v.origem = 'klingo'
                                                  and (v.quando at time zone v_tz)::date = (x.agendado_para at time zone v_tz)::date)) as tem_chegada,
           (h.inicio_em is not null and h.fim_em is not null) as tem_horas,
           (p.fone_chave is not null) as tem_fone,
           (c.m is not null) as na_conf, coalesce(c.origem, 'sem_origem') <> 'sem_origem' as tem_origem, coalesce(cardinality(c.vazios), 0) = 0 as cadastro_ok,
           exists (select 1 from public.app_resultado r where r.exame_id = x.id and r.entregue_em is not null) as tem_resultado
      from public.jornada_exame x
      join public.jornada_card k on k.id = x.card_id
      left join public.jornada_paciente p on p.prontuario = k.paciente_chave
      left join public.atendimento_hora h on h.marcacao_id = x.marcacao_id
      left join public.klingo_conferencia c on c.m = substr(x.marcacao_id, 2)
     where x.marcacao_id like 'm%' and x.agendado_para >= v_de and x.agendado_para < v_fut
       and x.status in ('agendado', 'confirmado', 'atendido', 'faltou', 'cancelado', 'remarcado')
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_hoje - v_dias, 'ate', v_hoje + 15),
    'linhas', coalesce((select jsonb_agg(jsonb_build_object(
        'status', s, 'marcacoes', n, 'pessoas', pessoas,
        'campos', jsonb_build_object(
          'chegada',        jsonb_build_object('de', case when s = 'atendido' then n end, 'com', case when s = 'atendido' then c_cheg end),
          'inicio_fim',     jsonb_build_object('de', case when s = 'atendido' then n end, 'com', case when s = 'atendido' then c_horas end),
          'atendimento_id', jsonb_build_object('de', case when s = 'atendido' then n end, 'com', case when s = 'atendido' then c_atend end),
          'resultado',      jsonb_build_object('de', case when s = 'atendido' then n end, 'com', case when s = 'atendido' then c_res end),
          'confirmacao',    jsonb_build_object('de', n, 'com', c_conf),
          'telefone',       jsonb_build_object('de', n, 'com', c_fone),
          'origem',         jsonb_build_object('de', n_conf, 'com', c_orig),
          'cadastro',       jsonb_build_object('de', n_conf, 'com', c_cad),
          'motivo',         jsonb_build_object('de', case when s in ('cancelado', 'remarcado') then n end, 'com', case when s in ('cancelado', 'remarcado') then c_mot end))
      ) order by ord)
      from (select status as s, case status when 'agendado' then 1 when 'confirmado' then 2 when 'atendido' then 3 when 'faltou' then 4 when 'cancelado' then 5 else 6 end as ord,
                   count(*) as n, count(distinct paciente_chave) as pessoas,
                   count(*) filter (where tem_chegada) as c_cheg, count(*) filter (where tem_horas) as c_horas,
                   count(*) filter (where atendimento_id is not null) as c_atend, count(*) filter (where tem_resultado) as c_res,
                   count(*) filter (where confirm_status in ('Confirmado', 'A Confirmar', 'Sem Resposta')) as c_conf,
                   count(*) filter (where tem_fone) as c_fone,
                   count(*) filter (where na_conf) as n_conf, count(*) filter (where na_conf and tem_origem) as c_orig, count(*) filter (where na_conf and cadastro_ok) as c_cad,
                   count(*) filter (where nullif(btrim(cancelamento_motivo), '') is not null) as c_mot
              from e group by status) z), '[]'::jsonb),
    'hora_real', jsonb_build_object(
        'atendidos', (select count(*) from e where status = 'atendido'),
        'com_inicio_e_fim', (select count(*) from e where status = 'atendido' and tem_horas),
        'ultima_leitura', (select max(lido_em) from public.atendimento_hora)))
    into v_out;
  return v_out;
end;
$f$;
revoke all on function public.painel_simulacao_lacunas(integer) from public, anon;
grant execute on function public.painel_simulacao_lacunas(integer) to authenticated, service_role;
