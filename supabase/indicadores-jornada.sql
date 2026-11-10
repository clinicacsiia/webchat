-- Jornada na clínica de quem VEIO DO CHAT, acompanhada pelo histórico da pessoa (10/11/2026, v3). Só cria uma função (create or replace; sem drop, sem mexer em tabela). Pode rodar de novo.
-- painel_indicadores_jornada(p_dias, p_unidade): para cada dia de PRIMEIRO CONTATO no chat, quantas pessoas novas entraram e o que aconteceu com elas depois, no Klingo:
--   pessoas -> marcaram -> confirmaram -> atendidos | faltaram | cancelaram ou remarcaram | ainda por vir.
-- Só entra quem veio do chat; pacientes que marcaram direto no Klingo ficam de fora.
-- Fonte: conversas do chat (mesma "pessoa" do painel: conversas da mesma pessoa juntas) + jornada_paciente / jornada_card / jornada_exame (Klingo, relatório #14359). Só números: nenhum dado de paciente sai.
-- Regras:
--   * Pessoa do chat = conversas da mesma pessoa juntas (painel_conversa_pessoa_un). O dia da linha é o do PRIMEIRO contato dela (a conversa mais antiga).
--   * Ligação com o Klingo: mesmo telefone (marca de 8 últimos dígitos + segredo, a de jornada_paciente.fone_chave) E nome que confere (nome_confere);
--     ou marcação reconhecida pelo chat (pre_agendamentos.klingo_marcacoes). Telefone diferente no chat e no Klingo = não liga (a pessoa conta nas "pessoas", mas não em "marcaram").
--   * HISTÓRICO: entram todos os exames marcados no Klingo DEPOIS do primeiro contato (qualquer data, inclusive futura), não só os do dia. Exame marcado antes de a pessoa falar no chat não entra.
--   * Cada coluna é "a pessoa teve pelo menos um exame assim", então uma pessoa pode aparecer em mais de uma coluna (ex.: faltou numa data e foi atendida em outra).
--     marcaram = tem exame marcado | confirmaram = algum exame confirmado que não foi cancelado nem remarcado | atendidos = algum exame feito | faltaram = faltou em algum
--     cancelaram ou remarcaram = algum exame cancelado/remarcado | por vir = algum exame ainda agendado/confirmado (data futura, ou o Klingo não registrou o desfecho).
--   * Período em dias de calendário (São Paulo): 1 = hoje, 7 = hoje e os 6 anteriores, 0 = desde o começo (dia do primeiro contato).
--   * Unidade: 'csi' | 'rmtc' | 'desenvoar'; nulo = todas (mesma regra do painel: pessoa sem unidade conhecida aparece em todas).
--   * Pedidos do chat ainda sem marcação no Klingo (status 'pedido') não contam como marcação.
-- ROLLBACK: drop function public.painel_indicadores_jornada(integer, text);

create or replace function public.painel_indicadores_jornada(p_dias integer default 0, p_unidade text default null) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ini timestamptz := case when coalesce(p_dias, 0) > 0
    then ((v_hoje - (least(p_dias, 3650) - 1))::timestamp at time zone 'America/Sao_Paulo') else '-infinity'::timestamptz end;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;

  with sal as (select valor as v from public.config where chave = 'ia_segredo'),
  cv as (
    select c.id, pu.pessoa, c.criado_em, public.pessoa_ficha(c.id) ->> 'nome' as nome,
           case when length(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g')) >= 8
                then encode(sha256(convert_to(right(regexp_replace(ct.telefone, '\D', '', 'g'), 8) || coalesce((select v from sal), ''), 'UTF8')), 'hex') end as fh
      from public.conversas c
      join public.contatos ct on ct.id = c.contato_id
      join public.painel_conversa_pessoa_un() pu on pu.conversa_id = c.id
     where v_un is null or pu.chaves is null or cardinality(pu.chaves) = 0 or v_un = any (pu.chaves)),
  pf as (
    select pessoa, min(criado_em) as pri, (min(criado_em) at time zone 'America/Sao_Paulo')::date as dia from cv group by pessoa having min(criado_em) >= v_ini),
  lig as (
    select cv.pessoa, p.prontuario, false as por_marcacao
      from cv join public.jornada_paciente p on p.fone_chave = cv.fh and public.nome_confere(p.nome, cv.nome)
    union
    select cv.pessoa, c.paciente_chave, true
      from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id
              join public.jornada_exame e on e.marcacao_id = any (pa.klingo_marcacoes)
              join public.jornada_card c on c.id = e.card_id),
  ex as (
    select distinct pf.pessoa, e.id as exame, e.status,
           (e.status = 'confirmado' or lower(coalesce(e.confirm_status, '')) = 'confirmado') as conf
      from pf join lig on lig.pessoa = pf.pessoa
              join public.jornada_card c on c.paciente_chave = lig.prontuario
              join public.jornada_exame e on e.card_id = c.id
     where e.status <> 'pedido' and (lig.por_marcacao or e.agendado_em >= pf.pri)),
  pp as (
    select pessoa,
           bool_or(conf and status not in ('cancelado', 'remarcado')) as confirmou,
           bool_or(status = 'atendido') as atendido,
           bool_or(status = 'faltou') as faltou,
           bool_or(status in ('cancelado', 'remarcado')) as cancrem,
           bool_or(status in ('agendado', 'confirmado')) as pendente
      from ex group by pessoa),
  t as (
    select pf.dia, pf.pessoa, (pp.pessoa is not null) as marcou, coalesce(pp.confirmou, false) as confirmou, coalesce(pp.atendido, false) as atendido,
           coalesce(pp.faltou, false) as faltou, coalesce(pp.cancrem, false) as cancrem, coalesce(pp.pendente, false) as pendente
      from pf left join pp on pp.pessoa = pf.pessoa),
  d as (
    select dia, count(*) as pessoas, count(*) filter (where marcou) as marcaram, count(*) filter (where confirmou) as confirmaram,
           count(*) filter (where atendido) as atendidos, count(*) filter (where faltou) as faltaram,
           count(*) filter (where cancrem) as cancelaram_remarcaram, count(*) filter (where pendente) as por_vir
      from t group by dia)
  select jsonb_build_object(
    'periodo_dias', coalesce(p_dias, 0), 'unidade', v_un, 'gerado_em', now(),
    'desde', (select min(criado_em) from public.conversas),
    'total', (select jsonb_build_object('pessoas', coalesce(sum(pessoas), 0), 'marcaram', coalesce(sum(marcaram), 0), 'confirmaram', coalesce(sum(confirmaram), 0),
                'atendidos', coalesce(sum(atendidos), 0), 'faltaram', coalesce(sum(faltaram), 0), 'cancelaram_remarcaram', coalesce(sum(cancelaram_remarcaram), 0),
                'por_vir', coalesce(sum(por_vir), 0)) from d),
    'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', d.dia, 'pessoas', d.pessoas, 'marcaram', d.marcaram, 'confirmaram', d.confirmaram, 'atendidos', d.atendidos,
                'faltaram', d.faltaram, 'cancelaram_remarcaram', d.cancelaram_remarcaram, 'por_vir', d.por_vir) order by d.dia) from d), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.painel_indicadores_jornada(integer, text) from public, anon;
grant execute on function public.painel_indicadores_jornada(integer, text) to authenticated;
