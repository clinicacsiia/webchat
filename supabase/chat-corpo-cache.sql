-- FLUXOGRAMA: entrada (o paciente abre o pedido de exames no chat: tipos de exame e partes do corpo que têm exame) -> validação (token da conversa, como antes) -> lógica (a resposta é igual para todo paciente e só muda quando o catálogo muda: fica guardada pronta e uma rotina refaz a cada 10 minutos; sem cópia recente, calcula na hora como antes) -> saída (o mesmo JSON de sempre, em ~1 ms no lugar de ~1,1 s)
-- Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (auditoria de 11/11/2026)
--
-- O QUE ESTAVA ERRADO (medido na produção em 11/11/2026):
--   * chat_corpo levava 1,1 s com o banco livre (média histórica 1,2 s; máximo 2,4 s) e o chat do paciente tem limite de 3 s.
--     Estourou 2 vezes em 09/11/2026 ("canceling statement due to statement timeout").
--   * O cálculo cruza 6 tipos de exame com 21 regiões no catálogo inteiro, e o resultado não depende do paciente.
--
-- Pré-requisitos: fase2-pedido-e-agenda.sql (chat_corpo, catalogo_exames_regiao, catalogo_regiao). Aditivo e idempotente.
-- A função continua STABLE (o PostgREST a executa em transação só de leitura): ela só LÊ a cópia; quem grava é a rotina.
-- ROLLBACK: select cron.unschedule('chat-corpo-cache'); e reaplicar supabase/producao/funcoes/chat_corpo.sql (retrato de 11/11/2026).

-- ===== PARTE 1: onde a cópia fica (ninguém lê pela API: RLS ligada e sem política) =====
create table if not exists public.chat_cache (
  chave text primary key,
  valor jsonb not null,
  calculado_em timestamptz not null default now()
);
comment on table public.chat_cache is 'Respostas prontas do chat que são iguais para todo paciente (hoje: o mapa do corpo). Sem dado pessoal. Só as funções leem.';
alter table public.chat_cache enable row level security;
revoke all on table public.chat_cache from public, anon, authenticated;

-- ===== PARTE 2: o cálculo (igual ao corpo antigo de chat_corpo, sem o token) =====
create or replace function public.chat_corpo_calcular() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare r jsonb;
begin
  with mods(codigo, nome, mapa, ordem) as (values
    ('RM', 'Ressonância magnética', true, 1), ('TC', 'Tomografia', true, 2), ('US', 'Ultrassom', true, 3),
    ('RX', 'Raio-X', true, 4), ('MAMO', 'Mamografia', false, 5), ('DENSITO', 'Densitometria óssea', false, 6)),
  regs as (select codigo from public.catalogo_regiao union all select 'outros')
  select jsonb_build_object(
    'modalidades', (select jsonb_agg(jsonb_build_object('codigo', m.codigo, 'nome', m.nome, 'mapa', m.mapa,
        'regioes', coalesce((select jsonb_agg(g.codigo) from (select rg.codigo from regs rg
                              where exists (select 1 from public.catalogo_exames_regiao(m.codigo, rg.codigo))) g), '[]'::jsonb),
        'total', (select count(*) from public.catalogo_exames_regiao(m.codigo, 'todos'))) order by m.ordem) from mods m),
    'regioes', (select jsonb_agg(jsonb_build_object('codigo', codigo, 'nome', nome, 'tem_lado', tem_lado, 'grupo', grupo) order by ordem) from public.catalogo_regiao))
  into r;
  return r;
end $$;
revoke all on function public.chat_corpo_calcular() from public, anon, authenticated;

-- ===== PARTE 3: a rotina que guarda a cópia =====
create or replace function public.chat_corpo_atualizar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v jsonb; v_ini timestamptz := clock_timestamp();
begin
  v := public.chat_corpo_calcular();
  insert into public.chat_cache (chave, valor, calculado_em) values ('corpo', v, now())
  on conflict (chave) do update set valor = excluded.valor, calculado_em = excluded.calculado_em;
  return jsonb_build_object('ok', true, 'ms', round(extract(epoch from clock_timestamp() - v_ini) * 1000));
end $$;
revoke all on function public.chat_corpo_atualizar() from public, anon, authenticated;

-- ===== PARTE 4: o chat lê a cópia (até 1 hora de idade); sem ela, calcula na hora como antes =====
create or replace function public.chat_corpo(p_conversa uuid, p_token text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare r jsonb;
begin
  perform public.chat_valida(p_conversa, p_token);
  select valor into r from public.chat_cache where chave = 'corpo' and calculado_em > now() - interval '1 hour';
  if r is null then r := public.chat_corpo_calcular(); end if;
  return r;
end $$;
revoke all on function public.chat_corpo(uuid, text) from public;
grant execute on function public.chat_corpo(uuid, text) to anon, authenticated;

-- ===== PARTE 5: primeira cópia e agendamento (a cada 10 minutos) =====
select public.chat_corpo_atualizar();
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('chat-corpo-cache', '*/10 * * * *', 'select public.chat_corpo_atualizar()');
  end if;
end $$;
