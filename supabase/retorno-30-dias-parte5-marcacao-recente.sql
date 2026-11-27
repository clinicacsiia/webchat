-- FLUXOGRAMA: entrada (conversa de consulta que passou da escolha do médico, ou a segunda trava antes de marcar)
--   -> validação (regra ligada, é consulta, não é remarcação; o paciente foi identificado pelo CPF + nascimento ou pelo prontuário)
--   -> lógica (retorno_recente_ok: 1º, como sempre, atendimento FEITO na mesma especialidade há menos de N dias em consulta_feita;
--      2º, NOVO: se não achou, olha a última marcação ativa de consulta que o Klingo mostrou no vínculo (relatório B, sem canceladas, até hoje):
--      data dentro dos últimos N dias e que NÃO consta em consulta_feita em outra especialidade => bloqueia com motivo 'marcacao_recente')
--   -> saída (bloqueia = true: o chat avisa que há uma consulta com menos de N dias, passa para a atendente e NÃO marca; false: segue o fluxo normal)
-- Versão 1.0 — 27/11/2026 / Mudança: Implementação inicial. Caso real de 27/11/2026: o bebê tinha consulta marcada em 25/11 (unidade CSI Pediatria) que o Klingo ainda não mostrava como Atendido; o chat marcou 21/12 sozinho (26 dias) e o convênio só autoriza com 30 dias. Outro caso igual em 18/11 (última marcação 16/11, chat marcou 11/12).
-- Por quê: a trava só enxergava consulta FEITA (Atendido no relatório #14637). Consulta que o paciente fez mas o Klingo ainda não fechou como Atendido, ou que o relatório não trouxe, passava batido.
-- Limites conhecidos: (1) o vínculo guarda só a ÚLTIMA marcação ativa e o nome do procedimento ("CONSULTA"), sem a especialidade: por isso, sem prova de que foi outra especialidade, vai para a atendente (que decide); (2) quem faltou à consulta recente também vai para a atendente; (3) só vale para marcações já passadas ou de hoje (o relatório B vai até hoje).
-- Usa só dados que já existem (paciente_klingo_vinculo.historico e consulta_feita). Nenhum relatório novo do Klingo. A chave retorno_dias_modo continua liga/desliga tudo.
-- Parte A cria o texto novo e reescreve retorno_recente_ok; parte B reescreve fluxo_retorno_equipe (aviso ao paciente e nota da equipe). Sem "drop": idempotente (create or replace).
-- ROLLBACK: recriar retorno_recente_ok e fluxo_retorno_equipe a partir da versão anterior em supabase/producao/funcoes/ (git) e, se quiser, apagar o texto: delete from public.fluxo_texto where chave = 'retorno_equipe_marcacao';
--          (ou desligar tudo na hora: update public.config set valor = 'nao' where chave = 'retorno_dias_modo';)

-- ===== PARTE A =====
insert into public.fluxo_texto (chave, texto) values
 ('retorno_equipe_marcacao', E'Identifiquei que {quem} teve uma consulta marcada há menos de {dias} dias. Alguns convênios só autorizam uma nova consulta depois desse prazo. Por isso o agendamento é feito por uma atendente, que já vai falar com você por aqui. Nada foi marcado ainda. 💚')
on conflict (chave) do nothing;

create or replace function public.retorno_recente_ok(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $f$
declare
  v_dias int; pa public.pre_agendamentos; v_pref text; v_med text[]; v_procs int[]; v_esp text[];
  v_chave text; v_pront text; d jsonb; v_cpf text; v_nasc date; r record; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_hist jsonb; v_ult date; v_esp_nome text;
begin
  if coalesce((select valor from public.config where chave = 'retorno_dias_modo'), 'nao') <> 'sim' then return jsonb_build_object('bloqueia', false, 'motivo', 'desligado'); end if;
  v_dias := coalesce(nullif((select valor from public.config where chave = 'retorno_dias_limite'), '')::int, 30);
  if v_dias < 1 then return jsonb_build_object('bloqueia', false, 'motivo', 'desligado'); end if;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if pa.tipo is distinct from 'consulta' then return jsonb_build_object('bloqueia', false, 'motivo', 'nao_e_consulta'); end if;
  if coalesce((select jsonb_typeof(f.dados -> 'remarcando') = 'object' from public.conversa_fluxo f where f.conversa_id = p_conversa), false) then
    return jsonb_build_object('bloqueia', false, 'motivo', 'remarcando');
  end if;
  select array_agg(distinct i.procedimento_id) into v_procs from public.pre_agendamento_itens i
    where i.conversa_id = p_conversa and i.ativo and i.modalidade = 'CONSULTA' and i.procedimento_id is not null;
  if v_procs is null then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_consulta'); end if;
  select public.norm_nome(c.medico_preferido) into v_pref from public.conversas c where c.id = p_conversa;
  if v_pref is not null then v_med := array[v_pref];
  else select coalesce(array_agg(distinct public.norm_nome(m)) filter (where public.norm_nome(m) is not null), '{}') into v_med from unnest(coalesce(public.fluxo_medicos(p_conversa), '{}'::text[])) m;
  end if;
  select coalesce(array_agg(distinct public.norm_nome(a.especialidade)) filter (where public.norm_nome(a.especialidade) is not null), '{}') into v_esp
    from public.catalogo_agenda a
    where a.procedimento_id = any (v_procs) and a.vig_fim >= v_hoje
      and (cardinality(v_med) = 0 or public.norm_nome(a.profissional) = any (v_med));
  if cardinality(v_esp) = 0 then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_especialidade'); end if;
  begin
    d := public.klingo_dados_conversa(p_conversa); v_cpf := d ->> 'cpf'; v_nasc := (d ->> 'nascimento')::date;
    if v_cpf is not null and v_nasc is not null then v_chave := public.klingo_hash(v_cpf || '|' || v_nasc::text); end if;
  exception when others then v_chave := null;
  end;
  select v.prontuario, v.historico into v_pront, v_hist from public.paciente_klingo_vinculo v where v.conversa_id = p_conversa and v.situacao = 'confere' and v.prontuario is not null;
  if v_chave is null and v_pront is null then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_identificacao'); end if;
  select c.atendido_em, x.esp_nome into r
    from public.consulta_feita c
    cross join lateral (
      select min(initcap(lower(a.especialidade))) as esp_nome
      from public.catalogo_agenda a join public.catalogo_procedimento p on p.id = a.procedimento_id and p.classe = 'CONSULTAS'
      where public.norm_nome(a.profissional) = public.norm_nome(c.profissional) and public.norm_nome(a.especialidade) = any (v_esp)) x
    where (c.chave = v_chave or c.prontuario = v_pront) and c.atendido_em > v_hoje - v_dias and c.atendido_em <= v_hoje and x.esp_nome is not null
    order by c.atendido_em desc limit 1;
  if r.atendido_em is not null then
    return jsonb_build_object('bloqueia', true, 'motivo', 'retorno_recente', 'especialidade', r.esp_nome, 'ultimo_em', r.atendido_em, 'dias_desde', v_hoje - r.atendido_em, 'limite', v_dias);
  end if;
  -- NOVO (27/11/2026): última marcação ativa de consulta no Klingo (vínculo) dentro do prazo que não consta como atendida em outra especialidade
  begin
    v_ult := nullif(v_hist ->> 'ultima_data', '')::date;
  exception when others then v_ult := null;
  end;
  if v_ult is not null and v_ult > v_hoje - v_dias and v_ult <= v_hoje and coalesce(v_hist ->> 'ultimo_procedimento', '') ~* '^\s*consulta'
     and not exists (select 1 from public.consulta_feita c where (c.chave = v_chave or c.prontuario = v_pront) and c.atendido_em = v_ult) then
    select min(initcap(lower(a.especialidade))) into v_esp_nome from public.catalogo_agenda a where public.norm_nome(a.especialidade) = any (v_esp) and a.procedimento_id = any (v_procs);
    return jsonb_build_object('bloqueia', true, 'motivo', 'marcacao_recente', 'especialidade', v_esp_nome, 'ultimo_em', v_ult, 'dias_desde', v_hoje - v_ult, 'limite', v_dias);
  end if;
  return jsonb_build_object('bloqueia', false, 'motivo', 'sem_atendimento_recente');
end $f$;

-- ===== PARTE B =====
create or replace function public.fluxo_retorno_equipe(p_conversa uuid) returns void
language plpgsql security definer set search_path to '' as $f$
declare v_ok jsonb := public.retorno_recente_ok(p_conversa); ctx jsonb;
begin
  ctx := public.fluxo_ctx(p_conversa) || jsonb_build_object('especialidade', coalesce(v_ok ->> 'especialidade', 'mesma especialidade'), 'dias', coalesce(v_ok ->> 'limite', '30'));
  if v_ok ->> 'motivo' = 'marcacao_recente' then
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('retorno_equipe_marcacao', ctx), jsonb_build_object('tipo', 'acompanhar'));
    perform public.fluxo_transferir(p_conversa, 'RETORNO EM MENOS DE ' || coalesce(v_ok ->> 'limite', '30') || ' DIAS: o Klingo mostra consulta marcada em ' || coalesce(to_char((v_ok ->> 'ultimo_em')::date, 'DD/MM/YYYY'), '?')
      || ' (há ' || coalesce(v_ok ->> 'dias_desde', '?') || ' dia(s)) que ainda não consta como atendida. Conferir se a consulta foi feita e se o convênio libera nova consulta antes de agendar. Nada foi marcado.', 'media', false);
  else
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('retorno_equipe', ctx), jsonb_build_object('tipo', 'acompanhar'));
    perform public.fluxo_transferir(p_conversa, 'RETORNO EM MENOS DE ' || coalesce(v_ok ->> 'limite', '30') || ' DIAS: já atendido(a) em consulta de ' || coalesce(v_ok ->> 'especialidade', '?')
      || ' há ' || coalesce(v_ok ->> 'dias_desde', '?') || ' dia(s) (' || coalesce(to_char((v_ok ->> 'ultimo_em')::date, 'DD/MM/YYYY'), '?') || ', pelo Klingo). Nada foi marcado. Conferir se é retorno e agendar com o paciente.', 'media', false);
  end if;
end $f$;
