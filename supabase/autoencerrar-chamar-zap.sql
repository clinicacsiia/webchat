-- FLUXOGRAMA: entrada (rotina agendada a cada 5 minutos; mensagem de uma PESSOA da equipe sem resposta do paciente há 24 h; botão "Já chamei no zap" do painel) -> validação (conversa em atendimento; 24 h corridas pelo relógio do servidor; remarcação pendente nunca marca; pessoa unida só marca quando todas as conversas abertas dela venceram; conversa antiga sem marco nunca marca; só administrador/atendente confirma o contato) -> lógica (NADA É ENCERRADO: a conversa continua aberta e fica MARCADA "chamar no WhatsApp e pedir para responder no site"; resposta do paciente, nova mensagem da equipe, mudança de estado ou transferência tiram a marca; "Já chamei no zap" tira a marca, grava quem e quando, e recomeça as 24 h) -> saída (conversas marcadas + aviso no sino da atendente + contagem para o painel).
-- Versão 1.0 — 11/11/2026 / Mudança: Decisão do dono: o encerramento automático de 24 h NÃO fecha mais a conversa; sinaliza para a equipe chamar o paciente no WhatsApp pedindo que responda no site, para não perder nenhum atendimento. Substitui autoencerrar_candidatas e autoencerrar_vigiar de c1-reentrada.sql.
-- Pré-requisitos: autoencerrar.sql, c1-reentrada.sql (equipe_notificacao e as versões atuais), pessoa-unica.sql. Aditivo e idempotente. Nenhum comando destrutivo.
-- As chaves continuam as mesmas: config.autoencerrar_modo (desligado | simulacao | ligado) e config.autoencerrar_horas (24). "ligado" agora significa "marcar para chamar no zap" (nunca fecha). Hoje está desligado.
-- DESLIGAR: update public.config set valor = 'desligado' where chave = 'autoencerrar_modo';  (efeito imediato; as marcas que já existem continuam até alguém confirmar ou o paciente responder)
-- LIMPAR AS MARCAS (se precisar): update public.conversas set chamar_zap_em = null where chamar_zap_em is not null;
-- ROLLBACK: reaplicar autoencerrar_candidatas e autoencerrar_vigiar de c1-reentrada.sql (voltam a encerrar). As colunas novas podem ficar.

-- ===== PARTE 1: colunas =====
alter table public.conversas add column if not exists chamar_zap_em timestamptz;
alter table public.conversas add column if not exists chamar_zap_feito_em timestamptz;
alter table public.conversas add column if not exists chamar_zap_feito_por uuid;
comment on column public.conversas.chamar_zap_em is 'Quando a conversa passou de 24 h sem resposta do paciente e foi marcada para a equipe chamar no WhatsApp pedindo que responda no site. Nulo = não precisa.';
comment on column public.conversas.chamar_zap_feito_em is 'Última vez que uma pessoa da equipe confirmou que já chamou o paciente no WhatsApp.';
comment on column public.conversas.chamar_zap_feito_por is 'Quem confirmou o contato no WhatsApp.';
grant select (chamar_zap_em, chamar_zap_feito_em, chamar_zap_feito_por) on public.conversas to authenticated;

-- ===== PARTE 2: a marca sai quando a situação muda =====
create or replace function public.mensagem_aguarda_paciente_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.autor = 'agente' and new.agente_id is not null then
    -- pessoa da equipe escreveu: recomeça o prazo e tira a marca (o assistente não tem agente_id e não conta)
    update public.conversas set aguarda_paciente_desde = now(), chamar_zap_em = null where id = new.conversa_id and status = 'em_atendimento';
  elsif new.autor = 'cliente' then
    -- paciente respondeu (inclusive no site depois do pedido pelo zap): zera tudo
    update public.conversas set aguarda_paciente_desde = null, chamar_zap_em = null
     where id = new.conversa_id and (aguarda_paciente_desde is not null or chamar_zap_em is not null);
  end if;
  return new;
end $$;
revoke all on function public.mensagem_aguarda_paciente_trg() from public, anon, authenticated;

create or replace function public.conversa_limpa_aguarda_paciente_trg() returns trigger
language plpgsql set search_path to '' as $$
begin
  if new.status is distinct from old.status then new.aguarda_paciente_desde := null; new.chamar_zap_em := null; end if;
  return new;
end $$;

create or replace function public.conversa_transferida_reinicia_trg() returns trigger
language plpgsql set search_path to '' as $$
begin
  if old.agente_id is not null and new.agente_id is not null and new.agente_id is distinct from old.agente_id
     and new.status = 'em_atendimento' and new.aguarda_paciente_desde is not null then
    new.aguarda_paciente_desde := now(); new.chamar_zap_em := null;
  end if;
  return new;
end $$;
revoke all on function public.conversa_transferida_reinicia_trg() from public, anon, authenticated;

-- ===== PARTE 3: quem está elegível para a marca =====
create or replace function public.autoencerrar_candidatas() returns setof uuid
language sql stable security definer set search_path to '' as $$
  select c.id from public.conversas c
   where c.status = 'em_atendimento' and c.aguarda_paciente_desde is not null and c.chamar_zap_em is null
     and c.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())
     and not exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = any (public.pessoa_membros(c.id)))
     -- pessoa unida: toda conversa ainda aberta da pessoa também precisa estar vencida (senão a pessoa ainda está sendo atendida)
     and not exists (select 1 from public.conversas m where m.id = any (public.pessoa_membros(c.id)) and m.status <> 'encerrada'
                        and not (m.status = 'em_atendimento' and m.aguarda_paciente_desde is not null
                                 and m.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())))
$$;
revoke all on function public.autoencerrar_candidatas() from public, anon, authenticated;

-- ===== PARTE 4: a rotina (marca, não fecha) =====
-- Na tabela autoencerramento_execucao, a coluna "fechadas" passa a contar as conversas MARCADAS nesta execução (nenhuma é fechada).
create or replace function public.autoencerrar_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_modo text; v_id uuid; v_eleg integer := 0; v_marc integer := 0; v_ok uuid; v_ag uuid;
begin
  select coalesce((select valor from public.config where chave = 'autoencerrar_modo'), 'desligado') into v_modo;
  if v_modo not in ('simulacao', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('autoencerrar_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  for v_id in select * from public.autoencerrar_candidatas() loop
    v_eleg := v_eleg + 1;
    if v_modo = 'ligado' then
      -- Marcação atômica: reconfere estado e prazo no próprio UPDATE (resposta no meio do caminho invalida). A conversa NÃO muda de status.
      update public.conversas set chamar_zap_em = now()
       where id = v_id and status = 'em_atendimento' and chamar_zap_em is null and aguarda_paciente_desde is not null
         and aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())
       returning id, agente_id into v_ok, v_ag;
      if v_ok is not null then
        v_marc := v_marc + 1;
        insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
        values (v_ag, 'chamar_zap', v_id, jsonb_build_object('aviso', 'Paciente sem resposta há mais de 24 h: chame no WhatsApp e peça para responder no site.', 'horas', public.autoencerrar_horas()));
        v_ok := null;
      end if;
    end if;
  end loop;
  insert into public.autoencerramento_execucao (modo, elegiveis, fechadas) values (v_modo, v_eleg, v_marc);
  return jsonb_build_object('modo', v_modo, 'elegiveis', v_eleg, 'marcadas', v_marc, 'fechadas', 0);
end $$;
revoke all on function public.autoencerrar_vigiar() from public, anon, authenticated;
grant execute on function public.autoencerrar_vigiar() to service_role;

-- ===== PARTE 5: "Já chamei no zap" (botão do painel) =====
-- Tira a marca de toda a pessoa (conversas unidas), registra quem e quando, e recomeça as 24 h: se o paciente continuar sem responder, a marca volta amanhã.
create or replace function public.chamar_zap_feito(p_conversa uuid) returns integer
language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Apenas a equipe.' using errcode = '42501'; end if;
  update public.conversas set chamar_zap_em = null, chamar_zap_feito_em = now(), chamar_zap_feito_por = (select auth.uid()), aguarda_paciente_desde = now()
   where id = any (public.pessoa_membros(p_conversa)) and status = 'em_atendimento' and chamar_zap_em is not null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.chamar_zap_feito(uuid) from public, anon;
grant execute on function public.chamar_zap_feito(uuid) to authenticated;

-- ===== PARTE 6: resumo para o painel (administrador) =====
create or replace function public.autoencerrar_resumo() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Apenas administradores.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'modo', coalesce((select valor from public.config where chave = 'autoencerrar_modo'), 'desligado'),
    'horas', public.autoencerrar_horas(),
    'elegiveis_agora', (select count(*) from public.autoencerrar_candidatas()),
    'aguardando_paciente', (select count(*) from public.conversas where status = 'em_atendimento' and aguarda_paciente_desde is not null),
    'chamar_zap_agora', (select count(*) from public.conversas where status = 'em_atendimento' and chamar_zap_em is not null),
    'ultimas', coalesce((select jsonb_agg(x) from (select em, modo, elegiveis, fechadas as marcadas from public.autoencerramento_execucao order by id desc limit 5) x), '[]'::jsonb));
end $$;
revoke all on function public.autoencerrar_resumo() from public, anon;
grant execute on function public.autoencerrar_resumo() to authenticated;
