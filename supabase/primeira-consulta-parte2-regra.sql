-- FLUXOGRAMA: entrada (conversa de consulta que chegou ao fim da escolha do médico) -> validação (modo ligado, médica listada, tipo = consulta) -> lógica (atendimento anterior com a médica em consulta_feita pelo prontuário do vínculo, ou liberação da atendente) -> saída (bloqueia true/false e o motivo)
-- Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (ver primeira-consulta-parte1-base.sql). Idempotente; sem "drop".
-- Regra do médico: se o paciente escolheu um médico, vale ele; se escolheu "tanto faz", vale a regra se QUALQUER médico oferecido for um dos listados (na dúvida, atendente).

create or replace function public.primeira_consulta_ok(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $f$
declare
  v_lista text[]; v_pref text; v_jogo text[]; pa public.pre_agendamentos; v_pront text; v_chave text; d jsonb; v_cpf text; v_nasc date;
begin
  if coalesce((select valor from public.config where chave = 'primeira_consulta_modo'), 'nao') <> 'sim' then return jsonb_build_object('bloqueia', false, 'motivo', 'desligado'); end if;
  select coalesce(array_agg(public.norm_nome(x)) filter (where public.norm_nome(x) is not null), '{}') into v_lista
    from unnest(string_to_array(coalesce((select valor from public.config where chave = 'primeira_consulta_medicas'), ''), ';')) x;
  if cardinality(v_lista) = 0 then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_medica_na_lista'); end if;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if pa.tipo is distinct from 'consulta' then return jsonb_build_object('bloqueia', false, 'motivo', 'nao_e_consulta'); end if;
  select public.norm_nome(c.medico_preferido) into v_pref from public.conversas c where c.id = p_conversa;
  if v_pref is not null then
    v_jogo := case when v_pref = any (v_lista) then array[v_pref] else '{}'::text[] end;
  else
    select coalesce(array_agg(n) filter (where n = any (v_lista)), '{}') into v_jogo
      from (select public.norm_nome(m) as n from unnest(coalesce(public.fluxo_medicos(p_conversa), '{}'::text[])) m) t;
  end if;
  if cardinality(v_jogo) = 0 then return jsonb_build_object('bloqueia', false, 'motivo', 'medica_nao_controlada'); end if;
  -- liberada à mão pela atendente (nesta conversa ou antes, pelo CPF + nascimento)
  if coalesce((select f.dados ->> 'primeira_liberada' = 'true' from public.conversa_fluxo f where f.conversa_id = p_conversa), false) then
    return jsonb_build_object('bloqueia', false, 'motivo', 'liberada');
  end if;
  begin
    d := public.klingo_dados_conversa(p_conversa); v_cpf := d ->> 'cpf'; v_nasc := (d ->> 'nascimento')::date;
    if v_cpf is not null and v_nasc is not null then v_chave := public.klingo_hash(v_cpf || '|' || v_nasc::text); end if;
  exception when others then v_chave := null;
  end;
  if v_chave is not null and exists (select 1 from public.primeira_consulta_liberada l where l.chave = v_chave) then return jsonb_build_object('bloqueia', false, 'motivo', 'liberada'); end if;
  select v.prontuario into v_pront from public.paciente_klingo_vinculo v where v.conversa_id = p_conversa and v.situacao = 'confere' and v.prontuario is not null;
  if v_pront is null then return jsonb_build_object('bloqueia', true, 'motivo', 'sem_vinculo', 'medicas', to_jsonb(v_jogo)); end if;
  if exists (select 1 from public.consulta_feita c where c.prontuario = v_pront and public.norm_nome(c.profissional) = any (v_jogo)) then
    return jsonb_build_object('bloqueia', false, 'motivo', 'tem_historico');
  end if;
  return jsonb_build_object('bloqueia', true, 'motivo', 'sem_historico', 'medicas', to_jsonb(v_jogo));
end $f$;
revoke all on function public.primeira_consulta_ok(uuid) from public, anon, authenticated;
grant execute on function public.primeira_consulta_ok(uuid) to service_role;

insert into public.fluxo_texto (chave, texto) values
 ('primeira_consulta_equipe', E'Para a primeira consulta com a nossa médica, o agendamento é feito por uma atendente, que já vai falar com você por aqui. Se {paciente} já foi atendido(a) por ela, é só avisar a atendente. 💚')
on conflict (chave) do nothing;

create or replace function public.fluxo_primeira_consulta_equipe(p_conversa uuid) returns void
language plpgsql security definer set search_path to '' as $f$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_ok jsonb := public.primeira_consulta_ok(p_conversa);
begin
  perform public.fluxo_dizer(p_conversa, public.fluxo_t('primeira_consulta_equipe', ctx), jsonb_build_object('tipo', 'acompanhar'));
  perform public.fluxo_transferir(p_conversa, 'PRIMEIRA CONSULTA com a médica (' || coalesce(v_ok ->> 'motivo', '?') || '): o Klingo não mostra atendimento anterior dele(a) com ela. Nada foi marcado. Conferir; se já foi atendido(a), use "Liberar autoatendimento" e marque, senão agende a primeira consulta.', 'media', false);
end $f$;
revoke all on function public.fluxo_primeira_consulta_equipe(uuid) from public, anon, authenticated;
grant execute on function public.fluxo_primeira_consulta_equipe(uuid) to service_role;

-- Botão do painel "Liberar autoatendimento": a atendente confirma que o paciente já foi atendido pela médica. Vale daqui em diante (pelo CPF + nascimento).
create or replace function public.painel_primeira_liberar(p_conversa uuid) returns jsonb
language plpgsql security definer set search_path to '' as $f$
declare d jsonb; v_chave text;
begin
  if (select public.papel_atual()) not in ('admin', 'atendente') then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  perform public.fluxo_set(p_conversa, '{"primeira_liberada": true}'::jsonb);
  d := public.klingo_dados_conversa(p_conversa);
  if d ->> 'cpf' is not null and d ->> 'nascimento' is not null then
    v_chave := public.klingo_hash((d ->> 'cpf') || '|' || (d ->> 'nascimento'));
    insert into public.primeira_consulta_liberada (chave, liberado_por) values (v_chave, (select auth.uid())) on conflict (chave) do nothing;
  end if;
  perform public.fluxo_nota(p_conversa, 'Atendente liberou o autoatendimento: paciente já atendido pela médica.');
  return jsonb_build_object('ok', true, 'permanente', v_chave is not null);
end $f$;
revoke all on function public.painel_primeira_liberar(uuid) from public, anon;
grant execute on function public.painel_primeira_liberar(uuid) to authenticated;
