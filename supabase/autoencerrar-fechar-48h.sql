-- FLUXOGRAMA: entrada (rotina agendada a cada 5 minutos; conversa em atendimento em que uma PESSOA da equipe escreveu e o paciente não respondeu há 48 h) -> validação (chave própria config.autoencerrar_fechar_modo: desligado | simulacao | ligado; 48 h corridas pelo relógio do servidor; remarcação pendente nunca fecha; pessoa unida só fecha quando todas as conversas abertas dela venceram as 48 h; conversa antiga sem marco nunca fecha) -> lógica (uma instrução atômica reconfere estado e prazo e encerra com motivo "Não respondido", origem "inatividade"; o gatilho existente manda a despedida uma vez e grava o histórico; a marca "Chamar no WhatsApp" de 24 h continua como está e sai sozinha ao fechar) -> saída (conversa encerrada + aviso no sino da atendente + linha em autoencerramento_fechada + contagem no resumo do painel).
-- Versão 1.0 — 12/11/2026 / Mudança: Decisão do dono: depois de 48 h sem resposta do paciente a conversa PODE ser encerrada por inatividade. As 24 h continuam só marcando "Chamar no WhatsApp". Aditivo: reaproveita autoencerrar-chamar-zap.sql (marca de 24 h) e as tabelas de autoencerrar.sql.
-- Pré-requisitos: autoencerrar.sql, c1-reentrada.sql, autoencerrar-chamar-zap.sql. Aditivo e idempotente. Nenhum comando destrutivo.
-- Chaves: config.autoencerrar_fechar_modo (desligado | simulacao | ligado; nasce DESLIGADO) e config.autoencerrar_fechar_horas (48). A chave autoencerrar_modo (aviso de 24 h) não muda.
-- Observação: o botão "Já chamei no zap" recomeça a contagem (aguarda_paciente_desde = agora), então o fechamento só acontece 48 h depois da última mensagem da equipe ou do último "Já chamei no zap".
-- DESLIGAR: update public.config set valor = 'desligado' where chave = 'autoencerrar_fechar_modo';  (efeito imediato)
-- FECHAMENTO INDEVIDO: select * from public.autoencerramento_fechada order by fechada_em desc;  e use Reabrir no painel, uma a uma (nunca em massa).
-- ROLLBACK: reaplicar autoencerrar_vigiar e autoencerrar_resumo de autoencerrar-chamar-zap.sql. As colunas/chaves novas podem ficar.

-- ===== PARTE 1: chaves e coluna de contagem =====
insert into public.config (chave, valor) values ('autoencerrar_fechar_modo', 'desligado'), ('autoencerrar_fechar_horas', '48') on conflict (chave) do nothing;
alter table public.autoencerramento_execucao add column if not exists encerradas integer not null default 0;

-- ===== PARTE 2: prazo e candidatas ao fechamento =====
create or replace function public.autoencerrar_fechar_horas() returns integer
language sql stable security definer set search_path to '' as $$
  select coalesce((select case when valor ~ '^[0-9]+$' and valor::int between 1 and 720 then valor::int end from public.config where chave = 'autoencerrar_fechar_horas'), 48)
$$;
revoke all on function public.autoencerrar_fechar_horas() from public, anon, authenticated;

create or replace function public.autoencerrar_fechar_candidatas() returns setof uuid
language sql stable security definer set search_path to '' as $$
  select c.id from public.conversas c
   where c.status = 'em_atendimento' and c.aguarda_paciente_desde is not null
     and c.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_fechar_horas())
     and not exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = any (public.pessoa_membros(c.id)))
     -- pessoa unida: toda conversa ainda aberta da pessoa também precisa estar vencida
     and not exists (select 1 from public.conversas m where m.id = any (public.pessoa_membros(c.id)) and m.status <> 'encerrada'
                        and not (m.status = 'em_atendimento' and m.aguarda_paciente_desde is not null
                                 and m.aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_fechar_horas())))
$$;
revoke all on function public.autoencerrar_fechar_candidatas() from public, anon, authenticated;

-- ===== PARTE 3: a rotina (marca em 24 h, fecha em 48 h) =====
create or replace function public.autoencerrar_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_modo text; v_fmodo text; v_id uuid; v_eleg integer := 0; v_marc integer := 0; v_feleg integer := 0; v_fech integer := 0;
        v_ok uuid; v_ag uuid; v_desde timestamptz;
begin
  select coalesce((select valor from public.config where chave = 'autoencerrar_modo'), 'desligado') into v_modo;
  select coalesce((select valor from public.config where chave = 'autoencerrar_fechar_modo'), 'desligado') into v_fmodo;
  if v_modo not in ('simulacao', 'ligado') and v_fmodo not in ('simulacao', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('autoencerrar_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;

  -- (a) 24 h: só marca "Chamar no WhatsApp" (igual a autoencerrar-chamar-zap.sql)
  if v_modo in ('simulacao', 'ligado') then
    for v_id in select * from public.autoencerrar_candidatas() loop
      v_eleg := v_eleg + 1;
      if v_modo = 'ligado' then
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
  end if;

  -- (b) 48 h: encerra por inatividade. Atômico: reconfere estado e prazo no próprio UPDATE (resposta no meio do caminho invalida).
  if v_fmodo in ('simulacao', 'ligado') then
    for v_id in select * from public.autoencerrar_fechar_candidatas() loop
      v_feleg := v_feleg + 1;
      if v_fmodo = 'ligado' then
        select aguarda_paciente_desde, agente_id into v_desde, v_ag from public.conversas where id = v_id;
        update public.conversas set status = 'encerrada', ia_ativa = false, atualizado_em = now(),
               motivo_encerramento = 'nao_respondido', encerramento_origem = 'inatividade'
         where id = v_id and status = 'em_atendimento' and aguarda_paciente_desde is not null
           and aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_fechar_horas())
         returning id into v_ok;
        if v_ok is not null then
          v_fech := v_fech + 1;
          insert into public.autoencerramento_fechada (conversa_id, aguarda_paciente_desde) values (v_id, v_desde) on conflict do nothing;
          insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
          values (v_ag, 'autoencerrada', v_id, jsonb_build_object('aviso', 'Conversa encerrada por falta de resposta do paciente.', 'horas', public.autoencerrar_fechar_horas()));
          v_ok := null;
        end if;
      end if;
    end loop;
  end if;

  insert into public.autoencerramento_execucao (modo, elegiveis, fechadas, encerradas) values (v_modo, v_eleg, v_marc, v_fech);
  return jsonb_build_object('modo', v_modo, 'elegiveis', v_eleg, 'marcadas', v_marc,
                            'fechar_modo', v_fmodo, 'fechar_elegiveis', v_feleg, 'fechadas', v_fech);
end $$;
revoke all on function public.autoencerrar_vigiar() from public, anon, authenticated;
grant execute on function public.autoencerrar_vigiar() to service_role;

-- ===== PARTE 4: resumo para o painel (administrador) =====
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
    'fechar_modo', coalesce((select valor from public.config where chave = 'autoencerrar_fechar_modo'), 'desligado'),
    'fechar_horas', public.autoencerrar_fechar_horas(),
    'fechar_elegiveis_agora', (select count(*) from public.autoencerrar_fechar_candidatas()),
    'ultimas', coalesce((select jsonb_agg(x) from (select em, modo, elegiveis, fechadas as marcadas, encerradas from public.autoencerramento_execucao order by id desc limit 5) x), '[]'::jsonb));
end $$;
revoke all on function public.autoencerrar_resumo() from public, anon;
grant execute on function public.autoencerrar_resumo() to authenticated;
