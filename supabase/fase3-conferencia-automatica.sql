-- Fase 3: o status "Agendado" muda sozinho.
-- A cada 15 s o pg_cron chama a Edge Function (só se houver pré-agendamento esperando), que lê o relatório #7 SÓ dos dias esperados
-- e a função agenda_conferir_pre_agendamentos() compara. Nenhum dado de paciente do Klingo é lido para isso nem gravado.
-- Regra do "é desta conversa": o horário (data+hora+médico+unidade) escolhido no chat apareceu OCUPADO depois que a conversa começou
-- e o exame lançado é um dos pedidos. Reserva por ordem de chegada (sem hora exata) não é conferida automaticamente.

alter table public.agenda_ocupacao add column if not exists primeira_vez timestamptz;   -- linhas antigas ficam nulas (= já existiam)
alter table public.agenda_ocupacao alter column primeira_vez set default now();
alter table public.agenda_ocupacao_meta add column if not exists conferindo_ate timestamptz;
alter table public.pre_agendamentos add column if not exists agendado_auto_em timestamptz;

-- Dias que têm pré-agendamento esperando. Devolve vazio se outra conferência ainda está rodando.
create or replace function public.agenda_conferencia_iniciar(p_so_ver boolean default false) returns date[]
language plpgsql security definer set search_path to '' as $$
declare v_dias date[];
begin
  select array_agg(distinct (e ->> 'data')::date) into v_dias
  from public.pre_agendamentos pa, jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e
  where pa.status in ('rascunho','pronto') and coalesce((e ->> 'chegada')::boolean, false) = false
    and (e ->> 'data')::date >= current_date - 1;
  if v_dias is null then return '{}'; end if;
  if p_so_ver then
    return case when exists (select 1 from public.agenda_ocupacao_meta where id = 1 and coalesce(conferindo_ate, '-infinity') > now()) then '{}' else v_dias end;
  end if;
  update public.agenda_ocupacao_meta set conferindo_ate = now() + interval '45 seconds'
    where id = 1 and coalesce(conferindo_ate, '-infinity') <= now();
  if not found then return '{}'; end if;
  return v_dias[1:8];
end $$;
revoke all on function public.agenda_conferencia_iniciar(boolean) from public, anon, authenticated;
grant execute on function public.agenda_conferencia_iniciar(boolean) to service_role;

create or replace function public.agenda_conferir_pre_agendamentos() returns integer
language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  with ok as (
    select pa.id
    from public.pre_agendamentos pa
    where pa.status in ('rascunho','pronto')
      and exists (select 1 from jsonb_array_elements(pa.escolha_horario) e where coalesce((e ->> 'chegada')::boolean, false) = false)
      and not exists (            -- todo horário com hora exata precisa ter aparecido na agenda do Klingo
        select 1 from jsonb_array_elements(pa.escolha_horario) e
        where coalesce((e ->> 'chegada')::boolean, false) = false
          and not exists (
            select 1 from public.agenda_ocupacao o
            where o.fonte = 'marcada'
              and o.inicio = (e ->> 'data')::date + (e ->> 'hora')::time
              and o.profissional = public.norm_nome(e ->> 'profissional')
              and o.unidade = public.norm_nome(e ->> 'unidade')
              and o.primeira_vez >= pa.criado_em
              and (o.procedimento is null or exists (
                    select 1 from public.pre_agendamento_itens i
                    where i.conversa_id = pa.conversa_id and i.ativo and public.norm_nome(i.procedimento) = public.norm_nome(o.procedimento)))))
  ), up as (
    update public.pre_agendamentos pa set status = 'agendado', atualizado_em = now(), agendado_auto_em = now()
    from ok where pa.id = ok.id returning 1)
  select count(*) into v_n from up;
  update public.agenda_ocupacao_meta set conferindo_ate = null where id = 1;
  return v_n;
end $$;
revoke all on function public.agenda_conferir_pre_agendamentos() from public, anon, authenticated;
grant execute on function public.agenda_conferir_pre_agendamentos() to service_role;

-- Cron a cada 15 s, mas só dispara a Edge Function quando há pré-agendamento esperando.
select cron.schedule('agenda-conferir', '15 seconds', $job$
  select net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := '{"agenda":"conferir"}'::jsonb, timeout_milliseconds := 40000)
  where cardinality(public.agenda_conferencia_iniciar(true)) > 0;
$job$);
