-- FLUXOGRAMA: entrada (a equipe aperta "Bloquear agenda" de um médico na aba Agenda médica do painel) -> validação (só admin ou atendente; o nome precisa existir na agenda do Klingo) -> lógica (grava o bloqueio numa tabela PRÓPRIA, que a sincronização do Klingo não apaga; o médico some na hora da lista do chat, das consultas e dos horários; quem já estava no meio do atendimento com esse médico recebe o aviso no chat e volta para a escolha de outro médico ou horário; se não sobrou ninguém, a conversa vai para a equipe) -> saída (resultado com quantas conversas foram avisadas; histórico em profissional_bloqueio_log)
-- Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial. Motivo: a agenda do Klingo da Dra. Lívia continua "vigente" até 31/12 mesmo sem horário real, e o chat seguia oferecendo.
--
-- Aplicar em PARTES (o Supabase expira a migração em 60 s):
--   parte 1 = seção 1 (tabelas e função de apoio)
--   parte 2 = seção 2 (o chat deixa de oferecer médico bloqueado: troca só uma condição nas 4 funções que leem a agenda)
--   parte 3 = seção 3 (funções do painel)
-- ROLLBACK: delete from public.profissional_bloqueio; (libera todos). Para desfazer a parte 2, rode de novo as funções agenda_horarios,
-- agenda_cobre, consultas_da_unidade e unidade_medicos a partir de fase2-pedido-e-agenda.sql e fase6-unidade-e-medico.sql
-- (sem a condição "not public.profissional_bloqueado(...)").
-- ATENÇÃO: quem recriar essas 4 funções a partir de um arquivo antigo perde o filtro. A seção 2 é idempotente: pode rodar de novo.

-- ===== 1. Tabelas e função de apoio =====
create table if not exists public.profissional_bloqueio (
  profissional text primary key,                    -- nome sem acento e em maiúsculas (public.norm_nome)
  nome text not null,                               -- nome como vem do Klingo
  motivo text,
  bloqueado_em timestamptz not null default now(),
  bloqueado_por uuid,
  bloqueado_por_nome text
);
alter table public.profissional_bloqueio enable row level security;
revoke all on public.profissional_bloqueio from anon, authenticated;
comment on table public.profissional_bloqueio is 'Médicos que a equipe bloqueou no painel: o chat não os oferece nem mostra horário deles. Fica fora das tabelas que a sincronização do Klingo apaga e recria. Só as funções profissional_* e agenda_medica_* leem e gravam.';

create table if not exists public.profissional_bloqueio_log (
  id bigint generated always as identity primary key,
  profissional text not null,
  nome text not null,
  acao text not null check (acao in ('bloqueou', 'liberou')),
  motivo text,
  por uuid,
  por_nome text,
  conversas_afetadas integer not null default 0,
  em timestamptz not null default now()
);
alter table public.profissional_bloqueio_log enable row level security;
revoke all on public.profissional_bloqueio_log from anon, authenticated;

create or replace function public.profissional_bloqueado(p_nome text) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.profissional_bloqueio b where b.profissional = public.norm_nome(p_nome))
$$;
revoke all on function public.profissional_bloqueado(text) from public, anon, authenticated;
grant execute on function public.profissional_bloqueado(text) to service_role;

-- ===== 2. O chat deixa de oferecer médico bloqueado =====
-- Parte de cada definição que está no banco (as funções são grandes e o chat depende delas; não se reescrevem à mão).
do $$
declare d text; novo text; alvo text; velho text;
begin
  for alvo, velho in
    select * from (values
      ('public.agenda_horarios(integer[],date,date,text,text,text,jsonb,integer)', 'a.profissional !~* ''teste'''),
      ('public.agenda_cobre(integer[])', 'a.profissional !~* ''teste'''),
      ('public.consultas_da_unidade(text)', 'a.profissional !~* ''(teste|^eletro)'''),
      ('public.unidade_medicos(text)', 'a.profissional !~* ''(teste|^eletro)''')
    ) v(a, b)
  loop
    d := pg_get_functiondef(alvo::regprocedure);
    if d like '%profissional_bloqueado%' then continue; end if;
    if position(velho in d) = 0 then raise exception '%: não achei o trecho para trocar; nada foi alterado', alvo; end if;
    novo := replace(d, velho, velho || ' and not public.profissional_bloqueado(a.profissional)');
    execute novo;
  end loop;
end $$;

-- ===== 3. Funções do painel (admin e atendente) =====
create or replace function public.agenda_medica_painel() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if (select public.papel_atual()) is null or (select public.papel_atual()) not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(q) order by q.bloqueado desc, q.nome) from (
    with base as (
      select public.norm_nome(a.profissional) as chave, a.profissional as nome
      from public.catalogo_agenda a join public.catalogo_procedimento p on p.id = a.procedimento_id
      where p.classe = 'CONSULTAS' and a.vig_fim >= current_date and a.profissional !~* '(teste|^eletro)' and coalesce(a.especialidade, '') !~* 'anestesi'
      union
      select b.profissional, b.nome from public.profissional_bloqueio b
    ), prof as (select chave, min(nome) as nome from base group by chave)
    select pr.nome,
      (b.profissional is not null) as bloqueado, b.motivo, b.bloqueado_em, b.bloqueado_por_nome,
      (select string_agg(distinct initcap(lower(a.especialidade)), ' / ') from public.catalogo_agenda a
        where public.norm_nome(a.profissional) = pr.chave and a.vig_fim >= current_date and a.especialidade is not null) as especialidade,
      (select max(a.vig_fim) from public.catalogo_agenda a where public.norm_nome(a.profissional) = pr.chave) as vigencia_ate,
      (select string_agg(g.un || ': ' || g.dias, ' | ' order by g.un) from (
          select regexp_replace(d.unidade, '^CLÍNICA DE SAÚDE E IMAGEM - ', '') as un,
                 string_agg(d.txt, '; ' order by d.dia_num, d.hora_ini) as dias
          from (select distinct a.unidade, a.dia_num, a.hora_ini,
                       (array['dom','seg','ter','qua','qui','sex','sáb'])[a.dia_num + 1] || ' ' || left(a.hora_ini, 5) || '–' || left(a.hora_fim, 5) as txt
                from public.catalogo_agenda a join public.catalogo_procedimento p on p.id = a.procedimento_id
                where public.norm_nome(a.profissional) = pr.chave and a.vig_fim >= current_date and p.classe = 'CONSULTAS') d
          group by 1) g) as grade,
      (select count(*) from (
          select distinct h.data, h.hora, h.unidade
          from (select distinct a.procedimento_id as pid from public.catalogo_agenda a join public.catalogo_procedimento p on p.id = a.procedimento_id
                 where public.norm_nome(a.profissional) = pr.chave and p.classe = 'CONSULTAS' and a.vig_fim >= current_date) pp
          cross join lateral public.agenda_horarios(array[pp.pid], current_date, current_date + 14, null, pr.nome, null, '[]'::jsonb, 0) h) z) as livres_14d,
      (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
        where pa.status not in ('agendado', 'cancelado') and c.status <> 'encerrada'
          and (public.norm_nome(pa.profissional) = pr.chave or public.norm_nome(c.medico_preferido) = pr.chave
               or exists (select 1 from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e where public.norm_nome(e ->> 'profissional') = pr.chave))) as em_andamento
    from prof pr left join public.profissional_bloqueio b on b.profissional = pr.chave) q), '[]'::jsonb);
end $$;
revoke all on function public.agenda_medica_painel() from public, anon;
grant execute on function public.agenda_medica_painel() to authenticated;

create or replace function public.profissional_bloquear(p_nome text, p_motivo text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_ch text := public.norm_nome(p_nome); v_nome text; v_uid uuid := (select auth.uid()); v_por text; v_motivo text := nullif(left(btrim(coalesce(p_motivo, '')), 200), '');
  r record; v_texto text; v_prox text; v_procs int[]; v_med boolean; v_hor boolean;
  v_total int := 0; v_avisadas int := 0; v_equipe int := 0; v_transf int := 0;
begin
  if (select public.papel_atual()) is null or (select public.papel_atual()) not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if v_ch is null then raise exception 'Informe o médico.' using errcode = '22023'; end if;
  select a.profissional into v_nome from public.catalogo_agenda a where public.norm_nome(a.profissional) = v_ch limit 1;
  if v_nome is null then raise exception 'Médico não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  select nome into v_por from public.agentes where id = v_uid;

  insert into public.profissional_bloqueio (profissional, nome, motivo, bloqueado_em, bloqueado_por, bloqueado_por_nome)
    values (v_ch, v_nome, v_motivo, now(), v_uid, v_por)
    on conflict (profissional) do update set motivo = excluded.motivo, bloqueado_em = excluded.bloqueado_em, bloqueado_por = excluded.bloqueado_por, bloqueado_por_nome = excluded.bloqueado_por_nome;

  v_texto := format('A agenda de %s não está disponível no momento. Vamos escolher outra opção.', initcap(lower(v_nome)));

  -- Quem já escolheu este médico (preferência, pedido ou horário) precisa saber agora.
  for r in
    select pa.conversa_id, c.ia_ativa, c.motor, c.status,
           (select cf.passo from public.conversa_fluxo cf where cf.conversa_id = pa.conversa_id) as passo
    from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
    where pa.status not in ('agendado', 'cancelado') and c.status <> 'encerrada'
      and (public.norm_nome(pa.profissional) = v_ch or public.norm_nome(c.medico_preferido) = v_ch
           or exists (select 1 from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e where public.norm_nome(e ->> 'profissional') = v_ch))
  loop
    v_total := v_total + 1;
    begin
      select (public.norm_nome(pa.profissional) = v_ch or public.norm_nome(c.medico_preferido) = v_ch),
             exists (select 1 from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e where public.norm_nome(e ->> 'profissional') = v_ch)
        into v_med, v_hor
        from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id where pa.conversa_id = r.conversa_id;
      if v_med then
        update public.pre_agendamentos set profissional = null where conversa_id = r.conversa_id and public.norm_nome(profissional) = v_ch;
        update public.conversas set medico_preferido = null where id = r.conversa_id and public.norm_nome(medico_preferido) = v_ch;
        perform public.fluxo_set(r.conversa_id, '{"medico_feito": false}');
      end if;
      if v_hor then
        update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null where conversa_id = r.conversa_id;
        perform public.fluxo_set(r.conversa_id, '{"confirmado": false, "sem_horario": false}');
      end if;
      perform public.fluxo_nota(r.conversa_id, 'Agenda de ' || initcap(lower(v_nome)) || ' bloqueada pela equipe' || coalesce(' (' || v_motivo || ')', '') || ': a escolha dela foi desfeita');

      if r.ia_ativa and r.motor = 'fluxo' and r.status = 'aguardando' and r.passo is not null and r.passo not in ('pronto', 'humano', 'assunto_fim') then
        -- Atendimento automático em andamento: o paciente é avisado agora e a pergunta certa volta.
        v_procs := public.fluxo_procs(r.conversa_id);
        if v_procs is not null and not public.agenda_cobre(v_procs) then
          perform public.fluxo_dizer(r.conversa_id, v_texto, null);
          perform public.fluxo_transferir(r.conversa_id, 'A agenda de ' || initcap(lower(v_nome)) || ' foi bloqueada e não há outro médico para este pedido.', 'media', true);
          v_transf := v_transf + 1;
        else
          v_prox := public.fluxo_proximo(r.conversa_id);
          if v_prox = 'pronto' then v_prox := 'confirmar'; end if;
          perform public.fluxo_perguntar(r.conversa_id, v_prox, v_texto);
        end if;
        v_avisadas := v_avisadas + 1;
      else
        -- Já com uma pessoa (ou fechada para a equipe): faixa de alerta na conversa.
        update public.conversas set alerta_agenda = left('Agenda de ' || initcap(lower(v_nome)) || ' bloqueada: o médico ou o horário que o paciente tinha escolhido não vale mais. Combinar outra opção.', 300), atualizado_em = now()
         where id = r.conversa_id;
        v_equipe := v_equipe + 1;
      end if;
    exception when others then
      update public.conversas set alerta_agenda = left('Agenda de ' || initcap(lower(v_nome)) || ' bloqueada: conferir o que o paciente tinha escolhido.', 300) where id = r.conversa_id;
      v_equipe := v_equipe + 1;
    end;
  end loop;

  insert into public.profissional_bloqueio_log (profissional, nome, acao, motivo, por, por_nome, conversas_afetadas) values (v_ch, v_nome, 'bloqueou', v_motivo, v_uid, v_por, v_total);
  return jsonb_build_object('ok', true, 'nome', v_nome, 'conversas', v_total, 'pacientes_avisados', v_avisadas, 'avisadas_a_equipe', v_equipe, 'passaram_para_a_equipe', v_transf);
end $$;
revoke all on function public.profissional_bloquear(text, text) from public, anon;
grant execute on function public.profissional_bloquear(text, text) to authenticated;

create or replace function public.profissional_liberar(p_nome text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_ch text := public.norm_nome(p_nome); v_nome text; v_uid uuid := (select auth.uid()); v_por text;
begin
  if (select public.papel_atual()) is null or (select public.papel_atual()) not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  delete from public.profissional_bloqueio where profissional = v_ch returning nome into v_nome;
  if v_nome is null then return jsonb_build_object('ok', true, 'ja_liberado', true); end if;
  select nome into v_por from public.agentes where id = v_uid;
  insert into public.profissional_bloqueio_log (profissional, nome, acao, por, por_nome) values (v_ch, v_nome, 'liberou', v_uid, v_por);
  return jsonb_build_object('ok', true, 'nome', v_nome);
end $$;
revoke all on function public.profissional_liberar(text) from public, anon;
grant execute on function public.profissional_liberar(text) to authenticated;
