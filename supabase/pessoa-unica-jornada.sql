-- FLUXOGRAMA: entrada (cartões da Jornada: os do chat e os do Klingo; nome e marca do telefone do Klingo; grupos de conversas de pessoa-unica.sql) -> validação (só quem usa a Jornada; o telefone do Klingo é só uma marca, nunca o número) -> lógica (um cartão do Klingo só se liga à pessoa do chat com 3 informações: nome + telefone + o mesmo dia de uma marcação feita no chat; com 2, vira sugestão que a equipe confirma) -> saída (jornada_pessoas: a "pessoa" de cada cartão; jornada_remarcar_pelo_chat; pessoa_klingo_confirmar/desfazer)
-- Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
--
-- NÃO FOI APLICADO NO SUPABASE. Depende de supabase/pessoa-unica.sql e das tabelas jornada_* (que hoje existem só no banco: ver docs/pendencias-e-dependencias.md, G1).
-- Não altera nenhuma tabela, view ou função da Jornada: só acrescenta. Nenhum comando destrutivo. Pode ser aplicado mais de uma vez.
--
-- Como o cartão do Klingo acha a pessoa do chat (a mesma marca que jornada_conversa_do_card já usa):
--   marca = sha256(8 últimos dígitos do telefone da conversa + config.ia_segredo) = jornada_paciente.fone_chave.
--   1. nome confere (nome_confere) e a marca bate                                  -> 2 informações: SUGESTÃO
--   2. + existe marcação feita no chat para o mesmo dia do cartão                    -> 3 informações: junta sozinho
--   3. + a equipe confirmou ("É a mesma pessoa", pessoa_klingo_vinculo)              -> junta
-- Sem conversa no chat não há como mandar mensagem: a equipe segue pela tarefa "Ligar e oferecer nova data".

create table if not exists public.pessoa_klingo_vinculo (
  prontuario text primary key,
  conversa_id uuid not null references public.conversas(id) on delete cascade,
  por uuid references public.agentes(id) on delete set null,
  em timestamptz not null default now()
);
comment on table public.pessoa_klingo_vinculo is 'Paciente do Klingo (prontuário ou chave "n:...") que a equipe confirmou ser a pessoa de uma conversa do chat.';
alter table public.pessoa_klingo_vinculo enable row level security;
revoke all on table public.pessoa_klingo_vinculo from anon, authenticated;
grant select on table public.pessoa_klingo_vinculo to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pessoa_klingo_vinculo' and policyname = 'pessoa_klingo_vinculo_select') then
    create policy pessoa_klingo_vinculo_select on public.pessoa_klingo_vinculo for select using ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
end $$;

-- A "pessoa" de cada cartão: 'g:<grupo>' (chat + Klingo juntos) ou 'k:<prontuário>' (só Klingo).
-- conversa_id = a conversa mais recente da pessoa (para abrir o chat); sugestao = conversa que PARECE ser dela (2 de 3), a confirmar.
create or replace function public.jornada_pessoas() returns table(card_id bigint, pessoa text, conversa_id uuid, sugestao uuid)
language plpgsql stable security definer set search_path to '' as $$
declare v_sal text;
begin
  if auth.uid() is null or not public.jornada_pode() then return; end if;
  select valor into v_sal from public.config where chave = 'ia_segredo';
  return query
  with conv as (
    select cv.id, coalesce(g.grupo_id, cv.id) as gid, public.pessoa_ficha(cv.id) ->> 'nome' as nome, cv.atualizado_em,
           encode(sha256(convert_to(right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex') as fh
      from public.conversas cv join public.contatos ct on ct.id = cv.contato_id left join public.conversa_grupo g on g.conversa_id = cv.id
  ), rep as (
    select distinct on (gid) gid, id as rep_id from conv order by gid, atualizado_em desc
  ), kl as (
    select c.id as card_id, c.paciente_chave, c.data_ref, p.nome, p.fone_chave
      from public.jornada_card c join public.jornada_paciente p on p.prontuario = c.paciente_chave
     where c.arquivado_em is null and c.conversa_id is null and c.paciente_chave not like 'conv:%' and c.paciente_chave not like 'manual:%'
  ), lig as (
    select kl.card_id, kl.paciente_chave, conv.gid,
           exists (select 1 from public.pessoa_klingo_vinculo v where v.prontuario = kl.paciente_chave and v.conversa_id = conv.id) as confirmado,
           exists (select 1 from public.pre_agendamentos pa, jsonb_array_elements(case when jsonb_typeof(pa.escolha_horario) = 'array' then pa.escolha_horario else '[]'::jsonb end) e
                    where pa.conversa_id = conv.id and e ->> 'data' = kl.data_ref::text) as mesmo_dia
      from kl join conv on conv.fh = kl.fone_chave and public.nome_confere(kl.nome, conv.nome)
  ), melhor as (
    select distinct on (l.card_id) l.card_id, l.gid, (l.confirmado or l.mesmo_dia) as junta
      from lig l order by l.card_id, (l.confirmado or l.mesmo_dia) desc, l.gid
  )
  select c.id, 'g:' || coalesce(g.grupo_id, c.conversa_id)::text, r.rep_id, null::uuid
    from public.jornada_card c
    left join public.conversa_grupo g on g.conversa_id = c.conversa_id
    join rep r on r.gid = coalesce(g.grupo_id, c.conversa_id)
   where c.arquivado_em is null and c.conversa_id is not null
  union all
  select k.card_id, case when m.junta then 'g:' || m.gid::text else 'k:' || k.paciente_chave end, case when m.junta then r.rep_id end, case when m.card_id is not null and not m.junta then r.rep_id end
    from kl k left join melhor m on m.card_id = k.card_id left join rep r on r.gid = m.gid;
end $$;
revoke all on function public.jornada_pessoas() from public, anon;
grant execute on function public.jornada_pessoas() to authenticated;

-- Um atendente confirma: este paciente do Klingo é a pessoa daquela conversa (é a terceira informação).
create or replace function public.pessoa_klingo_confirmar(p_prontuario text, p_conversa uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  perform public.pessoa_equipe();
  if not exists (select 1 from public.jornada_paciente where prontuario = p_prontuario) then raise exception 'Paciente não encontrado na Jornada.' using errcode = '22023'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = '22023'; end if;
  insert into public.pessoa_klingo_vinculo (prontuario, conversa_id, por) values (p_prontuario, p_conversa, (select auth.uid()))
  on conflict (prontuario) do update set conversa_id = excluded.conversa_id, por = excluded.por, em = now();
  return jsonb_build_object('ok', true);
end $$;
create or replace function public.pessoa_klingo_desfazer(p_prontuario text) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  perform public.pessoa_equipe();
  delete from public.pessoa_klingo_vinculo where prontuario = p_prontuario;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.pessoa_klingo_confirmar(text, uuid), public.pessoa_klingo_desfazer(text) from public, anon;
grant execute on function public.pessoa_klingo_confirmar(text, uuid), public.pessoa_klingo_desfazer(text) to authenticated;

-- Falta no Klingo: pede ao paciente que remarque pelo chat. Só funciona se o cartão estiver ligado a uma conversa (3 informações ou confirmação da equipe).
-- O pedido não é copiado (o Klingo não traz o código do exame do catálogo): o paciente escolhe o exame de novo e segue o roteiro normal.
create or replace function public.jornada_remarcar_pelo_chat(p_card bigint) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_conv uuid; v_item text; v_dest uuid; v_motor text; v_quando date;
begin
  perform public.pessoa_equipe();
  select p.conversa_id into v_conv from public.jornada_pessoas() p where p.card_id = p_card;
  if v_conv is null then raise exception 'Este paciente não está ligado a uma conversa do chat. Ligue para oferecer a nova data.' using errcode = '22023'; end if;
  select string_agg(distinct initcap(lower(e.procedimento)), ' + '), min(c.data_ref) into v_item, v_quando
    from public.jornada_card c join public.jornada_exame e on e.card_id = c.id where c.id = p_card and e.status = 'faltou';
  if v_item is null then raise exception 'Este cartão não tem exame com falta.' using errcode = '22023'; end if;
  v_item := v_item || ' (' || to_char(v_quando, 'DD/MM') || ')';
  select c.id, c.motor into v_dest, v_motor from public.conversas c where c.id = any (public.pessoa_membros(v_conv)) order by c.atualizado_em desc limit 1;
  if v_motor = 'fluxo' then
    update public.conversas set ia_ativa = true, status = 'aguardando', agente_id = null where id = v_dest;
    insert into public.conversa_fluxo (conversa_id) values (v_dest) on conflict (conversa_id) do nothing;
    perform public.fluxo_set(v_dest, jsonb_build_object('pos_passo', 'remarcar_falta', 'pos_origem', v_dest, 'pos_copiar', false, 'refazer', 'pedido', 'pos_item', left(v_item, 200),
      'identidade_feita', true, 'atalho_feito', true, 'confirmado', false));
    perform public.fluxo_perguntar(v_dest, 'remarcar_falta', null);
    return jsonb_build_object('ok', true, 'canal', 'botoes', 'conversa_id', v_dest);
  end if;
  perform public.fluxo_dizer(v_dest, 'Olá! Você não pôde comparecer a ' || v_item || '. Quer remarcar? Responda por aqui que um atendente te ajuda.');
  return jsonb_build_object('ok', true, 'canal', 'mensagem', 'conversa_id', v_dest);
end $$;
revoke all on function public.jornada_remarcar_pelo_chat(bigint) from public, anon;
grant execute on function public.jornada_remarcar_pelo_chat(bigint) to authenticated;

-- ======================================================================
-- Fechar sozinho o exame em aberto quando o Klingo já diz como terminou (a equipe não precisa fechar à mão)
-- ======================================================================
-- Só vale para cartão do Klingo que bate em 3 informações: nome + marca do telefone + o mesmo dia.
--   atendido -> compareceu (vale na hora: o Klingo registrou o atendimento)
--   faltou -> faltou (a remarcação fica pendente) | remarcado -> remarcou (remarcação já feita) | só cancelado -> cancelou: estes três esperam o horário passar há mais de 1 hora
-- Depois de fechar, se a pessoa não tem mais exame em aberto nem remarcação pendente, a conversa se encerra sozinha (ou, se um atendente está falando com o paciente, ganha o aviso "pode encerrar").
-- Registra origem = 'klingo'. Sem 3 informações, nada acontece e a equipe fecha à mão.
-- Pessoa sem exame em aberto e sem remarcação pendente: encerra as conversas dela. Se um atendente está em atendimento, só deixa o aviso. Devolve quantas encerrou.
create or replace function public.conversa_encerrar_se_resolvida(p_conversa uuid) returns integer
language plpgsql security definer set search_path to '' as $$
declare v_mem uuid[] := public.pessoa_membros(p_conversa); v_n integer := 0; c record;
begin
  if exists (select 1 from public.v_agendamento_aberto v where v.conversa_id = any (v_mem)) then return 0; end if;
  if exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = any (v_mem)) then return 0; end if;
  for c in select id, status from public.conversas where id = any (v_mem) and status <> 'encerrada' loop
    if c.status = 'em_atendimento' then
      update public.conversas set alerta_agenda = 'Exame concluído e conferido no Klingo. Pode encerrar a conversa.' where id = c.id;
    else
      update public.conversas set status = 'encerrada', encerrada_em = now(), ia_ativa = false, alerta_agenda = null, atualizado_em = now() where id = c.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function public.conversa_encerrar_se_resolvida(uuid) from public, anon, authenticated;

create or replace function public.agendamento_conferir_klingo() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_sal text; a record; v_fecha text; v_id bigint; v_n integer := 0; v_enc integer := 0;
begin
  select valor into v_sal from public.config where chave = 'ia_segredo';
  for a in
    select v.conversa_id, v.quando < (now() at time zone 'America/Bahia') - interval '1 hour' as passou_1h,
           (select array_agg(distinct e.status) from public.jornada_card c
              join public.jornada_paciente p on p.prontuario = c.paciente_chave
              join public.jornada_exame e on e.card_id = c.id
             where c.arquivado_em is null and c.conversa_id is null and c.data_ref = v.quando::date
               and p.fone_chave = encode(sha256(convert_to(right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex')
               and public.nome_confere(p.nome, public.pessoa_ficha(v.conversa_id) ->> 'nome')) as sts
      from public.v_agendamento_aberto v
      join public.conversas cv on cv.id = v.conversa_id join public.contatos ct on ct.id = cv.contato_id
     where v.quando is not null and v.quando::date <= (now() at time zone 'America/Bahia')::date
  loop
    if a.sts is null then continue; end if;
    v_fecha := case when 'atendido' = any (a.sts) then 'compareceu' when 'faltou' = any (a.sts) then 'faltou' when 'remarcado' = any (a.sts) then 'remarcou'
                    when 'cancelado' = any (a.sts) and not ('agendado' = any (a.sts) or 'confirmado' = any (a.sts)) then 'cancelou' end;
    if v_fecha is null or (v_fecha <> 'compareceu' and not a.passou_1h) then continue; end if;
    v_id := public.agendamento_fechar_interno(a.conversa_id, v_fecha, 'klingo', null, 'Conferido no Klingo.');
    if v_id is not null then
      if v_fecha = 'remarcou' then update public.agendamento_fechamento set remarcacao = 'feita' where id = v_id; end if;
      v_n := v_n + 1;
      v_enc := v_enc + public.conversa_encerrar_se_resolvida(a.conversa_id);
    end if;
  end loop;
  return jsonb_build_object('fechados', v_n, 'encerradas', v_enc);
end $$;
revoke all on function public.agendamento_conferir_klingo() from public, anon, authenticated;
grant execute on function public.agendamento_conferir_klingo() to service_role;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('agendamento-klingo', '*/10 * * * *', 'select public.agendamento_conferir_klingo()');
  end if;
end $$;
