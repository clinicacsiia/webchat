-- FLUXOGRAMA: entrada (o paciente preenche CPF + data de nascimento no chat: conversa_fluxo.dados.digitado muda) -> validação (CPF com dígitos certos, data válida, e só se o par ainda não foi conferido) -> lógica (o gatilho chama a Edge Function klingo-paciente por pg_net; ela confere no Klingo e devolve o resultado por paciente_klingo_registrar) -> saída (vínculo conversa↔prontuário em paciente_klingo_vinculo e uma nota para a equipe no resumo da conversa)
-- Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial. Aplicar em PARTES (1, 2, 3), sem nenhum DROP.
-- O que fica gravado: situação, prontuário (só quando o nascimento confere), QUAIS campos do cadastro estão vazios (nunca o valor) e um resumo do histórico (contagem, data e nome do último exame).
-- Nome, telefone, e-mail e CPF do Klingo nunca são gravados. ROLLBACK: drop trigger conversa_fluxo_klingo_trg; drop table paciente_klingo_vinculo; drop das 3 funções.

-- ===== Parte 1: tabela e configuração =====
create table if not exists public.paciente_klingo_vinculo (
  conversa_id uuid primary key references public.conversas(id) on delete cascade,
  situacao text not null check (situacao in ('pendente', 'confere', 'divergente', 'nao_encontrado', 'ambiguo', 'erro')),
  prontuario text,
  cadastro_faltando text[] not null default '{}',
  historico jsonb,
  chave text not null,
  verificado_em timestamptz not null default now()
);
comment on table public.paciente_klingo_vinculo is 'Ligação conversa do chat ↔ prontuário do Klingo, conferida por CPF + nascimento (Edge Function klingo-paciente). Sem nome, telefone, e-mail ou CPF. Só service_role e funções security definer acessam.';
alter table public.paciente_klingo_vinculo enable row level security;
revoke all on public.paciente_klingo_vinculo from anon, authenticated;

insert into public.config (chave, valor) values ('klingo_paciente_url', 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-paciente') on conflict (chave) do nothing;   -- vazio = não confere no Klingo

-- ===== Parte 2: funções =====
create or replace function public.klingo_conferir_agendar(p_conversa uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare d jsonb; v_cpf text; v_dt date; v_url text; v_seg text; v_chave text;
begin
  select valor into v_url from public.config where chave = 'klingo_paciente_url';
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if coalesce(v_url, '') = '' or coalesce(v_seg, '') = '' then return; end if;
  select dados -> 'digitado' into d from public.conversa_fluxo where conversa_id = p_conversa;
  v_cpf := regexp_replace(coalesce(d ->> 'cpf', ''), '\D', '', 'g');
  if not public.fluxo_cpf_ok(v_cpf) then return; end if;
  v_dt := public.fluxo_ler_data(d ->> 'dt_nasc');
  if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then return; end if;
  v_chave := encode(sha256(convert_to(v_cpf || v_dt::text || v_seg, 'UTF8')), 'hex');
  if exists (select 1 from public.paciente_klingo_vinculo where conversa_id = p_conversa and chave = v_chave) then return; end if;   -- mesmo par já conferido
  insert into public.paciente_klingo_vinculo (conversa_id, situacao, chave) values (p_conversa, 'pendente', v_chave)
    on conflict (conversa_id) do update set situacao = 'pendente', prontuario = null, cadastro_faltando = '{}', historico = null, chave = v_chave, verificado_em = now();
  begin
    perform net.http_post(url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', v_seg),
      body := jsonb_build_object('acao', 'conferir', 'cpf', v_cpf, 'nascimento', v_dt::text, 'conversa', p_conversa), timeout_milliseconds := 60000);
  exception when others then
    update public.paciente_klingo_vinculo set situacao = 'erro', verificado_em = now() where conversa_id = p_conversa;
  end;
end $$;
revoke all on function public.klingo_conferir_agendar(uuid) from public, anon, authenticated;

-- Chamada só pela Edge Function (service_role). Grava o vínculo e deixa uma nota para a equipe.
create or replace function public.paciente_klingo_registrar(p_conversa uuid, p_resultado jsonb) returns void
language plpgsql security definer set search_path to '' as $$
declare r jsonb := coalesce(p_resultado, '{}'::jsonb); v_sit text; v_falta text[]; v_h jsonb := r -> 'historico'; v_nota text;
begin
  if not exists (select 1 from public.paciente_klingo_vinculo where conversa_id = p_conversa) then return; end if;
  v_sit := case when r ->> 'erro' is not null then 'erro'
                when not coalesce((r ->> 'encontrado')::boolean, false) then 'nao_encontrado'
                when coalesce((r ->> 'ambiguo')::boolean, false) then 'ambiguo'
                when coalesce((r ->> 'confere')::boolean, false) then 'confere' else 'divergente' end;
  select coalesce(array_agg(x), '{}') into v_falta from jsonb_array_elements_text(coalesce(r -> 'cadastro_faltando', '[]'::jsonb)) x;
  update public.paciente_klingo_vinculo set situacao = v_sit, prontuario = case when v_sit = 'confere' then left(r ->> 'prontuario', 20) end,
    cadastro_faltando = v_falta, historico = case when v_sit = 'confere' then v_h end, verificado_em = now() where conversa_id = p_conversa;
  v_nota := case v_sit
    when 'confere' then 'Klingo: cadastro localizado e nascimento conferido (prontuário ' || coalesce(r ->> 'prontuario', '?') || ')'
    when 'divergente' then 'Klingo: CPF existe, mas a data de nascimento NÃO confere. Conferir o documento antes de usar o cadastro'
    when 'ambiguo' then 'Klingo: o CPF aparece em mais de um prontuário. Verificar cadastro duplicado'
    when 'nao_encontrado' then 'Klingo: CPF não encontrado. Provável paciente novo'
    else null end;
  if v_nota is not null then perform public.fluxo_nota(p_conversa, v_nota); end if;
  if v_sit = 'confere' and cardinality(v_falta) > 0 then
    perform public.fluxo_nota(p_conversa, 'Cadastro no Klingo sem: ' || array_to_string(v_falta, ', ') || '. Pedir ao paciente e atualizar');
  end if;
  if v_sit = 'confere' and coalesce((v_h ->> 'total')::int, 0) > 0 then
    perform public.fluxo_nota(p_conversa, 'Histórico no Klingo (12 meses): ' || (v_h ->> 'total') || ' marcações; a última em ' || coalesce(v_h ->> 'ultima_data', '?') || ' (' || coalesce(left(v_h ->> 'ultimo_procedimento', 80), '?') || ')');
  end if;
end $$;
revoke all on function public.paciente_klingo_registrar(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.paciente_klingo_registrar(uuid, jsonb) to service_role;

create or replace function public.conversa_fluxo_klingo_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.dados -> 'digitado' ? 'cpf' and new.dados -> 'digitado' ? 'dt_nasc' then
    perform public.klingo_conferir_agendar(new.conversa_id);
  end if;
  return new;
exception when others then
  return new;   -- a conferência nunca pode atrapalhar o atendimento
end $$;

-- ===== Parte 3: gatilho =====
create or replace trigger conversa_fluxo_klingo_trg after insert or update of dados on public.conversa_fluxo
  for each row execute function public.conversa_fluxo_klingo_trg();
