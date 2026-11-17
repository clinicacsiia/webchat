-- FLUXOGRAMA: entrada (conversa de consulta que passou da escolha do médico) -> validação (regra ligada, é consulta, não é remarcação)
--   -> lógica (retorno_recente_ok: especialidade pedida = especialidade dos médicos da agenda; o paciente (CPF + nascimento, ou prontuário do vínculo) foi ATENDIDO em consulta dessa especialidade há MENOS de N dias em consulta_feita)
--   -> saída (bloqueia = true: o chat avisa que o atendimento tem menos de 30 dias, passa para a atendente e NÃO marca; false: segue o fluxo normal)
-- Versão 1.0 — 17/11/2026 / Mudança: Implementação inicial. Pedido do dono: paciente que pede consulta na mesma especialidade com atendimento de menos de 30 dias é avisado e encaminhado para a atendente.
-- Fonte do histórico: consulta_feita (relatório #14637 e #14359, já em produção, ver docs/primeira-consulta.md). O relatório só traz o PROFISSIONAL, não a especialidade: a especialidade vem do cadastro do médico na agenda de consultas (catalogo_agenda, classe CONSULTAS). Atendimento com profissional que não está na agenda de consultas (exame, radiologista) não conta.
-- Limites conhecidos: (1) só vê atendimento já FEITO (Atendido) e só desde 30/08/2026; consulta marcada e ainda não feita não conta; (2) 2 médicos têm duas especialidades na agenda (Clínica Médica + outra): atendimento com eles conta para as duas, na dúvida vai para a atendente.
-- Chaves: retorno_dias_modo (sim/nao) e retorno_dias_limite (dias, padrão 30). Liga/desliga na hora em Configurações > Retorno em menos de 30 dias.
-- Sem "drop": a ferramenta de migração pede confirmação e expira em 60 s. Idempotente. Sem tabela nova (usa consulta_feita), sem dado de paciente além do que já existe.
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'retorno_dias_modo'; (desliga na hora). Para remover: recriar fluxo_proximo, fluxo_perguntar e klingo_pode_marcar a partir de supabase/producao/funcoes/ (git) e apagar retorno_recente_ok e fluxo_retorno_equipe.

insert into public.config (chave, valor) values
  ('retorno_dias_modo', 'sim'),
  ('retorno_dias_limite', '30')
on conflict (chave) do nothing;

insert into public.fluxo_texto (chave, texto) values
 ('retorno_equipe', E'Identifiquei que {quem} foi atendido(a) em consulta de {especialidade} há menos de {dias} dias. Nesse caso, o agendamento é feito por uma atendente, que já vai falar com você por aqui. Nada foi marcado ainda. 💚')
on conflict (chave) do nothing;

create or replace function public.retorno_recente_ok(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $f$
declare
  v_dias int; pa public.pre_agendamentos; v_pref text; v_med text[]; v_procs int[]; v_esp text[];
  v_chave text; v_pront text; d jsonb; v_cpf text; v_nasc date; r record; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
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
  select v.prontuario into v_pront from public.paciente_klingo_vinculo v where v.conversa_id = p_conversa and v.situacao = 'confere' and v.prontuario is not null;
  if v_chave is null and v_pront is null then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_identificacao'); end if;
  select c.atendido_em, x.esp_nome into r
    from public.consulta_feita c
    cross join lateral (
      select min(initcap(lower(a.especialidade))) as esp_nome
      from public.catalogo_agenda a join public.catalogo_procedimento p on p.id = a.procedimento_id and p.classe = 'CONSULTAS'
      where public.norm_nome(a.profissional) = public.norm_nome(c.profissional) and public.norm_nome(a.especialidade) = any (v_esp)) x
    where (c.chave = v_chave or c.prontuario = v_pront) and c.atendido_em > v_hoje - v_dias and c.atendido_em <= v_hoje and x.esp_nome is not null
    order by c.atendido_em desc limit 1;
  if r.atendido_em is null then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_atendimento_recente'); end if;
  return jsonb_build_object('bloqueia', true, 'motivo', 'retorno_recente', 'especialidade', r.esp_nome, 'ultimo_em', r.atendido_em, 'dias_desde', v_hoje - r.atendido_em, 'limite', v_dias);
end $f$;
revoke all on function public.retorno_recente_ok(uuid) from public, anon, authenticated;
grant execute on function public.retorno_recente_ok(uuid) to service_role;

create or replace function public.fluxo_retorno_equipe(p_conversa uuid) returns void
language plpgsql security definer set search_path to '' as $f$
declare v_ok jsonb := public.retorno_recente_ok(p_conversa); ctx jsonb;
begin
  ctx := public.fluxo_ctx(p_conversa) || jsonb_build_object('especialidade', coalesce(v_ok ->> 'especialidade', 'mesma especialidade'), 'dias', coalesce(v_ok ->> 'limite', '30'));
  perform public.fluxo_dizer(p_conversa, public.fluxo_t('retorno_equipe', ctx), jsonb_build_object('tipo', 'acompanhar'));
  perform public.fluxo_transferir(p_conversa, 'RETORNO EM MENOS DE ' || coalesce(v_ok ->> 'limite', '30') || ' DIAS: já atendido(a) em consulta de ' || coalesce(v_ok ->> 'especialidade', '?')
    || ' há ' || coalesce(v_ok ->> 'dias_desde', '?') || ' dia(s) (' || coalesce(to_char((v_ok ->> 'ultimo_em')::date, 'DD/MM/YYYY'), '?') || ', pelo Klingo). Nada foi marcado. Conferir se é retorno e agendar com o paciente.', 'media', false);
end $f$;
revoke all on function public.fluxo_retorno_equipe(uuid) from public, anon, authenticated;
grant execute on function public.fluxo_retorno_equipe(uuid) to service_role;
