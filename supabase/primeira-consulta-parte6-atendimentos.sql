-- FLUXOGRAMA: entrada (a Edge Function sync-atendimentos-klingo lê o relatório #14637 do Klingo: atendimentos já feitos com CPF, nascimento, prontuário e profissional) -> validação (CPF válido, nascimento e data válidos; profissional preenchido) -> lógica (consulta_atendida_lote guarda só o HASH de CPF+nascimento, o prontuário, o profissional e o dia; primeira_consulta_ok procura o paciente pela mesma chave que o chat usa) -> saída (tem histórico com a médica = marca sozinho; não tem = atendente)
-- Versão 1.0 — 16/11/2026 / Mudança: o #14637 (criado pelo dono) traz CPF + nascimento + profissional dos atendimentos de qualquer data, então vira a fonte principal do histórico. O CPF não é guardado (só o hash com o sal do cofre, o mesmo de klingo_identidade). Idempotente; sem "drop".
-- ROLLBACK: select cron.unschedule('consulta-atendida-sync'); update public.config set valor = 'nao' where chave = 'primeira_consulta_modo'; e recriar primeira_consulta_ok pela parte 2.

-- ===== Parte 6a: coluna da chave e prontuário opcional =====
alter table public.consulta_feita add column if not exists chave text;
alter table public.consulta_feita alter column prontuario drop not null;
create index if not exists consulta_feita_chave_idx on public.consulta_feita (chave) where chave is not null;

-- ===== Parte 6b: gravação do lote (só a Edge Function, como service_role) =====
-- p_linhas: [{c: cpf, n: 'AAAA-MM-DD', p: prontuário, q: profissional, d: 'AAAA-MM-DD'}]
create or replace function public.consulta_atendida_lote(p_linhas jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $f$
declare r jsonb; v_cpf text; v_nasc date; v_dia date; v_chave text; v_q text; n integer := 0; v integer;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'O lote precisa ser uma lista.'; end if;
  for r in select x from jsonb_array_elements(p_linhas) x loop
    v_cpf := regexp_replace(coalesce(r ->> 'c', ''), '\D', '', 'g');
    v_q := left(btrim(coalesce(r ->> 'q', '')), 120);
    if not public.fluxo_cpf_ok(v_cpf) or v_q = '' or coalesce(r ->> 'n', '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(r ->> 'd', '') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
    v_nasc := (r ->> 'n')::date; v_dia := (r ->> 'd')::date;
    v_chave := public.klingo_hash(v_cpf || '|' || v_nasc::text);    -- a mesma conta de klingo_dados_conversa / klingo_identidade
    insert into public.consulta_feita (marcacao_id, prontuario, profissional, procedimento, atendido_em, chave)
    values ('a:' || left(md5(v_chave || '|' || coalesce(public.norm_nome(v_q), '') || '|' || v_dia::text), 30), nullif(left(btrim(coalesce(r ->> 'p', '')), 40), ''), v_q, null, v_dia, v_chave)
    on conflict (marcacao_id) do nothing;
    get diagnostics v = row_count; n := n + v;
  end loop;
  return jsonb_build_object('gravadas', n);
end $f$;
revoke all on function public.consulta_atendida_lote(jsonb) from public, anon, authenticated;
grant execute on function public.consulta_atendida_lote(jsonb) to service_role;

-- ===== Parte 6c: a regra passa a procurar pela chave de CPF + nascimento primeiro =====
create or replace function public.primeira_consulta_ok(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $f$
declare
  v_lista text[]; v_pref text; v_jogo text[]; pa public.pre_agendamentos; v_pront text; v_chave text; d jsonb; v_cpf text; v_nasc date;
begin
  if coalesce((select valor from public.config where chave = 'primeira_consulta_modo'), 'nao') <> 'sim' then return jsonb_build_object('bloqueia', false, 'motivo', 'desligado'); end if;
  select coalesce(array_agg(public.norm_nome(x)) filter (where public.norm_nome(x) is not null), '{}') into v_lista
    from unnest(string_to_array(coalesce((select valor from public.config where chave = 'primeira_consulta_medicas'), ''), ';')) x;
  if cardinality(v_lista) = 0 then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_medica_na_lista'); end if;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if pa.tipo is distinct from 'consulta' then return jsonb_build_object('bloqueia', false, 'motivo', 'nao_e_consulta'); end if;
  select public.norm_nome(c.medico_preferido) into v_pref from public.conversas c where c.id = p_conversa;
  if v_pref is not null then
    v_jogo := case when v_pref = any (v_lista) then array[v_pref] else '{}'::text[] end;
  else
    select coalesce(array_agg(n) filter (where n = any (v_lista)), '{}') into v_jogo
      from (select public.norm_nome(m) as n from unnest(coalesce(public.fluxo_medicos(p_conversa), '{}'::text[])) m) t;
  end if;
  if cardinality(v_jogo) = 0 then return jsonb_build_object('bloqueia', false, 'motivo', 'medica_nao_controlada'); end if;
  if coalesce((select f.dados ->> 'primeira_liberada' = 'true' from public.conversa_fluxo f where f.conversa_id = p_conversa), false) then
    return jsonb_build_object('bloqueia', false, 'motivo', 'liberada');
  end if;
  begin
    d := public.klingo_dados_conversa(p_conversa); v_cpf := d ->> 'cpf'; v_nasc := (d ->> 'nascimento')::date;
    if v_cpf is not null and v_nasc is not null then v_chave := public.klingo_hash(v_cpf || '|' || v_nasc::text); end if;
  exception when others then v_chave := null;
  end;
  if v_chave is not null then
    if exists (select 1 from public.primeira_consulta_liberada l where l.chave = v_chave) then return jsonb_build_object('bloqueia', false, 'motivo', 'liberada'); end if;
    if exists (select 1 from public.consulta_feita c where c.chave = v_chave and public.norm_nome(c.profissional) = any (v_jogo)) then return jsonb_build_object('bloqueia', false, 'motivo', 'tem_historico'); end if;
  end if;
  -- reserva: atendimento guardado só pelo prontuário (leitura do #14359) e o vínculo CPF + nascimento da conversa
  select v.prontuario into v_pront from public.paciente_klingo_vinculo v where v.conversa_id = p_conversa and v.situacao = 'confere' and v.prontuario is not null;
  if v_pront is not null and exists (select 1 from public.consulta_feita c where c.prontuario = v_pront and public.norm_nome(c.profissional) = any (v_jogo)) then
    return jsonb_build_object('bloqueia', false, 'motivo', 'tem_historico');
  end if;
  return jsonb_build_object('bloqueia', true, 'motivo', case when v_chave is null and v_pront is null then 'sem_vinculo' else 'sem_historico' end, 'medicas', to_jsonb(v_jogo));
end $f$;
revoke all on function public.primeira_consulta_ok(uuid) from public, anon, authenticated;
grant execute on function public.primeira_consulta_ok(uuid) to service_role;

-- ===== Parte 6d: rotina que chama a Edge Function (a cada 10 min em horário de expediente; com datas = carga do passado) =====
create or replace function public.consulta_atendida_disparar(p_de date default null, p_ate date default null) returns bigint
language plpgsql security definer set search_path to '' as $f$
declare v_id bigint;
begin
  if p_de is null and not public.jornada_klingo_expediente(now()) then return null; end if;
  select net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-atendimentos-klingo',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := case when p_de is null then '{}'::jsonb else jsonb_build_object('de', p_de, 'ate', p_ate) end,
    timeout_milliseconds := 120000) into v_id;
  return v_id;
exception when others then return null;
end $f$;
revoke all on function public.consulta_atendida_disparar(date, date) from public, anon, authenticated;
grant execute on function public.consulta_atendida_disparar(date, date) to service_role;

do $c$ begin
  if to_regnamespace('cron') is not null then
    perform cron.schedule('consulta-atendida-sync', '*/10 * * * *', 'select public.consulta_atendida_disparar()');
  end if;
exception when others then null;   -- ambiente sem pg_cron (clone de teste): a rotina é criada só na produção
end $c$;
