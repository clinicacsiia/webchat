-- FLUXOGRAMA: entrada (a paciente chega ao passo de dia/horário/médico no chat e a Edge Function chat-agenda-ao-vivo pede a leitura do Klingo daquele período) -> validação (token da conversa, interruptor geral, período de até 14 dias, limite de pedidos por conversa, teto de dias sendo lidos ao mesmo tempo) -> lógica (cada dia tem UMA leitura por vez: leitura recente é reaproveitada, leitura em andamento é esperada; a gravação troca a ocupação do período pelo que o Klingo mostra agora, inclusive LIBERANDO horário cancelado, com trava de segurança contra relatório vazio ou cortado) -> saída (agenda_ocupacao atualizada e o controle de quando cada dia foi conferido).
-- Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (AGE-04, decisão do dono de 10/11/2026: dia, horário e médico mostrados à paciente são lidos ao vivo no Klingo quando ela chega ao passo, mesmo que isso gere muitas requisições).
-- Pré-requisitos: fase2-pedido-e-agenda.sql (agenda_ocupacao, agenda_ocupacao_atualizar, chat_valida). Aditivo: tabelas e funções novas e 4 chaves em config; nada existente muda de comportamento até o chat novo (index.html) ser publicado.
-- Chaves: agenda_ao_vivo (sim|nao: interruptor geral), agenda_ao_vivo_validade_s (15: leitura mais nova que isso é reaproveitada; 0 = sempre ler), agenda_ao_vivo_trava_s (40: leitura "em andamento" mais velha que isso é dada como perdida), agenda_ao_vivo_max_dias (14: teto de dias sendo lidos ao mesmo tempo no Klingo).
-- Sem dado de paciente: só quando, quem atende, onde e qual exame (igual à leitura geral da ocupação).
-- DESLIGAR: update public.config set valor = 'nao' where chave = 'agenda_ao_vivo';  (o chat volta a mostrar o que o banco já tem, com aviso)
-- ROLLBACK: drop function public.chat_ao_vivo_validar(uuid, text, date, date), public.agenda_ao_vivo_pedir(date[]), public.agenda_ao_vivo_gravar(date, date, date[], timestamptz, jsonb, boolean, text); drop table public.agenda_ao_vivo, public.agenda_ao_vivo_pedido;

insert into public.config (chave, valor) values
  ('agenda_ao_vivo', 'sim'), ('agenda_ao_vivo_validade_s', '15'), ('agenda_ao_vivo_trava_s', '40'), ('agenda_ao_vivo_max_dias', '14')
on conflict (chave) do nothing;

-- Controle por dia: quando foi lido pela última vez com sucesso e se alguém está lendo agora.
create table if not exists public.agenda_ao_vivo (
  dia date primary key,
  lendo_desde timestamptz,
  lido_em timestamptz,
  ok boolean not null default false,
  erro text,
  atualizado_em timestamptz not null default now()
);
comment on table public.agenda_ao_vivo is 'Leitura ao vivo da agenda do Klingo, por dia: lido_em = quando a última leitura bem-sucedida COMEÇOU; lendo_desde = leitura em andamento (uma por dia). Sem dado de paciente. Só funções do banco e service_role.';
alter table public.agenda_ao_vivo enable row level security;
revoke all on public.agenda_ao_vivo from anon, authenticated;

-- Pedidos por conversa (limite contra abuso).
create table if not exists public.agenda_ao_vivo_pedido (
  conversa_id uuid not null,
  em timestamptz not null default now()
);
create index if not exists agenda_ao_vivo_pedido_conversa on public.agenda_ao_vivo_pedido (conversa_id, em desc);
create index if not exists agenda_ao_vivo_pedido_em on public.agenda_ao_vivo_pedido (em);
alter table public.agenda_ao_vivo_pedido enable row level security;
revoke all on public.agenda_ao_vivo_pedido from anon, authenticated;

create or replace function public.agenda_ao_vivo_inteiro(p_chave text, p_padrao integer, p_min integer, p_max integer) returns integer
language sql stable security definer set search_path to '' as $$
  select coalesce((select case when valor ~ '^[0-9]{1,6}$' and valor::int between p_min and p_max then valor::int end from public.config where chave = p_chave), p_padrao)
$$;
revoke all on function public.agenda_ao_vivo_inteiro(text, integer, integer, integer) from public, anon, authenticated;

-- 1) Quem pode pedir: a dona da conversa (token), com o interruptor ligado e dentro dos limites.
create or replace function public.chat_ao_vivo_validar(p_conversa uuid, p_token text, p_de date, p_ate date) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_hoje date := (now() at time zone 'America/Bahia')::date; v_n integer;
begin
  perform public.chat_valida(p_conversa, p_token);
  if coalesce((select valor from public.config where chave = 'agenda_ao_vivo'), 'sim') <> 'sim' then
    return jsonb_build_object('ok', false, 'motivo', 'desligado');
  end if;
  if p_de is null or p_ate is null or p_ate < p_de or p_ate - p_de > 14 or p_de < v_hoje - 1 or p_ate > v_hoje + 62 then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  select count(*) into v_n from public.agenda_ao_vivo_pedido where conversa_id = p_conversa and em > now() - interval '10 minutes';
  if v_n >= 40 then return jsonb_build_object('ok', false, 'motivo', 'limite'); end if;
  insert into public.agenda_ao_vivo_pedido (conversa_id) values (p_conversa);
  if random() < 0.05 then delete from public.agenda_ao_vivo_pedido where em < now() - interval '1 day'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.chat_ao_vivo_validar(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.chat_ao_vivo_validar(uuid, text, date, date) to service_role;

-- 2) Para cada dia: 'fresco' (já lido há pouco), 'lendo' (outra chamada está lendo), 'ler' (esta chamada lê agora) ou 'ocupado' (teto global).
create or replace function public.agenda_ao_vivo_pedir(p_dias date[]) returns table (dia_ref date, acao text, lido timestamptz, iniciado timestamptz)
language plpgsql security definer set search_path to '' as $$
declare
  d date; r public.agenda_ao_vivo%rowtype; v_agora timestamptz := clock_timestamp(); v_lendo integer;
  v_val integer := public.agenda_ao_vivo_inteiro('agenda_ao_vivo_validade_s', 15, 0, 3600);
  v_trava integer := public.agenda_ao_vivo_inteiro('agenda_ao_vivo_trava_s', 40, 5, 600);
  v_max integer := public.agenda_ao_vivo_inteiro('agenda_ao_vivo_max_dias', 14, 1, 62);
begin
  if p_dias is null or cardinality(p_dias) = 0 or cardinality(p_dias) > 15 then raise exception 'Dias inválidos.' using errcode = '22023'; end if;
  foreach d in array p_dias loop
    insert into public.agenda_ao_vivo (dia) values (d) on conflict do nothing;
    select * into r from public.agenda_ao_vivo a where a.dia = d for update;
    dia_ref := d; lido := r.lido_em; iniciado := null;
    if v_val > 0 and r.ok and r.lido_em is not null and r.lido_em > v_agora - make_interval(secs => v_val) then
      acao := 'fresco';
    elsif r.lendo_desde is not null and r.lendo_desde > v_agora - make_interval(secs => v_trava) then
      acao := 'lendo';
    else
      select count(*) into v_lendo from public.agenda_ao_vivo a where a.lendo_desde is not null and a.lendo_desde > v_agora - make_interval(secs => v_trava);
      if v_lendo >= v_max then
        acao := 'ocupado';
      else
        update public.agenda_ao_vivo a set lendo_desde = v_agora, atualizado_em = now() where a.dia = d;
        acao := 'ler'; iniciado := v_agora;
      end if;
    end if;
    return next;
  end loop;
end $$;
revoke all on function public.agenda_ao_vivo_pedir(date[]) from public, anon, authenticated;
grant execute on function public.agenda_ao_vivo_pedir(date[]) to service_role;

-- 3) Grava o que o Klingo mostrou para o período: atualiza a ocupação e LIBERA o que sumiu (cancelamento), com trava de segurança.
--    p_iniciado = o instante em que a leitura COMEÇOU (devolvido por agenda_ao_vivo_pedir): só some o que ninguém viu depois disso.
--    VIGENTE = linha confirmada pela última leitura geral (visto_em >= valido_desde); as mais velhas já são ignoradas pela lista de horários
--    (e se acumulavam sem limpeza: 2.586 linhas, 387 vigentes em 10/11/2026), então a trava só conta as VIGENTES e a leitura ao vivo limpa as velhas do período.
create or replace function public.agenda_ao_vivo_gravar(p_de date, p_ate date, p_dias date[], p_iniciado timestamptz, p_linhas jsonb, p_ok boolean, p_erro text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_novas integer := 0; v_cand integer := 0; v_vistas integer := 0; v_removidas integer := 0; v_velhas integer := 0; v_suspeito boolean := false; v_res jsonb; v_valido timestamptz;
begin
  if p_de is null or p_ate is null or p_ate < p_de or p_ate - p_de > 14 or p_iniciado is null or p_dias is null then raise exception 'Parâmetros inválidos.' using errcode = '22023'; end if;
  if not coalesce(p_ok, false) then
    update public.agenda_ao_vivo a set lendo_desde = null, ok = false, erro = left(coalesce(p_erro, 'falha'), 200), atualizado_em = now() where a.dia = any (p_dias);
    return jsonb_build_object('ok', false);
  end if;
  v_novas := case when p_linhas is not null and jsonb_typeof(p_linhas) = 'array' then jsonb_array_length(p_linhas) else 0 end;
  v_res := public.agenda_ocupacao_atualizar(case when v_novas > 0 then p_linhas else '[]'::jsonb end, null, false);
  select m.valido_desde into v_valido from public.agenda_ocupacao_meta m where m.id = 1;
  select count(*) filter (where o.visto_em < p_iniciado and (v_valido is null or o.visto_em >= v_valido)), count(*) filter (where o.visto_em >= p_iniciado)
    into v_cand, v_vistas
    from public.agenda_ocupacao o
   where o.fonte = 'marcada' and o.inicio >= p_de::timestamp and o.inicio < (p_ate + 1)::timestamp;
  -- Limpeza: linhas velhas (já ignoradas) do período saem sempre.
  if v_valido is not null then
    delete from public.agenda_ocupacao o
     where o.fonte = 'marcada' and o.inicio >= p_de::timestamp and o.inicio < (p_ate + 1)::timestamp and o.visto_em < v_valido and o.visto_em < p_iniciado;
    get diagnostics v_velhas = row_count;
  end if;
  -- Trava: relatório vazio ou que "perdeu" mais da metade das vigentes não libera nada (a leitura geral de 10 min corrige depois).
  if v_cand > 2 and (v_vistas = 0 or (v_cand > 5 and v_cand > v_vistas)) then
    v_suspeito := true;
  elsif v_cand > 0 then
    delete from public.agenda_ocupacao o
     where o.fonte = 'marcada' and o.inicio >= p_de::timestamp and o.inicio < (p_ate + 1)::timestamp and o.visto_em < p_iniciado;
    get diagnostics v_removidas = row_count;
  end if;
  update public.agenda_ao_vivo a set lendo_desde = null, lido_em = p_iniciado, ok = true, erro = case when v_suspeito then 'suspeito: nada liberado' end, atualizado_em = now()
   where a.dia = any (p_dias);
  return jsonb_build_object('ok', true, 'recebidas', v_novas, 'liberadas', v_removidas, 'velhas_limpas', v_velhas, 'suspeito', v_suspeito);
end $$;
revoke all on function public.agenda_ao_vivo_gravar(date, date, date[], timestamptz, jsonb, boolean, text) from public, anon, authenticated;
grant execute on function public.agenda_ao_vivo_gravar(date, date, date[], timestamptz, jsonb, boolean, text) to service_role;
