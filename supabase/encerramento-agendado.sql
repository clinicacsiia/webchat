-- FLUXOGRAMA: entrada (a equipe encerra uma conversa pelo painel com o motivo Agendado) -> validação (o servidor procura um agendamento vigente da pessoa: pré-agendamento 'agendado' em aberto, ou cartão do Klingo ligado por prontuário confirmado ou por nome + telefone; se nada aparece, diferencia "sem agendamento", "mais de um paciente possível" e "leitura do Klingo atrasada") -> lógica (exame ainda futuro deixa de bloquear o encerramento SÓ quando o motivo é Agendado; exame que já passou e os outros motivos continuam bloqueados) -> saída (erro com código e frase legível, ou a conversa encerra).
-- Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-04 da Atualização do WebChat). Decisão D2 aprovada.
-- Pré-requisitos: encerramento-motivo.sql (motivo_encerramento), pessoa-unica.sql (v_agendamento_aberto, pessoa_membros, conversa_exame_aberto_trg), pessoa-unica-jornada.sql (pessoa_klingo_vinculo), jornada (jornada_card, jornada_exame, jornada_paciente, jornada_sync_estado). Aditivo e idempotente. Nenhum comando destrutivo.
-- LIGAR: Configurações > Encerramento e avaliação > "Conferir a agenda ao encerrar como Agendado" (config.encerramento_valida_agendado = 'sim'). Começa 'nao': tudo continua como hoje.
-- Limite conhecido: a UNIDADE não é comparada, porque os nomes diferem entre o chat (CSI, DESENVOAR…) e o Klingo (CSI 1, CSI 2, CSI Pediatria). A identidade (pessoa unida, prontuário confirmado, nome + telefone) é o que protege contra cruzar pacientes.
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'encerramento_valida_agendado';  (efeito imediato). Para voltar a função: definição anterior de conversa_exame_aberto_trg em pessoa-unica.sql; drop trigger conversa_valida_agendado (pede confirmação no Supabase).

-- ===== PARTE 1: chave =====
insert into public.config (chave, valor) values ('encerramento_valida_agendado', 'nao') on conflict (chave) do nothing;

-- ===== PARTE 2: a pessoa tem agendamento vigente? =====
create or replace function public.agendamento_valido_para_encerrar(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_mem uuid[] := public.pessoa_membros(p_conversa);
  v_a integer; v_k integer; v_sal text; v_erro text; v_em timestamptz; v_atrasado boolean;
begin
  -- A) exame marcado pelo chat e ainda sem desfecho
  select count(*) into v_a from public.v_agendamento_aberto v where v.conversa_id = any (v_mem);
  if v_a > 0 then return jsonb_build_object('ok', true, 'fonte', 'chat', 'exames', v_a); end if;

  -- B) cartão do Klingo com exame vigente, ligado à pessoa por prontuário confirmado OU por nome + marca do telefone
  select valor into v_sal from public.config where chave = 'ia_segredo';
  select count(distinct c.paciente_chave) into v_k
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
  if v_k = 1 then return jsonb_build_object('ok', true, 'fonte', 'klingo', 'exames', 1); end if;
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

-- ===== PARTE 4: valida o motivo Agendado no encerramento =====
create or replace function public.conversa_valida_agendado_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v jsonb;
begin
  if new.status = 'encerrada' and old.status is distinct from 'encerrada' and new.motivo_encerramento = 'agendado'
     and coalesce((select public.papel_atual()), '') <> ''
     and coalesce((select valor from public.config where chave = 'encerramento_valida_agendado'), 'nao') = 'sim' then
    v := public.agendamento_valido_para_encerrar(new.id);
    if not coalesce((v ->> 'ok')::boolean, false) then
      raise exception '%: %', v ->> 'codigo', v ->> 'mensagem' using errcode = 'P0001';
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
