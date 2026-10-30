-- Fase 4: paciente que volta. JÁ APLICADO no projeto webchat-atendimento (30/10/2026).
--   * paciente_historico: uma linha por marcação concluída (status 'agendado', automático ou manual), com os exames, o horário e o plano.
--   * A IA recebe 'historico_paciente' em ia_contexto. Os DETALHES só saem depois que a data de nascimento do paciente foi conferida
--     (mesma regra do cadastro); antes disso a IA só sabe que existe histórico.
--   * 'reaproveitar' em ia_pre_agendar copia para a conversa nova o pedido da última visita ('ultimo') ou o pedido que ficou pela metade
--     em outra conversa do mesmo contato ('pendente'). Também só depois da data de nascimento conferida.
--   * O painel mostra o histórico do paciente ao atendente.
-- Sem comandos destrutivos (cancelamento só marca a linha; nada é apagado).

create table if not exists public.paciente_historico (
  id bigint generated always as identity primary key,
  paciente_id uuid not null references public.pacientes(id) on delete cascade,
  pre_agendamento_id uuid unique references public.pre_agendamentos(id) on delete set null,
  conversa_id uuid references public.conversas(id) on delete set null,
  ocorreu_em timestamp,                       -- data e hora (local) do primeiro horário marcado
  unidade text, profissional text, plano text,
  exames jsonb not null default '[]'::jsonb,  -- [{modalidade, regiao, parte_do_corpo, lado D|E|A|N, procedimento_id, exame, quantidade}]
  horarios jsonb not null default '[]'::jsonb,
  origem text not null check (origem in ('automatico','manual')),
  cancelado boolean not null default false,
  criado_em timestamptz not null default now()
);
comment on table public.paciente_historico is 'Marcações concluídas de cada paciente conhecido (sem dados do Klingo). Só admin/atendente leem; a IA só recebe os detalhes depois da data de nascimento conferida.';
create index if not exists paciente_historico_paciente on public.paciente_historico (paciente_id, criado_em desc);
alter table public.paciente_historico enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'paciente_historico' and policyname = 'paciente_historico_select') then
    create policy paciente_historico_select on public.paciente_historico for select using ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
end $$;

-- Guarda a marcação quando o pré-agendamento vira 'agendado' (sozinho ou pelo botão); marca como cancelada se virar 'cancelado'.
create or replace function public.pre_agendamento_historico_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_pid uuid;
begin
  if new.status = 'cancelado' and old.status = 'agendado' then
    update public.paciente_historico set cancelado = true where pre_agendamento_id = new.id;
    return new;
  end if;
  if new.status is distinct from 'agendado' or old.status = 'agendado' then return new; end if;
  v_pid := new.paciente_id;
  if v_pid is null then
    select p.id into v_pid from public.pacientes p
      join public.conversas c on c.id = new.conversa_id join public.contatos ct on ct.id = c.contato_id
      where public.fone_chave(ct.telefone) = any(p.telefones) and public.nome_confere(ct.nome, p.nome)
      order by p.atualizado_em desc limit 1;
  end if;
  if v_pid is null then return new; end if;
  insert into public.paciente_historico as h (paciente_id, pre_agendamento_id, conversa_id, ocorreu_em, unidade, profissional, plano, exames, horarios, origem, cancelado)
  values (v_pid, new.id, new.conversa_id,
    (select min((e ->> 'data')::date + (e ->> 'hora')::time) from jsonb_array_elements(case when jsonb_typeof(new.escolha_horario) = 'array' then new.escolha_horario else '[]'::jsonb end) e),
    coalesce(new.unidade, new.escolha_horario -> 0 ->> 'unidade'), coalesce(new.profissional, new.escolha_horario -> 0 ->> 'profissional'), new.plano,
    coalesce((select jsonb_agg(jsonb_build_object('modalidade', i.modalidade, 'regiao', i.regiao, 'parte_do_corpo', i.regiao_nome, 'lado', i.lado,
                'procedimento_id', i.procedimento_id, 'exame', i.procedimento, 'quantidade', i.quantidade) order by i.id)
              from public.pre_agendamento_itens i where i.conversa_id = new.conversa_id and i.ativo), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'unidade', e ->> 'unidade', 'profissional', e ->> 'profissional') order by e ->> 'data', e ->> 'hora')
              from jsonb_array_elements(case when jsonb_typeof(new.escolha_horario) = 'array' then new.escolha_horario else '[]'::jsonb end) e), '[]'::jsonb),
    case when new.agendado_auto_em is not null then 'automatico' else 'manual' end, false)
  on conflict (pre_agendamento_id) do update set
    paciente_id = excluded.paciente_id, ocorreu_em = excluded.ocorreu_em, unidade = excluded.unidade, profissional = excluded.profissional, plano = excluded.plano,
    exames = excluded.exames, horarios = excluded.horarios, origem = excluded.origem, cancelado = false;
  return new;
end $$;
revoke all on function public.pre_agendamento_historico_trg() from public, anon, authenticated;
create or replace trigger pre_agendamento_historico after update of status on public.pre_agendamentos
  for each row execute function public.pre_agendamento_historico_trg();

-- Conversa anterior do mesmo contato com pedido pela metade (até 7 dias, outra conversa, com exame definido).
create or replace function public.pre_pendencia_anterior(p_conversa uuid) returns uuid
language sql stable security definer set search_path to '' as $$
  select pa.conversa_id
  from public.conversas atual
  join public.conversas c2 on c2.contato_id = atual.contato_id and c2.id <> atual.id
  join public.pre_agendamentos pa on pa.conversa_id = c2.id
  where atual.id = p_conversa and pa.status in ('rascunho','pronto') and pa.atualizado_em > now() - interval '7 days'
    and exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is not null)
  order by pa.atualizado_em desc limit 1
$$;
revoke all on function public.pre_pendencia_anterior(uuid) from public, anon, authenticated;

-- O que a IA pode saber do histórico. Detalhes só com a data de nascimento conferida (liberado = true).
create or replace function public.paciente_historico_para_ia(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_conf jsonb; v_pid uuid; v_lib boolean; v_n int; v_pend uuid; v_pendj jsonb; v_ult jsonb;
  v_agora timestamp := now() at time zone 'America/Bahia';
begin
  v_conf := public.paciente_conferir(p_conversa);
  v_pid := nullif(v_conf ->> 'paciente_id', '')::uuid;
  if v_pid is null then return jsonb_build_object('tem_historico', false); end if;
  v_lib := (v_conf ->> 'dt_nasc_conferida') = 'true';
  select count(*) into v_n from public.paciente_historico where paciente_id = v_pid and not cancelado;
  v_pend := public.pre_pendencia_anterior(p_conversa);
  if v_n = 0 and v_pend is null then return jsonb_build_object('tem_historico', false); end if;
  if not v_lib then
    return jsonb_build_object('tem_historico', v_n > 0, 'visitas', v_n, 'tem_pedido_pela_metade', v_pend is not null, 'liberado', false);
  end if;
  select coalesce(jsonb_agg(x order by x ->> 'ordem' desc), '[]'::jsonb) into v_ult from (
    select jsonb_build_object(
      'ordem', to_char(coalesce(h.ocorreu_em, h.criado_em at time zone 'America/Bahia'), 'YYYYMMDDHH24MI'),
      'quando', to_char(coalesce(h.ocorreu_em, h.criado_em at time zone 'America/Bahia'), 'DD/MM/YYYY'),
      'futuro', coalesce(h.ocorreu_em > v_agora, false),
      'unidade', regexp_replace(h.unidade, '^CLÍNICA DE SAÚDE E IMAGEM - ', ''), 'profissional', h.profissional, 'plano', h.plano,
      'exames', (select coalesce(jsonb_agg(jsonb_build_object('modalidade', e ->> 'modalidade', 'parte_do_corpo', e ->> 'parte_do_corpo',
                   'lado', case e ->> 'lado' when 'D' then 'direito' when 'E' then 'esquerdo' when 'A' then 'ambos' else null end,
                   'exame', e ->> 'exame', 'quantidade', (e ->> 'quantidade')::int)), '[]'::jsonb) from jsonb_array_elements(h.exames) e)) as x
    from public.paciente_historico h where h.paciente_id = v_pid and not h.cancelado
    order by coalesce(h.ocorreu_em, h.criado_em at time zone 'America/Bahia') desc limit 3) q;
  if v_pend is not null then
    select jsonb_build_object('status', pa.status, 'etapa', pa.etapa, 'plano', pa.plano, 'unidade', pa.unidade,
      'quando', to_char(pa.atualizado_em at time zone 'America/Bahia', 'DD/MM'),
      'exames', (select coalesce(jsonb_agg(jsonb_build_object('modalidade', i.modalidade, 'parte_do_corpo', i.regiao_nome,
                   'lado', case i.lado when 'D' then 'direito' when 'E' then 'esquerdo' when 'A' then 'ambos' else null end, 'exame', i.procedimento, 'quantidade', i.quantidade) order by i.id), '[]'::jsonb)
                 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo))
      into v_pendj from public.pre_agendamentos pa where pa.conversa_id = v_pend;
  end if;
  return jsonb_build_object('tem_historico', v_n > 0, 'visitas', v_n, 'liberado', true, 'ultimas', (select coalesce(jsonb_agg(u - 'ordem' order by u ->> 'ordem' desc), '[]'::jsonb) from jsonb_array_elements(v_ult) u),
                            'pedido_pela_metade', v_pendj);
end $$;
revoke all on function public.paciente_historico_para_ia(uuid) from public, anon, authenticated;

-- Copia o pedido para a conversa nova. origem: 'ultimo' (última visita) ou 'pendente' (pedido pela metade). Só com data de nascimento conferida
-- e só se a conversa ainda não tem exames.
create or replace function public.pre_reaproveitar(p_conversa uuid, p_origem text) returns boolean
language plpgsql security definer set search_path to '' as $$
declare v_conf jsonb; v_pid uuid; v_ex jsonb; v_orig uuid; v_n int;
begin
  v_conf := public.paciente_conferir(p_conversa);
  v_pid := nullif(v_conf ->> 'paciente_id', '')::uuid;
  if v_pid is null or (v_conf ->> 'dt_nasc_conferida') is distinct from 'true' then return false; end if;
  if exists (select 1 from public.pre_agendamento_itens where conversa_id = p_conversa and ativo) then return false; end if;
  if p_origem = 'ultimo' then
    select h.exames into v_ex from public.paciente_historico h
      where h.paciente_id = v_pid and not h.cancelado and jsonb_array_length(h.exames) > 0 order by h.criado_em desc limit 1;
  elsif p_origem = 'pendente' then
    v_orig := public.pre_pendencia_anterior(p_conversa);
    if v_orig is null then return false; end if;
    select jsonb_agg(jsonb_build_object('modalidade', i.modalidade, 'regiao', i.regiao, 'parte_do_corpo', i.regiao_nome, 'lado', i.lado,
        'procedimento_id', i.procedimento_id, 'quantidade', i.quantidade) order by i.id) into v_ex
      from public.pre_agendamento_itens i where i.conversa_id = v_orig and i.ativo;
  else
    return false;
  end if;
  if v_ex is null then return false; end if;
  insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
  select p_conversa, x.modalidade, x.regiao, x.parte_do_corpo, coalesce(nullif(x.lado, ''), 'N'), p.id, p.nome, greatest(coalesce(x.quantidade, 1), 1)
  from jsonb_to_recordset(v_ex) as x(modalidade text, regiao text, parte_do_corpo text, lado text, procedimento_id int, quantidade int)
  left join public.catalogo_procedimento p on p.id = x.procedimento_id and p.ativo
  where x.modalidade in ('RM','TC','US','RX','MAMO','DENSITO') and x.lado in ('D','E','A','N');
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;
  update public.pre_agendamentos pa set tipo = 'exame',
    procedimento = left((select string_agg(coalesce(i.procedimento, i.modalidade), ' + ' order by i.id) from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo), 160),
    etapa = case when pa.etapa is null or pa.etapa = 'pedido' then 'plano' else pa.etapa end,
    plano = case when v_orig is not null then coalesce(pa.plano, (select o.plano from public.pre_agendamentos o where o.conversa_id = v_orig)) else pa.plano end,
    unidade = case when v_orig is not null then coalesce(pa.unidade, (select o.unidade from public.pre_agendamentos o where o.conversa_id = v_orig)) else pa.unidade end,
    atualizado_em = now()
  where pa.conversa_id = p_conversa and pa.status not in ('agendado','cancelado');
  return true;
end $$;
revoke all on function public.pre_reaproveitar(uuid, text) from public, anon, authenticated;

-- ia_contexto passa a devolver "historico_paciente".
do $$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.ia_contexto(text,uuid)'::regprocedure);
  if position('historico_paciente' in d) > 0 then return; end if;
  d2 := replace(d, '''paciente_conhecido'', (public.paciente_conferir(c.id) - ''paciente_id''),',
                   '''paciente_conhecido'', (public.paciente_conferir(c.id) - ''paciente_id''),' || E'\n    ' || '''historico_paciente'', public.paciente_historico_para_ia(c.id),');
  if d2 = d then raise exception 'ia_contexto: substituição não aplicada; nada foi alterado.'; end if;
  execute d2;
end $$;

-- ia_pre_agendar aceita p_dados->>'reaproveitar' = 'ultimo' | 'pendente' (a IA manda quando o paciente aceita repetir ou retomar).
do $$
declare d text; d2 text; alvo text := 'select * into r from public.pre_agendamentos where conversa_id = p_conversa;';
begin
  d := pg_get_functiondef('public.ia_pre_agendar(text,uuid,jsonb,boolean)'::regprocedure);
  if position('pre_reaproveitar' in d) > 0 then return; end if;
  if length(d) - length(replace(d, alvo, '')) <> length(alvo) then raise exception 'ia_pre_agendar: ponto de inserção ambíguo ou ausente; nada foi alterado.'; end if;
  d2 := replace(d, alvo, E'if p_dados ->> ''reaproveitar'' in (''ultimo'', ''pendente'') then perform public.pre_reaproveitar(p_conversa, p_dados ->> ''reaproveitar''); end if;\n  ' || alvo);
  execute d2;
end $$;
