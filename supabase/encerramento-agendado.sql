-- FLUXOGRAMA: entrada (a equipe encerra uma conversa pelo painel com o motivo Agendado) -> validação (NADA é recusado: o encerramento sempre vale; o servidor só confere se há agendamento vigente da pessoa: pré-agendamento 'agendado' em aberto, ou cartão do Klingo ligado por prontuário confirmado ou por nome + telefone) -> lógica (grava a conferência em conversa_agendado_conferencia; a rotina agendado_vigiar, a cada 5 min, continua conferindo: achou = confirmado; não achou depois do prazo, leitura do Klingo com problema ou exame que mudou = aviso na conversa e push à equipe; exame futuro deixa de bloquear o encerramento SÓ quando o motivo é Agendado) -> saída (conversa encerrada + alerta_agenda quando algo não bate).
-- Versão 1.1 — 09/11/2026 / Mudança: o encerramento como Agendado NUNCA mais é recusado (some AGENDADO_SEM_AGENDAMENTO / AGENDADO_AMBIGUO / AGENDADO_AGENDA_INDISPONIVEL); a conferência passa a rodar depois, em segundo plano, com aviso. Pedido do dono: a atendente não conseguia encerrar.
-- Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-04 da Atualização do WebChat). Decisão D2 aprovada.
-- Pré-requisitos: encerramento-motivo.sql (motivo_encerramento), pessoa-unica.sql (v_agendamento_aberto, pessoa_membros, conversa_exame_aberto_trg), pessoa-unica-jornada.sql (pessoa_klingo_vinculo), jornada (jornada_card, jornada_exame, jornada_paciente, jornada_sync_estado), espera-longa.sql (horario_trabalho_agora). Aditivo e idempotente. Nenhum comando destrutivo.
-- Aplicar em PARTES no Supabase (a migração expira em 60 s): PARTE 1, PARTE 2, PARTE 3, PARTE 4 e PARTES 5 e 6 juntas.
-- LIGAR: Configurações > Encerramento e avaliação > "Conferir a agenda ao encerrar como Agendado" (config.encerramento_valida_agendado = 'sim'). Desligado ('nao'): nada é conferido e tudo continua como antes.
-- Prazo: config.agendado_conferir_prazo_min (minutos, padrão 120): quanto tempo a conferência espera o agendamento aparecer no Klingo antes de avisar a equipe.
-- Limite conhecido: a UNIDADE não é comparada, porque os nomes diferem entre o chat (CSI, DESENVOAR…) e o Klingo (CSI 1, CSI 2, CSI Pediatria). A identidade (pessoa unida, prontuário confirmado, nome + telefone) é o que protege contra cruzar pacientes.
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'encerramento_valida_agendado';  (efeito imediato) e select cron.unschedule('agendado-vigia'); Para voltar a função: definição anterior de conversa_exame_aberto_trg em pessoa-unica.sql.

-- ===== PARTE 1: chave =====
insert into public.config (chave, valor) values ('encerramento_valida_agendado', 'nao') on conflict (chave) do nothing;
insert into public.config (chave, valor) values ('agendado_conferir_prazo_min', '120') on conflict (chave) do nothing;

-- Uma linha por conversa encerrada como Agendado (o último fechamento). Sem nome, telefone ou texto de conversa.
--   verificando = ainda não achei o agendamento (continua conferindo); confirmado = achei; problema = avisei a equipe; concluido = parei de acompanhar.
create table if not exists public.conversa_agendado_conferencia (
  conversa_id uuid primary key references public.conversas (id) on delete cascade,
  situacao text not null check (situacao in ('verificando', 'confirmado', 'problema', 'concluido')),
  fonte text,                      -- 'chat' ou 'klingo' (de onde veio o agendamento achado)
  codigo text,                     -- último motivo de não ter achado (AGENDADO_SEM_AGENDAMENTO, AGENDADO_AMBIGUO, AGENDADO_AGENDA_INDISPONIVEL)
  exame_em timestamptz,            -- data do exame do Klingo achado (para perceber que mudou)
  encerrada_em timestamptz not null default now(),
  verificada_em timestamptz,
  tentativas integer not null default 0,
  aviso_texto text,                -- o texto que a rotina colocou em conversas.alerta_agenda (só ele é apagado por ela)
  avisada_em timestamptz,
  push_em timestamptz              -- quando o push da equipe saiu
);
comment on table public.conversa_agendado_conferencia is 'Conferência, em segundo plano, das conversas que a equipe encerrou como Agendado. Sem dado de paciente.';
alter table public.conversa_agendado_conferencia enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversa_agendado_conferencia' and policyname = 'conversa_agendado_conferencia_select') then
    create policy conversa_agendado_conferencia_select on public.conversa_agendado_conferencia for select
      using ((select public.papel_atual()) = any (array['admin', 'atendente']));
  end if;
end $$;
grant select on public.conversa_agendado_conferencia to authenticated;

-- ===== PARTE 2: a pessoa tem agendamento vigente? (só responde; quem decide o que fazer é a PARTE 4 e a rotina da PARTE 5) =====
create or replace function public.agendamento_valido_para_encerrar(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_mem uuid[] := public.pessoa_membros(p_conversa);
  v_a integer; v_k integer; v_sal text; v_erro text; v_em timestamptz; v_atrasado boolean; v_ate timestamptz;
begin
  -- A) exame marcado pelo chat e ainda sem desfecho
  select count(*) into v_a from public.v_agendamento_aberto v where v.conversa_id = any (v_mem);
  if v_a > 0 then return jsonb_build_object('ok', true, 'fonte', 'chat', 'exames', v_a); end if;

  -- B) cartão do Klingo com exame vigente, ligado à pessoa por prontuário confirmado OU por nome + marca do telefone
  select valor into v_sal from public.config where chave = 'ia_segredo';
  select count(distinct c.paciente_chave), min(e.agendado_para) into v_k, v_ate
    from public.jornada_card c
    join public.jornada_exame e on e.card_id = c.id
   where c.arquivado_em is null and e.status in ('agendado', 'confirmado') and e.agendado_para >= now() - interval '1 day'
     and (exists (select 1 from public.pessoa_klingo_vinculo pv where pv.prontuario = c.paciente_chave and pv.conversa_id = any (v_mem))
          or exists (select 1 from unnest(v_mem) m
                       join public.conversas cv on cv.id = m
                       join public.contatos ct on ct.id = cv.contato_id
                       join public.jornada_paciente p on p.prontuario = c.paciente_chave
                      where p.fone_chave = encode(sha256(convert_to(right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex')
                        and public.nome_confere(p.nome, public.pessoa_ficha(m) ->> 'nome')));
  if v_k = 1 then return jsonb_build_object('ok', true, 'fonte', 'klingo', 'exames', 1, 'ate', v_ate); end if;
  if v_k > 1 then
    return jsonb_build_object('ok', false, 'codigo', 'AGENDADO_AMBIGUO',
      'mensagem', 'Encontrei mais de um paciente possível no Klingo. Confirme na conversa que é a mesma pessoa ou escolha outro motivo.');
  end if;

  -- Nada encontrado: a leitura do Klingo está em dia?
  select klingo_em, klingo_erro into v_em, v_erro from public.jornada_sync_estado limit 1;
  v_atrasado := v_em is null or v_em < now() - interval '15 minutes' or coalesce(v_erro, '') <> '';
  if v_atrasado then
    return jsonb_build_object('ok', false, 'codigo', 'AGENDADO_AGENDA_INDISPONIVEL',
      'mensagem', 'Não consegui conferir a agenda agora (a leitura do Klingo está atrasada). Tente de novo em instantes ou escolha Apenas informações.');
  end if;
  return jsonb_build_object('ok', false, 'codigo', 'AGENDADO_SEM_AGENDAMENTO',
    'mensagem', 'Não encontrei agendamento vigente para este paciente. Confira o horário no Klingo ou escolha outro motivo.');
end $$;
revoke all on function public.agendamento_valido_para_encerrar(uuid) from public, anon;
grant execute on function public.agendamento_valido_para_encerrar(uuid) to authenticated;

-- ===== PARTE 3: exame futuro deixa de bloquear só para o motivo Agendado (parte da definição atual do banco) =====
create or replace function public.conversa_exame_aberto_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_n integer; v_passou integer;
begin
  if new.status = 'encerrada' and old.status is distinct from 'encerrada' and coalesce((select public.papel_atual()), '') <> '' then
    select count(*), count(*) filter (where v.passou) into v_n, v_passou
      from public.v_agendamento_aberto v where v.conversa_id = any (public.pessoa_membros(new.id));
    if v_n > 0 then
      -- D2: com a chave ligada, Agendado encerra enquanto o exame ainda é futuro; ele segue na Jornada e o Klingo fecha o desfecho depois.
      if new.motivo_encerramento = 'agendado' and v_passou = 0
         and coalesce((select valor from public.config where chave = 'encerramento_valida_agendado'), 'nao') = 'sim' then
        return new;
      end if;
      raise exception 'EXAME_EM_ABERTO: há % exame(s) marcado(s) sem desfecho. Registre se o paciente compareceu, faltou, cancelou ou remarcou antes de encerrar.', v_n using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.conversa_exame_aberto_trg() from public, anon, authenticated;

-- ===== PARTE 4: encerramento como Agendado (NUNCA recusa) =====
-- Com a chave ligada, o fechamento da equipe como Agendado só abre a conferência. Qualquer falha aqui é engolida: encerrar é mais importante que conferir.
-- Reabrir a conversa apaga a conferência (e o aviso que a rotina tinha posto).
create or replace function public.conversa_valida_agendado_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v jsonb; v_txt text;
begin
  if new.status = 'encerrada' and old.status is distinct from 'encerrada' then
    if new.motivo_encerramento = 'agendado'
       and coalesce((select public.papel_atual()), '') <> ''
       and coalesce((select valor from public.config where chave = 'encerramento_valida_agendado'), 'nao') = 'sim' then
      begin
        v := public.agendamento_valido_para_encerrar(new.id);
        insert into public.conversa_agendado_conferencia (conversa_id, situacao, fonte, codigo, exame_em, encerrada_em, verificada_em, tentativas, aviso_texto, avisada_em, push_em)
        values (new.id, case when coalesce((v ->> 'ok')::boolean, false) then 'confirmado' else 'verificando' end, v ->> 'fonte', v ->> 'codigo',
                nullif(v ->> 'ate', '')::timestamptz, now(), now(), 1, null, null, null)
        on conflict (conversa_id) do update set situacao = excluded.situacao, fonte = excluded.fonte, codigo = excluded.codigo, exame_em = excluded.exame_em,
          encerrada_em = excluded.encerrada_em, verificada_em = excluded.verificada_em, tentativas = 1, aviso_texto = null, avisada_em = null, push_em = null;
      exception when others then null;
      end;
    end if;
  elsif old.status = 'encerrada' and new.status is distinct from 'encerrada' then
    select aviso_texto into v_txt from public.conversa_agendado_conferencia where conversa_id = new.id;
    if found then
      delete from public.conversa_agendado_conferencia where conversa_id = new.id;
      if v_txt is not null and new.alerta_agenda = v_txt then new.alerta_agenda := null; end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.conversa_valida_agendado_trg() from public, anon, authenticated;
-- O nome 'conversa_valida_agendado' fica depois de 'conversa_exame_aberto' e antes de 'conversas_antes_update' (os gatilhos rodam em ordem alfabética).
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'conversa_valida_agendado' and tgrelid = 'public.conversas'::regclass) then
    create trigger conversa_valida_agendado before update of status on public.conversas
      for each row execute function public.conversa_valida_agendado_trg();
  end if;
end $$;

-- ===== PARTE 5: a rotina que continua conferindo (a cada 5 minutos) =====
-- Para cada conversa encerrada como Agendado:
--   verificando -> achou: confirmado (some o aviso, se havia). Não achou e passou o prazo: aviso ("não achei" / "leitura do Klingo com problema" / "mais de um paciente").
--   problema    -> se o agendamento aparecer depois, vira confirmado e o aviso some. Para de acompanhar em 7 dias.
--   confirmado  -> só vale para o cartão do Klingo: se o exame sumiu com mais de 2 h de folga antes do horário (cancelado, remarcado) ou a data mudou, avisa. Depois da data, conclui.
-- O aviso é conversas.alerta_agenda (o selo que já aparece na lista) e um push genérico à equipe (sem nome, só horário de trabalho).
create or replace function public.agendado_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  r record; v jsonb; v_ok boolean; v_cod text; v_ate timestamptz; v_txt text;
  v_prazo integer := coalesce((select case when valor ~ '^\d+$' then valor::integer end from public.config where chave = 'agendado_conferir_prazo_min'), 120);
  v_confirmadas integer := 0; v_avisos integer := 0; v_push integer := 0; v_url text; v_seg text; v_erro text;
begin
  if not pg_try_advisory_xact_lock(hashtext('agendado_vigiar')) then return jsonb_build_object('pulou', true); end if;
  v_prazo := greatest(v_prazo, 1);

  for r in
    select k.*, c.status as conv_status, c.motivo_encerramento from public.conversa_agendado_conferencia k
      join public.conversas c on c.id = k.conversa_id
     where k.situacao <> 'concluido'
     order by k.encerrada_em limit 200
  loop
    begin
      -- A conversa foi reaberta ou fechada por outro motivo: não há mais o que acompanhar.
      if r.conv_status <> 'encerrada' or coalesce(r.motivo_encerramento, '') <> 'agendado' then
        update public.conversa_agendado_conferencia set situacao = 'concluido' where conversa_id = r.conversa_id;
        continue;
      end if;
      -- Acompanhamento do que já foi confirmado só existe para o Klingo, e só até o dia do exame.
      if r.situacao = 'confirmado' and (r.fonte is distinct from 'klingo' or r.exame_em is null or r.exame_em < now() - interval '1 day') then
        update public.conversa_agendado_conferencia set situacao = 'concluido' where conversa_id = r.conversa_id;
        continue;
      end if;
      if r.situacao = 'problema' and r.encerrada_em < now() - interval '7 days' then
        update public.conversa_agendado_conferencia set situacao = 'concluido' where conversa_id = r.conversa_id;
        continue;
      end if;

      v := public.agendamento_valido_para_encerrar(r.conversa_id);
      v_ok := coalesce((v ->> 'ok')::boolean, false); v_cod := v ->> 'codigo'; v_ate := nullif(v ->> 'ate', '')::timestamptz; v_txt := null;

      if v_ok then
        if r.situacao in ('verificando', 'problema') then
          update public.conversa_agendado_conferencia set situacao = 'confirmado', fonte = v ->> 'fonte', codigo = null, exame_em = v_ate, aviso_texto = null,
            verificada_em = now(), tentativas = tentativas + 1 where conversa_id = r.conversa_id;
          if r.aviso_texto is not null then
            update public.conversas set alerta_agenda = null where id = r.conversa_id and alerta_agenda = r.aviso_texto;
          end if;
          v_confirmadas := v_confirmadas + 1;
        else
          -- confirmado pelo Klingo: a data mudou antes do exame?
          if v_ate is not null and v_ate <> r.exame_em and r.exame_em > now() then
            v_txt := 'O agendamento mudou no Klingo: agora é em ' || to_char(v_ate at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI') || '. Avise o paciente se for preciso.';
          end if;
          update public.conversa_agendado_conferencia set exame_em = coalesce(v_ate, exame_em), verificada_em = now(), tentativas = tentativas + 1 where conversa_id = r.conversa_id;
        end if;
      else
        if r.situacao = 'verificando' and now() - r.encerrada_em >= make_interval(mins => v_prazo) then
          v_txt := case v_cod
            when 'AGENDADO_AGENDA_INDISPONIVEL' then 'Encerrada como Agendado, mas não consegui conferir a agenda (a leitura do Klingo está com problema). Confira no Klingo.'
            when 'AGENDADO_AMBIGUO' then 'Encerrada como Agendado, mas há mais de um paciente possível no Klingo. Confira qual é o agendamento.'
            else 'Encerrada como Agendado, mas não achei o agendamento no Klingo. Confira se o horário foi marcado.' end;
        elsif r.situacao = 'confirmado' and v_cod = 'AGENDADO_SEM_AGENDAMENTO' and r.exame_em > now() + interval '2 hours' then   -- margem: paciente atendido um pouco antes do horário não é "exame sumiu"
          v_txt := 'O agendamento mudou no Klingo: o exame não está mais agendado (cancelado ou remarcado?). Confira com o paciente.';
        end if;
        update public.conversa_agendado_conferencia set codigo = v_cod, verificada_em = now(), tentativas = tentativas + 1 where conversa_id = r.conversa_id;
      end if;

      if v_txt is not null then
        update public.conversa_agendado_conferencia set situacao = 'problema', aviso_texto = left(v_txt, 300), avisada_em = now(), push_em = null where conversa_id = r.conversa_id;
        update public.conversas set alerta_agenda = left(v_txt, 300), atualizado_em = now() where id = r.conversa_id;
        v_avisos := v_avisos + 1;
      end if;
    exception when others then
      v_erro := coalesce(v_erro || '; ', '') || left(sqlerrm, 80);
    end;
  end loop;

  -- Push à equipe (genérico, sem nome): só em horário de trabalho; o que ficou para depois sai na primeira rodada dentro do horário.
  begin
    if public.horario_trabalho_agora() then
      with alvo as (
        select conversa_id from public.conversa_agendado_conferencia where situacao = 'problema' and avisada_em is not null and push_em is null),
      marca as (
        update public.conversa_agendado_conferencia k set push_em = now() from alvo where k.conversa_id = alvo.conversa_id returning k.conversa_id)
      select count(distinct (array(select m from unnest(public.pessoa_membros(conversa_id)) m order by m))[1]) into v_push from marca;
      if v_push > 0 then
        select valor into v_url from public.config where chave = 'equipe_push_url';
        v_seg := public.fila_aviso_segredo();
        if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
          perform net.http_post(url := v_url, body := jsonb_build_object('tipo', 'agenda', 'quantidade', v_push),
                                headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
        end if;
      end if;
    end if;
  exception when others then
    v_erro := coalesce(v_erro || '; ', '') || 'push: ' || left(sqlerrm, 80);
  end;
  return jsonb_build_object('confirmadas', v_confirmadas, 'avisos', v_avisos, 'push', v_push, 'erro', v_erro);
end $$;
revoke all on function public.agendado_vigiar() from public, anon, authenticated;

-- ===== PARTE 6: agendar (a cada 5 minutos; com a chave desligada não há linhas, então não faz nada) =====
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('agendado-vigia', '*/5 * * * *', 'select public.agendado_vigiar()');
  end if;
end $$;
