-- Autoatendimento com a API do Klingo — Parte 3: identidade (CPF + nascimento conferidos na API) e revisão dos pacientes antigos. Escrito em 12/11/2026.
--
-- FLUXOGRAMA: o paciente informa CPF + nascimento (passo novo "cpf_nasc") -> gatilho conversa_fluxo_klingo_trg -> klingo_identificar_agendar -> Edge Function klingo-identificar
--   (GET /paciente/cpf, confere o nascimento) -> klingo_identidade_registrar grava SÓ hash + id + situação em klingo_identidade, liga o pedido (pre_agendamentos.klingo_paciente_id)
--   e deixa uma nota para a equipe. Os pacientes ANTIGOS (CPF + nascimento já gravados) passam pelo mesmo caminho em lotes: klingo_revisao_pendentes lista, a função confere, klingo_identidade_registrar grava.
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão.
-- NÃO sobrescreve paciente_klingo_vinculo.prontuario: aquele número vem do relatório e é o que o klingo-reconhecer usa para casar marcações; o id da API (P123) fica só em klingo_identidade.
-- Para voltar atrás: drop function public.klingo_identidade_registrar(text, date, jsonb, uuid), klingo_revisao_pendentes(integer), klingo_identificar_agendar(uuid), klingo_dados_conversa(uuid);
--   e recolocar conversa_fluxo_klingo_trg como está em supabase/producao/funcoes/conversa_fluxo_klingo_trg.sql.

-- Guarda qual par CPF+nascimento já foi mandado conferir em cada conversa (evita chamar a API a cada passo do chat e repetir notas).
create table if not exists public.klingo_conversa_ident (
  conversa_id uuid primary key references public.conversas (id) on delete cascade,
  chave text not null,
  em timestamptz not null default now()
);
alter table public.klingo_conversa_ident enable row level security;

-- Grava o resultado da conferência. p_r = {situacao, klingo_id, faltando[], plano_id}. Com p_conversa, deixa nota para a equipe (conversa viva).
create or replace function public.klingo_identidade_registrar(p_cpf text, p_nasc date, p_r jsonb, p_conversa uuid default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'); v_chave text; v_hash text; v_sit text := coalesce(p_r ->> 'situacao', 'erro');
  v_id text := nullif(p_r ->> 'klingo_id', ''); v_tipo text; v_falta text[]; v_plano integer; v_ex public.klingo_identidade; v_n integer := 0; v_nota text; v_pront text; r record; v_cmp text;
begin
  if not public.fluxo_cpf_ok(v_cpf) or p_nasc is null then raise exception 'CPF ou nascimento inválido' using errcode = '22023'; end if;
  if v_sit not in ('confere', 'divergente', 'nao_encontrado', 'sem_id_definitivo', 'erro') then v_sit := 'erro'; end if;
  v_chave := public.klingo_hash(v_cpf || '|' || p_nasc::text); v_hash := public.klingo_hash(v_cpf);
  v_tipo := case when v_sit = 'confere' and v_id ~ '^P[0-9]+$' then 'definitivo' end;
  if v_tipo is null then v_id := null; end if;
  v_falta := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p_r -> 'faltando') = 'array' then p_r -> 'faltando' else '[]'::jsonb end)), '{}');
  v_plano := case when (p_r ->> 'plano_id') ~ '^[0-9]{1,9}$' then (p_r ->> 'plano_id')::integer end;
  select * into v_ex from public.klingo_identidade where chave = v_chave;
  -- Falha de rede não apaga uma conferência boa; pré-cadastro já criado não some só porque a busca por CPF não o enxerga.
  if v_ex.id is not null and ((v_sit = 'erro' and v_ex.situacao in ('confere', 'pre_cadastro')) or (v_ex.tipo = 'pre' and v_sit <> 'confere')) then
    update public.klingo_identidade set conferido_em = now() where id = v_ex.id;
    v_sit := v_ex.situacao; v_id := v_ex.klingo_id; v_tipo := v_ex.tipo; v_falta := v_ex.faltando; v_plano := v_ex.plano_id;
  else
    insert into public.klingo_identidade (chave, cpf_hash, tipo, klingo_id, situacao, faltando, plano_id, conferido_em)
    values (v_chave, v_hash, v_tipo, v_id, v_sit, v_falta, v_plano, now())
    on conflict (chave) do update set tipo = excluded.tipo, klingo_id = excluded.klingo_id, situacao = excluded.situacao, faltando = excluded.faltando,
      plano_id = excluded.plano_id, conferido_em = now(),
      convertido_em = case when public.klingo_identidade.tipo = 'pre' and excluded.tipo = 'definitivo' then now() else public.klingo_identidade.convertido_em end;
  end if;

  if v_id is not null then
    -- liga os pedidos (e a pessoa unificada) ao cadastro do Klingo
    update public.pre_agendamentos set klingo_paciente_id = v_id
     where klingo_paciente_id is distinct from v_id and regexp_replace(coalesce(paciente ->> 'cpf', ''), '\D', '', 'g') = v_cpf and public.fluxo_ler_data(paciente ->> 'dt_nasc') = p_nasc;
    get diagnostics v_n = row_count;
    update public.pacientes set dados = jsonb_set(coalesce(dados, '{}'::jsonb), '{klingo}', jsonb_build_object('id', v_id, 'conferido_em', now()), true)
     where regexp_replace(coalesce(cpf, ''), '\D', '', 'g') = v_cpf and dt_nasc = p_nasc and (dados -> 'klingo' ->> 'id') is distinct from v_id;
    -- medida: o número do prontuário do relatório é o mesmo do id da API? (decide se um dia dá para usar o id da API no reconhecimento)
    for r in select v.prontuario from public.paciente_klingo_vinculo v join public.pre_agendamentos pa on pa.conversa_id = v.conversa_id
              where v.situacao = 'confere' and nullif(v.prontuario, '') is not null and regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g') = v_cpf limit 1 loop
      perform public.klingo_medir(case when r.prontuario = substr(v_id, 2) then 'prontuario_igual_id_api' else 'prontuario_diferente_id_api' end);
    end loop;
  end if;

  -- situação por conversa (sem mexer no prontuário do relatório e sem rebaixar quem o relatório já confirmou)
  update public.paciente_klingo_vinculo v set situacao = case v_sit when 'sem_id_definitivo' then 'ambiguo' else v_sit end, cadastro_faltando = v_falta, verificado_em = now()
   where v.situacao <> 'confere' and v_sit <> 'erro'
     and v.conversa_id in (select pa.conversa_id from public.pre_agendamentos pa where regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g') = v_cpf and public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') = p_nasc);

  if p_conversa is not null then
    v_nota := case v_sit
      when 'confere' then 'Klingo (API): cadastro localizado e nascimento conferido.'
      when 'divergente' then 'Klingo (API): o CPF existe, mas a data de nascimento NÃO confere. Conferir o documento antes de usar o cadastro.'
      when 'nao_encontrado' then 'Klingo (API): CPF não encontrado. Paciente novo (o sistema cria o pré-cadastro na hora de marcar).'
      when 'sem_id_definitivo' then 'Klingo (API): o CPF aparece, mas sem cadastro definitivo. Verificar duplicidade.'
      else null end;
    if v_nota is not null and not exists (select 1 from public.conversa_fluxo f where f.conversa_id = p_conversa and f.dados -> 'notas' ? left(v_nota, 300)) then perform public.fluxo_nota(p_conversa, v_nota); end if;
    if v_sit = 'confere' and cardinality(v_falta) > 0 then
      v_nota := 'Cadastro no Klingo sem: ' || array_to_string(v_falta, ', ') || '. Pedir ao paciente e atualizar.';
      if not exists (select 1 from public.conversa_fluxo f where f.conversa_id = p_conversa and f.dados -> 'notas' ? left(v_nota, 300)) then perform public.fluxo_nota(p_conversa, v_nota); end if;
    end if;
  end if;
  perform public.klingo_medir('identidade_' || v_sit);
  return jsonb_build_object('ok', true, 'situacao', v_sit, 'pedidos_ligados', v_n);
end $$;

-- Dados da conversa que as Edge Functions precisam (só service_role; nada disto vai para log).
create or replace function public.klingo_dados_conversa(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare pa public.pre_agendamentos; c public.conversas; ct public.contatos; v_cpf text; v_nasc date; v_i public.klingo_identidade; v_procs integer[]; v_n integer; v_proc integer;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select * into c from public.conversas where id = p_conversa;
  select * into ct from public.contatos where id = c.contato_id;
  v_cpf := regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g');
  v_nasc := public.fluxo_ler_data(pa.paciente ->> 'dt_nasc');
  if public.fluxo_cpf_ok(v_cpf) and v_nasc is not null then
    select * into v_i from public.klingo_identidade where chave = public.klingo_hash(v_cpf || '|' || v_nasc::text);
  end if;
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  v_n := coalesce(cardinality(v_procs), 0); v_proc := v_procs[1];
  return jsonb_build_object(
    'tipo', pa.tipo, 'plano', pa.plano, 'pre_agendamento_id', pa.id, 'status', pa.status, 'procedimentos', coalesce(to_jsonb(v_procs), '[]'::jsonb), 'n_procedimentos', v_n, 'procedimento', v_proc,
    'cpf', case when public.fluxo_cpf_ok(v_cpf) then v_cpf end, 'nascimento', v_nasc,
    'nome', nullif(btrim(pa.paciente ->> 'nome'), ''), 'sexo', nullif(btrim(pa.paciente ->> 'sexo'), ''), 'mae', nullif(btrim(pa.paciente ->> 'mae'), ''),
    'celular', coalesce(nullif(regexp_replace(coalesce(pa.paciente ->> 'celular', ''), '\D', '', 'g'), ''), regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g')),
    'email', nullif(btrim(pa.paciente ->> 'email'), ''),
    'teste', coalesce(c.teste, false),
    'identidade', case when v_i.id is null then null else jsonb_build_object('situacao', v_i.situacao, 'tipo', v_i.tipo, 'klingo_id', v_i.klingo_id, 'plano_id', v_i.plano_id, 'conferido_em', v_i.conferido_em) end);
end $$;

-- Lista (em lotes) quem já deixou CPF + nascimento e ainda não foi conferido na API.
create or replace function public.klingo_revisao_pendentes(p_limite integer default 25) returns jsonb
language sql stable security definer set search_path to '' as $$
  with fontes as (
    select regexp_replace(coalesce(paciente ->> 'cpf', ''), '\D', '', 'g') as cpf, public.fluxo_ler_data(paciente ->> 'dt_nasc') as nasc from public.pre_agendamentos
    union
    select regexp_replace(coalesce(cpf, ''), '\D', '', 'g'), dt_nasc from public.pacientes
  ), validos as (
    select distinct cpf, nasc from fontes where nasc between date '1900-01-01' and current_date and public.fluxo_cpf_ok(cpf)
  ), pend as (
    select v.cpf, v.nasc from validos v left join public.klingo_identidade i on i.chave = public.klingo_hash(v.cpf || '|' || v.nasc::text)
     where i.id is null or (i.situacao = 'erro' and i.conferido_em < now() - interval '30 minutes')
     order by v.nasc, v.cpf limit least(greatest(coalesce(p_limite, 25), 1), 100)
  )
  select coalesce(jsonb_agg(jsonb_build_object('cpf', cpf, 'nascimento', nasc)), '[]'::jsonb) from pend
$$;

-- Conferência de uma conversa viva: se o par CPF+nascimento já foi conferido há menos de 1 dia, só liga; senão pede à Edge Function.
create or replace function public.klingo_identificar_agendar(p_conversa uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare d jsonb; v_cpf text; v_dt date; v_base text; v_seg text; v_i public.klingo_identidade; v_chave text; v_novo uuid;
begin
  select dados -> 'digitado' into d from public.conversa_fluxo where conversa_id = p_conversa;
  v_cpf := regexp_replace(coalesce(d ->> 'cpf', ''), '\D', '', 'g');
  if not public.fluxo_cpf_ok(v_cpf) then return; end if;
  v_dt := public.fluxo_ler_data(d ->> 'dt_nasc');
  if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then return; end if;
  v_chave := public.klingo_hash(v_cpf || '|' || v_dt::text);
  insert into public.klingo_conversa_ident (conversa_id, chave) values (p_conversa, v_chave)
    on conflict (conversa_id) do update set chave = excluded.chave, em = now() where public.klingo_conversa_ident.chave is distinct from excluded.chave
    returning conversa_id into v_novo;
  if v_novo is null then return; end if;   -- este par já foi mandado conferir nesta conversa
  select * into v_i from public.klingo_identidade where chave = v_chave;
  if v_i.id is not null and v_i.conferido_em > now() - interval '1 day' and v_i.situacao <> 'erro' then
    perform public.klingo_identidade_registrar(v_cpf, v_dt, jsonb_build_object('situacao', v_i.situacao, 'klingo_id', v_i.klingo_id, 'faltando', to_jsonb(v_i.faltando), 'plano_id', v_i.plano_id), p_conversa);
    return;
  end if;
  v_base := public.klingo_cfg('klingo_funcoes_base', ''); v_seg := public.klingo_segredo();
  if v_base = '' or v_seg is null then return; end if;
  perform net.http_post(url := v_base || 'klingo-identificar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', 'conferir', 'cpf', v_cpf, 'nascimento', v_dt::text, 'conversa', p_conversa), timeout_milliseconds := 30000);
exception when others then null;
end $$;

-- O gatilho do fluxo passa a conferir pelos dois caminhos: API (nova) e relatório (a que já existia; dá o prontuário e o histórico).
create or replace function public.conversa_fluxo_klingo_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.dados -> 'digitado' ? 'cpf' and new.dados -> 'digitado' ? 'dt_nasc' then
    begin perform public.klingo_identificar_agendar(new.conversa_id); exception when others then null; end;
    begin perform public.klingo_conferir_agendar(new.conversa_id); exception when others then null; end;
  end if;
  return new;
exception when others then
  return new;
end $$;

do $$ declare f text; begin
  for f in select unnest(array['klingo_identidade_registrar(text, date, jsonb, uuid)', 'klingo_dados_conversa(uuid)', 'klingo_revisao_pendentes(integer)', 'klingo_identificar_agendar(uuid)', 'conversa_fluxo_klingo_trg()']) loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
