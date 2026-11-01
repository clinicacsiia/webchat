-- FLUXOGRAMA: entrada (paciente logado abre o portal /minha-vez/) -> validação (só a própria conta; exames do Klingo só para conta com identidade conferida pela recepção; nunca horário, valor ou telefone) -> lógica (acha os cartões da Jornada da pessoa: os das próprias conversas do chat e, se a identidade foi conferida, os do Klingo com o mesmo nome e a mesma marca de telefone; cada exame ganha o seu passo de 1 a 6 e o seu estado) -> saída (RPC paciente_jornada: visitas, exames com passo, resumo "X de Y feitos, faltam Z"; coluna contas_paciente.identidade_conferida_em)
-- Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
-- Pré-requisitos: tabelas jornada_* (já no Supabase), contas_paciente (nome/telefone), conversas.conta_id, config.ia_segredo, norm_nome/nome_confere, checkin-sem-login.sql. Aditivo e idempotente. Nenhum comando destrutivo.
--
-- Passos de cada exame (o paciente vê, sem horário):
--   1 Pedido recebido · 2 Agendado · 3 Confirmado · 4 Chegada na clínica · 5 Exame realizado · 6 Laudo pronto
--   "ok" = quantos passos já foram cumpridos; o seguinte é o que está em andamento. Exceções: cancelado, remarcado, faltou.
-- Como cada status do Klingo vira passo (jornada_exame.status + confirm_status; a coluna do cartão vale para a visita inteira):
--   pedido -> 1 | agendado/A Confirmar ou Sem Resposta -> 2 | agendado ou confirmado + Confirmado -> 3 | coluna chegou -> 4 | coluna em_atendimento -> 4 + "em atendimento"
--   atendido -> 5 | atendido e coluna laudo_entregue/faturamento/nps_retorno/concluido -> 6
-- Por que a identidade conferida: o telefone e o nome da conta são digitados pelo próprio paciente; sem a conferência de alguém da recepção, qualquer pessoa poderia criar uma conta com nome e telefone de outra
-- e ver os exames dela. Contas criadas ou liberadas pela recepção (fila_criar_conta, fila_redefinir_senha) ficam conferidas.
--
-- ROLLBACK: drop function public.paciente_jornada(); (a coluna pode ficar)

alter table public.contas_paciente add column if not exists identidade_conferida_em timestamptz;

create or replace function public.paciente_jornada() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := (select auth.uid()); c public.contas_paciente%rowtype; v_sal text; v_fh text; v_hoje date := public.fila_dia(now()); v_vis jsonb;
begin
  if v_uid is null then raise exception 'Entre na sua conta para ver os seus exames.' using errcode = '28000'; end if;
  select * into c from public.contas_paciente where id = v_uid;
  if not found then return jsonb_build_object('visitas', '[]'::jsonb, 'resumo', jsonb_build_object('total', 0, 'feitos', 0, 'faltam', 0, 'laudos', 0)); end if;
  select valor into v_sal from public.config where chave = 'ia_segredo';
  if right(regexp_replace(coalesce(c.telefone, ''), '\D', '', 'g'), 8) <> '' and char_length(regexp_replace(coalesce(c.telefone, ''), '\D', '', 'g')) >= 8 then
    v_fh := encode(sha256(convert_to(right(regexp_replace(c.telefone, '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex');
  end if;

  with cartoes as (
    select jc.id, jc.data_ref, jc.unidade, jc.coluna
      from public.jornada_card jc
     where jc.arquivado_em is null and jc.data_ref >= v_hoje - 30
       and (jc.conversa_id in (select cv.id from public.conversas cv where cv.conta_id = v_uid)
            or (c.identidade_conferida_em is not null and v_fh is not null
                and jc.paciente_chave not like 'conv:%' and jc.paciente_chave not like 'manual:%'
                and exists (select 1 from public.jornada_paciente jp where jp.prontuario = jc.paciente_chave and jp.fone_chave = v_fh and public.nome_confere(jp.nome, c.nome))))
  ), ex as (
    select ca.id as card_id, ca.data_ref, ca.unidade, ca.coluna, e.id as exame_id, e.procedimento, e.status, e.confirm_status,
           case
             when e.status in ('cancelado', 'remarcado', 'faltou') then null
             when e.status = 'atendido' then case when ca.coluna in ('laudo_entregue', 'faturamento', 'nps_retorno', 'concluido') then 6 else 5 end
             when e.status = 'pedido' then 1
             when ca.coluna in ('chegou', 'em_atendimento') then 4
             when e.status = 'confirmado' or lower(coalesce(e.confirm_status, '')) = 'confirmado' then 3
             else 2
           end as ok,
           (e.status not in ('atendido', 'cancelado', 'remarcado', 'faltou', 'pedido') and ca.coluna = 'em_atendimento') as em_atendimento,
           case when e.status in ('cancelado', 'remarcado', 'faltou') then e.status end as excecao
      from cartoes ca join public.jornada_exame e on e.card_id = ca.id
  ), vis as (
    select data_ref, coalesce(unidade, '') as unidade,
           jsonb_agg(jsonb_build_object('nome', procedimento, 'ok', ok, 'em_atendimento', em_atendimento, 'excecao', excecao) order by exame_id) as exames
      from ex group by data_ref, coalesce(unidade, '')
  )
  select coalesce(jsonb_agg(jsonb_build_object('data', data_ref, 'unidade', unidade, 'exames', exames) order by data_ref), '[]'::jsonb) into v_vis from vis;

  return jsonb_build_object('visitas', v_vis,
    'conferida', c.identidade_conferida_em is not null,
    'resumo', (select jsonb_build_object(
        'total', count(*) filter (where excecao is null),
        'feitos', count(*) filter (where excecao is null and ok >= 5),
        'faltam', count(*) filter (where excecao is null and ok < 5),
        'laudos', count(*) filter (where excecao is null and ok = 6))
      from (select (x ->> 'ok')::int as ok, x ->> 'excecao' as excecao from jsonb_array_elements(v_vis) v, jsonb_array_elements(v -> 'exames') x) t));
end $$;
revoke all on function public.paciente_jornada() from public, anon;
grant execute on function public.paciente_jornada() to authenticated;
