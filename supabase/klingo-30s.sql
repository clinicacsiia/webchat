-- FLUXOGRAMA: entrada (o atendente lança a marcação no Klingo; o banco relê o Klingo a cada 30 segundos) -> validação (nunca duas leituras ao mesmo tempo: uma nova só começa quando a anterior terminou ou foi dada como perdida; erro: tenta de novo em 30 s e, se o erro se repete, espaça) -> lógica (Jornada: relatório por data do exame; Reconhecimento: pedidos do chat sem agendamento comparados por PRONTUÁRIO conferido, depois nome completo e exame) -> saída (cartão da Jornada e pedido "Agendado" com a confirmação à paciente em até ~1 minuto)
-- Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (Q-06 e Q-08 do dono: atualização do Klingo em 30 s, sem sobreposição; "a única coisa ao vivo depois da escolha é o cadastro feito no Klingo e a confirmação à paciente").
-- Pré-requisitos: jornada-monitor.sql (jornada_sync_estado, jornada_klingo_agendar/_proximo/_falha/_fechar), agendamento-reconhecer-v3.sql (agendamento_reconhecer_alvos/_disparar/_aplicar), Edge Function klingo-reconhecer v1.1 (chama agendamento_reconhecer_fim).
-- O que muda: (1) intervalo da Jornada no expediente: 1 min -> 30 s; (2) o aviso de "em andamento" passa a olhar se a leitura TERMINOU (coluna nova klingo_fim_em), não só quando começou; (3) erro: nova tentativa em 30 s (4 primeiras falhas), depois 2 min (até 8) e 10 min (surto longo); (4) reconhecimento: de 10 min para 30 s, com a mesma trava; (5) prontuários já conferidos do paciente vão para a comparação; (6) leitura da ocupação também de madrugada (a cada 30 min).
-- DESLIGAR RÁPIDO: select cron.unschedule('jornada-klingo-30s'); select cron.alter_job((select jobid from cron.job where jobname = 'agendamento-reconhecer-klingo'), schedule := '*/10 * * * *');
-- ROLLBACK das funções: restaurar jornada_klingo_proximo/_agendar/_falha/_fechar de supabase/jornada-monitor.sql e agendamento_reconhecer_disparar/_alvos de supabase/agendamento-reconhecer-v3.sql.

-- ===== 1. Jornada =====
alter table public.jornada_sync_estado add column if not exists klingo_fim_em timestamptz;
comment on column public.jornada_sync_estado.klingo_fim_em is 'Quando a última tentativa de leitura do Klingo TERMINOU (com sucesso ou erro). Tentativa em andamento = klingo_tentativa_em > klingo_fim_em (ou fim nulo).';

create or replace function public.jornada_klingo_proximo(p_agora timestamptz, p_movimento timestamptz) returns timestamptz
language plpgsql immutable set search_path to '' as $$
declare
  v_local timestamp := p_agora at time zone 'America/Sao_Paulo';
  v_h     time := v_local::time;
  v_dow   integer := extract(isodow from v_local)::integer;
  v_int   interval;
  v_dia   date;
begin
  if p_movimento is not null and p_movimento > p_agora - interval '15 minutes' then
    v_int := interval '30 seconds';
  elsif public.jornada_klingo_expediente(p_agora) then
    v_int := interval '30 seconds';
  elsif v_dow <> 7 and v_h >= time '18:30' and v_h < time '22:00' then
    v_int := interval '15 minutes';
  elsif v_h >= time '22:00' or v_h < time '05:00' then
    v_int := interval '2 hours';
  else
    v_int := interval '30 minutes';
  end if;
  v_dia := v_local::date;
  if v_h >= time '06:30' then v_dia := v_dia + 1; end if;
  while extract(isodow from v_dia) = 7 loop v_dia := v_dia + 1; end loop;
  return least(p_agora + v_int, (v_dia + time '06:30') at time zone 'America/Sao_Paulo');
end $$;

create or replace function public.jornada_klingo_agendar() returns text
language plpgsql security definer set search_path to '' as $$
declare
  e       public.jornada_sync_estado%rowtype;
  v_agora timestamptz := now();
  v_modo  text;
begin
  perform pg_advisory_xact_lock(hashtext('jornada_klingo_agendar'));
  select * into e from public.jornada_sync_estado where id;
  if e.klingo_proximo_em is not null and v_agora < e.klingo_proximo_em then
    return 'aguardando';
  end if;
  -- Leitura em andamento: começou e ainda não terminou. Se passou de 150 s sem terminar, é dada como perdida (a chamada ao Klingo expira em 120 s).
  if e.klingo_tentativa_em is not null and (e.klingo_fim_em is null or e.klingo_fim_em < e.klingo_tentativa_em) and v_agora < e.klingo_tentativa_em + interval '150 seconds' then
    return 'em andamento';
  end if;
  v_modo := case
    when e.klingo_completo_em is null
      or v_agora - e.klingo_completo_em > case when public.jornada_klingo_expediente(v_agora) then interval '10 minutes' else interval '60 minutes' end then 'completo'
    else 'rapido'
  end;
  update public.jornada_sync_estado set klingo_tentativa_em = v_agora, klingo_modo = v_modo where id;
  perform net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-jornada-klingo',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := jsonb_build_object('modo', v_modo),
    timeout_milliseconds := 120000);
  return v_modo;
end $$;

create or replace function public.jornada_klingo_falha(p_erro text) returns void
language sql security definer set search_path to '' as $$
  update public.jornada_sync_estado
     set klingo_erro = left(coalesce(nullif(trim(p_erro), ''), 'erro desconhecido'), 300),
         klingo_falhas = klingo_falhas + 1,
         klingo_fim_em = now(),
         klingo_proximo_em = now() + case when klingo_falhas + 1 <= 4 then interval '30 seconds' when klingo_falhas + 1 <= 8 then interval '2 minutes' else interval '10 minutes' end
   where id;
$$;

-- jornada_klingo_fechar: acrescenta klingo_fim_em = now() ao fechamento (o restante da função fica como está em produção).
do $$
declare d text;
begin
  select pg_get_functiondef('public.jornada_klingo_fechar(integer,integer,jsonb)'::regprocedure) into d;
  if d not like '%klingo_fim_em%' then
    d := replace(d, 'set klingo_em = now(), klingo_resultado = v_saida,', 'set klingo_em = now(), klingo_fim_em = now(), klingo_resultado = v_saida,');
    if d not like '%klingo_fim_em%' then raise exception 'jornada_klingo_fechar mudou: ajuste este arquivo'; end if;
    execute d;
  end if;
end $$;

-- ===== 2. Reconhecimento dos agendamentos feitos no Klingo =====
create table if not exists public.agendamento_reconhecer_estado (
  id boolean primary key default true check (id),
  iniciou_em timestamptz, terminou_em timestamptz, proximo_em timestamptz,
  falhas integer not null default 0, erro text
);
insert into public.agendamento_reconhecer_estado (id) values (true) on conflict (id) do nothing;
alter table public.agendamento_reconhecer_estado enable row level security;
revoke all on public.agendamento_reconhecer_estado from anon, authenticated;
comment on table public.agendamento_reconhecer_estado is 'Controle da leitura do Klingo que reconhece agendamentos: uma por vez, nova tentativa após erro. Sem dado de paciente.';

create or replace function public.agendamento_reconhecer_fim(p_ok boolean, p_erro text default null) returns void
language sql security definer set search_path to '' as $$
  update public.agendamento_reconhecer_estado
     set terminou_em = now(),
         falhas = case when p_ok then 0 else falhas + 1 end,
         erro = case when p_ok then null else left(coalesce(nullif(trim(p_erro), ''), 'erro desconhecido'), 300) end,
         proximo_em = case when p_ok then null
                           else now() + case when falhas + 1 <= 4 then interval '30 seconds' when falhas + 1 <= 8 then interval '2 minutes' else interval '10 minutes' end end
   where id;
$$;
revoke all on function public.agendamento_reconhecer_fim(boolean, text) from public, anon, authenticated;
grant execute on function public.agendamento_reconhecer_fim(boolean, text) to service_role;

create or replace function public.agendamento_reconhecer_disparar() returns void
language plpgsql security definer set search_path to '' as $$
declare e public.agendamento_reconhecer_estado%rowtype;
begin
  if coalesce((select valor from public.config where chave = 'agendamento_reconhecer'), 'nao') <> 'sim' then return; end if;
  perform pg_advisory_xact_lock(hashtext('agendamento_reconhecer_disparar'));
  select * into e from public.agendamento_reconhecer_estado where id;
  if e.proximo_em is not null and now() < e.proximo_em then return; end if;                                   -- espera depois de um erro
  if e.iniciou_em is not null and (e.terminou_em is null or e.terminou_em < e.iniciou_em) and now() < e.iniciou_em + interval '150 seconds' then return; end if;   -- ainda lendo
  if jsonb_array_length(public.agendamento_reconhecer_alvos(14)) = 0 then return; end if;
  update public.agendamento_reconhecer_estado set iniciou_em = now() where id;
  perform net.http_post(url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-reconhecer',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := '{"aplicar":true,"dias":14}'::jsonb, timeout_milliseconds := 100000);
end $$;

-- Prontuários JÁ CONFERIDOS de cada pedido (CPF + nascimento conferidos no chat, ou vínculo confirmado pela equipe), da conversa e das conversas unidas da mesma pessoa.
create or replace function public.agendamento_reconhecer_alvos(p_dias integer default 14)
returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', pa.id, 'conv_criada', c.criado_em, 'conv_status', c.status,
      'nome', coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), ct.nome),
      'fones', array(select distinct right(d, 8) from (select regexp_replace(coalesce(x, ''), '\D', '', 'g') as d
                                                        from unnest(array[ct.telefone, pa.paciente ->> 'celular', pa.paciente ->> 'telefone']) x) q where length(d) >= 8),
      'itens', coalesce((select jsonb_agg(i.procedimento order by i.id) from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and nullif(btrim(i.procedimento), '') is not null),
                        case when nullif(btrim(pa.procedimento), '') is not null then jsonb_build_array(pa.procedimento) else '[]'::jsonb end),
      'prontuarios', array(select distinct pr from (
          select v.prontuario as pr from public.paciente_klingo_vinculo v where v.conversa_id = any (public.pessoa_membros(pa.conversa_id)) and v.situacao = 'confere' and nullif(btrim(v.prontuario), '') is not null
          union all
          select pv.prontuario from public.pessoa_klingo_vinculo pv where pv.conversa_id = any (public.pessoa_membros(pa.conversa_id)) and nullif(btrim(pv.prontuario), '') is not null
            and pv.prontuario not like 'n:%') q))), '[]'::jsonb)
    from public.pre_agendamentos pa
    join public.conversas c on c.id = pa.conversa_id
    join public.contatos ct on ct.id = c.contato_id
   where pa.criado_em > now() - make_interval(days => least(greatest(coalesce(p_dias, 14), 1), 30))
     and pa.klingo_marcacoes is null
     and pa.status in ('pronto', 'rascunho')
     and (c.status in ('em_atendimento', 'encerrada') or (c.status = 'aguardando' and pa.status = 'pronto'))
     and (exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and nullif(btrim(i.procedimento), '') is not null) or nullif(btrim(pa.procedimento), '') is not null)
$$;

-- ===== 3. Rotinas (pg_cron) =====
-- Reconhecimento: de 10 min para 30 s. Jornada: rotina própria de 30 s (a de 1 min continua e só repete o pedido, que a trava recusa).
select cron.alter_job((select jobid from cron.job where jobname = 'agendamento-reconhecer-klingo'), schedule := '30 seconds');
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'jornada-klingo-30s') then
    perform cron.schedule('jornada-klingo-30s', '30 seconds', 'select public.jornada_klingo_agendar()');
  end if;
  -- Ocupação do Klingo também de madrugada (a de dia é a rotina agenda-ocupacao, de 10 em 10 min, das 05h às 22h50 de Brasília).
  if not exists (select 1 from cron.job where jobname = 'agenda-ocupacao-noite') then
    perform cron.schedule('agenda-ocupacao-noite', '*/30 2-7 * * *', $cmd$
  select net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := '{"agenda":"ocupacao"}'::jsonb, timeout_milliseconds := 120000);
$cmd$);
  end if;
end $$;
