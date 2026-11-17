-- FLUXOGRAMA: entrada (a Edge Function `pmarc-cadastrar` lê o #14359 e o #14554 do Klingo e manda lotes enxutos; o pg_cron a chama a cada 10 min) -> validação (interruptor `previsao_marcacao_modo`; desligado = nada é gravado)
--   -> lógica (uma linha por pessoa, na MESMA chave da Jornada; o #14359 dá nome, celular e telefone; o #14554, achado pelo id da marcação, dá e-mail, nascimento e se tem CPF; o CPF em si NÃO é guardado)
--   -> saída (contagens, sem dado de paciente) | ROLLBACK: previsao-marcacao-rollback.sql
-- Versão 1.0 — 17/11/2026 / Mudança: primeira versão (registrar todas as pessoas com marcação).

create table if not exists public.pmarc_estado (
  id boolean primary key default true,
  completo_em timestamptz,
  rapido_em timestamptz,
  tentativa_em timestamptz,
  resultado jsonb,
  erro text,
  constraint pmarc_estado_uma_linha check (id)
);
comment on table public.pmarc_estado is 'Última leitura do Klingo feita para o canal Previsão de marcação (uma linha). Só contagens.';
insert into public.pmarc_estado (id) values (true) on conflict (id) do nothing;
alter table public.pmarc_estado enable row level security;
revoke all on public.pmarc_estado from anon, authenticated;

-- Lote do #14359: { p: chave da Jornada, n: nome, c: celular, t: telefone, v: 'S'|'N' (primeira vez) }. Só marcações ABERTAS chegam aqui (a Edge Function filtra o Status).
create or replace function public.pmarc_lote(p_linhas jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_lidas integer := 0; v_novas integer := 0; v_mudou integer := 0; v_n integer; v_nova boolean;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ligada', false, 'lidas', 0); end if;
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'O lote precisa ser uma lista.' using errcode = '22023'; end if;
  for r in select x from jsonb_array_elements(p_linhas) x loop
    if coalesce(btrim(r ->> 'p'), '') = '' then continue; end if;
    v_nova := null;
    insert into public.pmarc_pessoa as pp (chave, nome, celular, telefone, primeira_vez)
    values (left(btrim(r ->> 'p'), 60), nullif(left(btrim(coalesce(r ->> 'n', '')), 120), ''), public.pmarc_telefone(r ->> 'c'), public.pmarc_telefone(r ->> 't'),
            case upper(btrim(coalesce(r ->> 'v', ''))) when 'S' then true when 'N' then false end)
    on conflict (chave) do update set
      nome = coalesce(excluded.nome, pp.nome), celular = coalesce(excluded.celular, pp.celular), telefone = coalesce(excluded.telefone, pp.telefone),
      primeira_vez = coalesce(excluded.primeira_vez, pp.primeira_vez), atualizado_em = now()
    where (pp.nome, pp.celular, pp.telefone, pp.primeira_vez) is distinct from
          (coalesce(excluded.nome, pp.nome), coalesce(excluded.celular, pp.celular), coalesce(excluded.telefone, pp.telefone), coalesce(excluded.primeira_vez, pp.primeira_vez))
    returning (xmax = 0) into v_nova;
    get diagnostics v_n = row_count;
    v_mudou := v_mudou + v_n;
    if v_nova then v_novas := v_novas + 1; end if;
    v_lidas := v_lidas + 1;
  end loop;
  return jsonb_build_object('ligada', true, 'lidas', v_lidas, 'novas', v_novas, 'alteradas', v_mudou);
end $$;

-- Lote do #14554, achado pelo id da marcação (a mesma da Jornada): { m: id da marcação, c: celular, t: telefone, e: e-mail, d: nascimento AAAA-MM-DD, k: true se o Klingo tem CPF }.
-- Só PREENCHE o que está vazio; nunca apaga nem troca o que a pessoa corrigiu (isso fica em `informado`). Pessoa que ainda não existe aqui é ignorada (vem pelo #14359).
create or replace function public.pmarc_enriquecer_lote(p_linhas jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_lidas integer; v_ach integer; v_alt integer;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ligada', false, 'lidas', 0); end if;
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'O lote precisa ser uma lista.' using errcode = '22023'; end if;
  select count(*) into v_lidas from jsonb_array_elements(p_linhas);
  with linhas as (
    select c.paciente_chave as chave, public.pmarc_telefone(l.x ->> 'c') as celular, public.pmarc_telefone(l.x ->> 't') as telefone,
           case when lower(btrim(coalesce(l.x ->> 'e', ''))) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(l.x ->> 'e') <= 200 then lower(btrim(l.x ->> 'e')) end as email,
           case when coalesce(l.x ->> 'd', '') ~ '^\d{4}-\d{2}-\d{2}$' and (l.x ->> 'd')::date between date '1900-01-01' and current_date then (l.x ->> 'd')::date end as nascimento,
           coalesce((l.x ->> 'k')::boolean, false) as tem_cpf
    from jsonb_array_elements(p_linhas) l(x)
    join public.jornada_exame e on e.marcacao_id = 'm' || btrim(l.x ->> 'm')
    join public.jornada_card c on c.id = e.card_id),
  s as (
    -- uma pessoa aparece em várias linhas (uma por marcação): junta o que cada linha trouxe
    select chave, max(celular) as celular, max(telefone) as telefone, max(email) as email, max(nascimento) as nascimento, bool_or(tem_cpf) as tem_cpf
    from linhas group by chave),
  u as (
    update public.pmarc_pessoa pp set
      celular = coalesce(pp.celular, s.celular), telefone = coalesce(pp.telefone, s.telefone), email = coalesce(pp.email, s.email),
      nascimento = coalesce(pp.nascimento, s.nascimento), tem_cpf = pp.tem_cpf or s.tem_cpf, atualizado_em = now()
    from s
    where pp.chave = s.chave
      and (pp.celular, pp.telefone, pp.email, pp.nascimento, pp.tem_cpf) is distinct from
          (coalesce(pp.celular, s.celular), coalesce(pp.telefone, s.telefone), coalesce(pp.email, s.email), coalesce(pp.nascimento, s.nascimento), pp.tem_cpf or s.tem_cpf)
    returning 1)
  select (select count(*) from s), (select count(*) from u) into v_ach, v_alt;
  return jsonb_build_object('ligada', true, 'lidas', v_lidas, 'achadas', v_ach, 'alteradas', v_alt);
end $$;

-- A Edge Function registra como foi (só contagens ou um erro curto).
create or replace function public.pmarc_estado_gravar(p_modo text, p_resultado jsonb default null, p_erro text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.pmarc_estado set
    completo_em = case when p_erro is null and p_modo = 'completo' then now() else completo_em end,
    rapido_em = case when p_erro is null and p_modo in ('rapido', 'completo') then now() else rapido_em end,
    resultado = case when p_erro is null then p_resultado else resultado end,
    erro = left(p_erro, 300)
  where id;
end $$;

-- Chama a Edge Function (pg_net). Modos: rapido (7 dias à frente), completo (1 ano à frente), enriquecer (#14554 de uma faixa {de, ate}, no máximo 31 dias).
create or replace function public.pmarc_disparar(p_modo text default 'rapido', p_extra jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if p_modo not in ('rapido', 'completo', 'enriquecer') then raise exception 'Modo inválido.' using errcode = '22023'; end if;
  update public.pmarc_estado set tentativa_em = now() where id;
  select net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/pmarc-cadastrar',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := jsonb_build_object('modo', p_modo) || coalesce(p_extra, '{}'::jsonb),
    timeout_milliseconds := 120000) into v_id;
  return v_id;
end $$;

-- A rotina: a cada 10 min. Desligado = não faz nada. Completo se faz mais de 60 min que não houve (ou nunca houve); senão rápido.
create or replace function public.pmarc_vigiar() returns text
language plpgsql security definer set search_path = '' as $$
declare e public.pmarc_estado%rowtype; v_modo text;
begin
  if not public.pmarc_ligada() then return 'desligada'; end if;
  perform pg_advisory_xact_lock(hashtext('pmarc_vigiar'));
  select * into e from public.pmarc_estado where id;
  if e.tentativa_em is not null and e.tentativa_em > now() - interval '3 minutes' then return 'em andamento'; end if;
  v_modo := case when e.completo_em is null or e.completo_em < now() - interval '60 minutes' then 'completo' else 'rapido' end;
  perform public.pmarc_disparar(v_modo);
  return v_modo;
end $$;

-- Painel: quando foi a última leitura (para a equipe saber se o registro está andando).
create or replace function public.painel_pmarc_estado() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê a previsão.' using errcode = '42501'; end if;
  return (select jsonb_build_object('completo_em', completo_em, 'rapido_em', rapido_em, 'erro', erro, 'resultado', resultado) from public.pmarc_estado where id);
end $$;

do $$
declare f text;
begin
  foreach f in array array['pmarc_lote(jsonb)', 'pmarc_enriquecer_lote(jsonb)', 'pmarc_estado_gravar(text, jsonb, text)', 'pmarc_disparar(text, jsonb)', 'pmarc_vigiar()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  revoke all on function public.painel_pmarc_estado() from public, anon;
  grant execute on function public.painel_pmarc_estado() to authenticated, service_role;
end $$;

-- Rotina (só no banco real, onde existe o pg_cron): a cada 10 minutos.
do $$
begin
  if to_regnamespace('cron') is not null and not exists (select 1 from cron.job where jobname = 'pmarc-cadastrar') then
    perform cron.schedule('pmarc-cadastrar', '*/10 * * * *', 'select public.pmarc_vigiar()');
  end if;
end $$;
