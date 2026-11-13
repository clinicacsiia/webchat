-- Autoatendimento Klingo: a equipe passa a ver POR QUE a marcação sozinha não aconteceu.
-- Versão 1.0 — 13/11/2026 / Mudança: caso real do teste de 13/11/2026 — o Klingo respondeu "Nenhum médico credenciado para CONSULTA (68), para operadora PLANSERV";
--   o chat usou a grade, o pedido ficou "pronto" e a única pista era "Automação não aplicada: sem_oferta_da_api" (sem dizer o motivo de verdade).
--
-- FLUXOGRAMA: o chat chega ao passo do horário -> chat-agenda-api tenta buscar os horários REAIS no Klingo
--   -> se não der (convênio sem médico, plano inativo, convênio sem tradução, Klingo fora do ar...) grava o MOTIVO em klingo_horarios_falha (klingo_horarios_motivo)
--   -> o paciente confirma -> fluxo_finalizar pergunta a klingo_pode_marcar -> "sem_oferta_da_api" agora vem com o motivo em português (detalhe)
--   -> a nota que a equipe lê na conversa diz: "Automação não aplicada: sem_oferta_da_api — o Klingo não tem médico credenciado para esta especialidade e convênio".
--   Quando a busca dá certo, o motivo antigo é apagado.
--
-- Não muda nenhuma regra de marcação: só acrescenta o motivo. Sem dado de paciente (motivo = código; detalhe = trecho curto da mensagem do Klingo, que não leva CPF nem nome).
-- ROLLBACK: no fim deste arquivo.

-- ---------- parte 1: tabela ----------
create table if not exists public.klingo_horarios_falha (
  conversa_id uuid primary key references public.conversas (id) on delete cascade,
  motivo text not null,
  detalhe text,
  em timestamptz not null default now()
);
alter table public.klingo_horarios_falha enable row level security;
revoke all on public.klingo_horarios_falha from anon, authenticated;
comment on table public.klingo_horarios_falha is 'Último motivo pelo qual o chat não recebeu horários reais do Klingo nesta conversa (só código e trecho curto; sem dado de paciente).';

-- ---------- parte 2: grava / limpa o motivo (chamada só pela Edge Function chat-agenda-api) ----------
create or replace function public.klingo_horarios_motivo(p_conversa uuid, p_motivo text, p_detalhe text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_motivo is null then
    delete from public.klingo_horarios_falha where conversa_id = p_conversa;
  else
    insert into public.klingo_horarios_falha (conversa_id, motivo, detalhe, em)
    values (p_conversa, left(btrim(p_motivo), 60), left(nullif(btrim(coalesce(p_detalhe, '')), ''), 200), now())
    on conflict (conversa_id) do update set motivo = excluded.motivo, detalhe = excluded.detalhe, em = excluded.em;
  end if;
exception when foreign_key_violation then null;   -- conversa apagada no meio: nada a registrar
end $$;

-- ---------- parte 3: o texto em português que a equipe lê ----------
create or replace function public.klingo_motivo_texto(p_conversa uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case f.motivo
    when 'sem_medico' then 'o Klingo não tem médico credenciado para esta especialidade e este convênio'
    when 'plano_inativo' then 'o convênio está inativo no Klingo'
    when 'plano_desconhecido' then 'o Klingo não reconhece o plano do convênio'
    when 'sem_traducao' then 'este convênio ainda não tem tradução para o plano do Klingo'
    when 'plano_do_cadastro_necessario' then 'o plano deste convênio só é descoberto pelo cadastro do paciente no Klingo (paciente novo não tem)'
    when 'fora_do_escopo' then 'esta especialidade ou exame ainda não foi liberado para a marcação sozinha'
    when 'dados_incompletos' then 'faltou CPF, nascimento ou convênio para buscar os horários'
    when 'sem_pedido' then 'o pedido ainda não tinha dados suficientes'
    when 'api_sem_horario' then 'o Klingo não devolveu nenhum horário livre para este pedido'
    when 'limite' then 'o limite de chamadas ao Klingo foi atingido naquele momento'
    when 'indisponivel' then 'o Klingo não respondeu os horários (falha técnica)'
    when 'sem_chave' then 'a chave de acesso ao Klingo não está configurada'
    else f.motivo end
    || case when f.detalhe is not null and f.motivo in ('indisponivel', 'sem_medico', 'plano_inativo', 'plano_desconhecido') then ' [' || f.detalhe || ']' else '' end
  from public.klingo_horarios_falha f where f.conversa_id = p_conversa
$$;

-- ---------- parte 4: klingo_pode_marcar devolve o motivo junto com "sem_oferta_da_api" ----------
create or replace function public.klingo_pode_marcar(p_conversa uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare pa public.pre_agendamentos; d jsonb; e jsonb; o public.klingo_oferta; v_id jsonb; v_pl jsonb; v_novo boolean := false; v_rem boolean := false;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if not public.klingo_ativo(p_conversa, 'klingo_api_marcar') then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_rem := coalesce((select jsonb_typeof(f.dados -> 'remarcando') = 'object' from public.conversa_fluxo f where f.conversa_id = p_conversa), false);
  if pa.id is null or (pa.status = 'agendado' and not v_rem) then return jsonb_build_object('ok', false, 'motivo', 'ja_agendado'); end if;
  if v_rem and (pa.agendado_origem is distinct from 'chat_api' or not public.klingo_ativo(p_conversa, 'klingo_api_pos')) then return jsonb_build_object('ok', false, 'motivo', 'remarcar_desligado'); end if;
  d := public.klingo_dados_conversa(p_conversa);
  if (d ->> 'n_procedimentos')::int <> 1 then return jsonb_build_object('ok', false, 'motivo', 'varios_procedimentos'); end if;
  if jsonb_typeof(pa.escolha_horario) <> 'array' or jsonb_array_length(pa.escolha_horario) <> 1 then return jsonb_build_object('ok', false, 'motivo', 'horario_nao_unico'); end if;
  e := pa.escolha_horario -> 0;
  select * into o from public.klingo_oferta where conversa_id = p_conversa and chave = e ->> 'klingo_chave' and expira_em > now() - interval '20 minutes';
  if o.id is null then
    return jsonb_build_object('ok', false, 'motivo', 'sem_oferta_da_api',
      'detalhe', coalesce(public.klingo_motivo_texto(p_conversa), 'o chat não recebeu horários reais do Klingo nesta conversa (o horário escolhido veio da grade)'));
  end if;
  if o.procedimento is distinct from (d ->> 'procedimento')::int
     and not exists (select 1 from public.klingo_especialidade e where (d ->> 'procedimento')::int = any (e.procedimentos) and o.procedimento = any (e.procedimentos)) then
    return jsonb_build_object('ok', false, 'motivo', 'oferta_de_outro_procedimento');
  end if;
  if d ->> 'cpf' is null or d ->> 'nascimento' is null or d ->> 'nome' is null or d ->> 'sexo' is null then return jsonb_build_object('ok', false, 'motivo', 'dados_incompletos'); end if;
  v_id := d -> 'identidade';
  if v_id is not null and jsonb_typeof(v_id) = 'object' then
    if v_id ->> 'situacao' in ('divergente', 'sem_id_definitivo') then return jsonb_build_object('ok', false, 'motivo', 'cadastro_divergente'); end if;
    if v_id ->> 'situacao' = 'nao_encontrado' then v_novo := true; end if;
  end if;
  if v_novo and not public.klingo_ativo(p_conversa, 'klingo_api_pre_cadastro') then return jsonb_build_object('ok', false, 'motivo', 'paciente_novo'); end if;
  v_pl := public.klingo_plano_resolver(pa.plano, nullif(v_id ->> 'plano_id', '')::int);
  if (v_pl ->> 'plano_id') is null and not (v_id is null or v_id ->> 'situacao' is null) then return jsonb_build_object('ok', false, 'motivo', coalesce(v_pl ->> 'motivo', 'sem_plano')); end if;
  if (v_pl ->> 'plano_id') is not null and (v_pl ->> 'plano_id')::int is distinct from o.plano and (v_pl ->> 'via') = 'padrao' and o.plano <> (v_pl ->> 'plano_id')::int and v_id is not null then
    return jsonb_build_object('ok', false, 'motivo', 'plano_mudou_depois_da_oferta');
  end if;
  if pa.tipo = 'exame' and public.norm_nome(pa.plano) <> 'PARTICULAR' and public.klingo_cfg('klingo_api_exame_convenio', 'nao') <> 'sim' then
    return jsonb_build_object('ok', false, 'motivo', 'exame_com_convenio');
  end if;
  return jsonb_build_object('ok', true, 'novo', v_novo, 'remarcar', v_rem);
end $function$;

-- ---------- parte 5: fluxo_finalizar escreve o motivo na nota da conversa ----------
create or replace function public.fluxo_finalizar(p_conversa uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_pode jsonb; v_op uuid; v_rem jsonb; pa public.pre_agendamentos;
begin
  select f.dados -> 'remarcando' into v_rem from public.conversa_fluxo f where f.conversa_id = p_conversa;
  begin v_pode := public.klingo_pode_marcar(p_conversa); exception when others then v_pode := jsonb_build_object('ok', false, 'motivo', 'erro_interno'); end;
  if coalesce((v_pode ->> 'ok')::boolean, false) then
    begin
      v_op := public.klingo_operacao_criar(p_conversa);
      update public.conversa_fluxo set passo = 'marcando', dados = dados || jsonb_build_object('enviado_em', now(), 'operacao', v_op), atualizado_em = now() where conversa_id = p_conversa;
      perform public.fluxo_dizer(p_conversa, public.fluxo_t(case when jsonb_typeof(v_rem) = 'object' then 'remarcando' else 'marcando' end, ctx), jsonb_build_object('tipo', 'marcando', 'operacao', v_op));
      return;
    exception when others then null;
    end;
  end if;
  if jsonb_typeof(v_rem) = 'object' then
    select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
    perform public.fluxo_nota(p_conversa, 'Remarcação pedida pelo chat, mas a automação não pôde fazer (' || coalesce(v_pode ->> 'motivo', '?') || coalesce(' — ' || (v_pode ->> 'detalhe'), '') || '). O agendamento atual (voucher ' || coalesce(v_rem ->> 'voucher', '?') || ') continua valendo; novo horário escolhido: '
      || coalesce((pa.escolha_horario -> 0 ->> 'data') || ' ' || (pa.escolha_horario -> 0 ->> 'hora'), 'nenhum') || '.');
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('marcar_equipe', ctx));
    perform public.fluxo_transferir(p_conversa, 'Paciente quer remarcar o agendamento (novo horário escolhido no chat).', 'baixa', false);
    update public.conversa_fluxo set dados = dados - 'remarcando', atualizado_em = now() where conversa_id = p_conversa;
    return;
  end if;
  perform public.fluxo_finalizar_humano(p_conversa, case when coalesce(v_pode ->> 'motivo', 'desligado') in ('desligado', 'ja_agendado') then null
    else 'Automação não aplicada: ' || (v_pode ->> 'motivo') || coalesce(' — ' || (v_pode ->> 'detalhe'), '') end);
end $function$;

-- ---------- parte 6: quem pode executar ----------
revoke all on function public.klingo_horarios_motivo(uuid, text, text) from public, anon, authenticated;
grant execute on function public.klingo_horarios_motivo(uuid, text, text) to service_role;
revoke all on function public.klingo_motivo_texto(uuid) from public, anon, authenticated;
grant execute on function public.klingo_motivo_texto(uuid) to service_role;

-- ======================= ROLLBACK =======================
-- 1) Voltar klingo_pode_marcar e fluxo_finalizar à versão anterior: reaplicar supabase/producao/funcoes/klingo_pode_marcar.sql e fluxo_finalizar.sql do commit anterior.
-- 2) drop function if exists public.klingo_motivo_texto(uuid);
--    drop function if exists public.klingo_horarios_motivo(uuid, text, text);
--    drop table if exists public.klingo_horarios_falha;
