-- Jornada do paciente na clínica, por dia do exame (10/11/2026). Só cria uma função (create or replace; sem drop, sem mexer em tabela). Pode rodar de novo.
-- painel_indicadores_jornada(p_dias, p_unidade): para cada dia do exame, quantos PACIENTES estavam marcados no Klingo e qual foi o desfecho:
--   marcados -> confirmaram -> atendidos | faltaram | cancelaram | remarcaram | sem desfecho (ainda por vir, ou o Klingo não registrou).
-- Fonte: jornada_exame (lido do Klingo pelo relatório #14359) + jornada_card (unidade). Só números: nenhum dado de paciente sai.
-- Regras (iguais ao filtro do topo do painel):
--   * Paciente = um cartão da Jornada (paciente + dia + unidade). Quem tem 2 exames no mesmo dia conta uma vez; em dois dias, conta nos dois.
--   * Desfecho do paciente no dia, nesta ordem: atendido (qualquer exame feito) > faltou > sem desfecho (agendado/confirmado) > remarcado > cancelado.
--   * Confirmou = algum exame com confirmação "Confirmado" no Klingo e que não terminou cancelado nem remarcado.
--   * Período em dias de calendário (São Paulo): 1 = hoje, 7 = hoje e os 6 anteriores, 0 = desde o começo. Dias futuros ficam de fora.
--   * Unidade: 'csi' | 'rmtc' | 'desenvoar'; nulo = todas; cartão sem unidade conhecida aparece em todas.
--   * Pedidos do chat ainda sem marcação no Klingo (status 'pedido') não entram.
-- ROLLBACK: drop function public.painel_indicadores_jornada(integer, text);

create or replace function public.painel_indicadores_jornada(p_dias integer default 0, p_unidade text default null) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ini timestamptz := case when coalesce(p_dias, 0) > 0
    then ((v_hoje - (least(p_dias, 3650) - 1))::timestamp at time zone 'America/Sao_Paulo') else '-infinity'::timestamptz end;
  v_fim timestamptz := ((v_hoje + 1)::timestamp at time zone 'America/Sao_Paulo');
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;

  with ex as (
    select c.id as card, (e.agendado_para at time zone 'America/Sao_Paulo')::date as dia, e.status,
           (e.status = 'confirmado' or lower(coalesce(e.confirm_status, '')) = 'confirmado') as conf
      from public.jornada_exame e join public.jornada_card c on c.id = e.card_id
     where e.status <> 'pedido' and e.agendado_para is not null and e.agendado_para >= v_ini and e.agendado_para < v_fim
       and (v_un is null or public.unidade_chave(c.unidade) is null or public.unidade_chave(c.unidade) = v_un)),
  pc as (
    select card, dia,
           case when bool_or(status = 'atendido') then 'atendido'
                when bool_or(status = 'faltou') then 'faltou'
                when bool_or(status in ('agendado', 'confirmado')) then 'sem_desfecho'
                when bool_or(status = 'remarcado') then 'remarcado'
                else 'cancelado' end as fim,
           bool_or(conf) as conf
      from ex group by card, dia),
  d as (
    select dia, count(*) as marcados,
           count(*) filter (where conf and fim not in ('cancelado', 'remarcado')) as confirmaram,
           count(*) filter (where fim = 'atendido') as atendidos,
           count(*) filter (where fim = 'faltou') as faltaram,
           count(*) filter (where fim = 'cancelado') as cancelaram,
           count(*) filter (where fim = 'remarcado') as remarcaram,
           count(*) filter (where fim = 'sem_desfecho') as sem_desfecho
      from pc group by dia)
  select jsonb_build_object(
    'periodo_dias', coalesce(p_dias, 0), 'unidade', v_un, 'gerado_em', now(),
    'desde', (select min((e.agendado_para at time zone 'America/Sao_Paulo')::date) from public.jornada_exame e where e.status <> 'pedido' and e.agendado_para is not null),
    'total', (select jsonb_build_object('marcados', coalesce(sum(marcados), 0), 'confirmaram', coalesce(sum(confirmaram), 0), 'atendidos', coalesce(sum(atendidos), 0),
                'faltaram', coalesce(sum(faltaram), 0), 'cancelaram', coalesce(sum(cancelaram), 0), 'remarcaram', coalesce(sum(remarcaram), 0), 'sem_desfecho', coalesce(sum(sem_desfecho), 0)) from d),
    'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', d.dia, 'marcados', d.marcados, 'confirmaram', d.confirmaram, 'atendidos', d.atendidos, 'faltaram', d.faltaram,
                'cancelaram', d.cancelaram, 'remarcaram', d.remarcaram, 'sem_desfecho', d.sem_desfecho) order by d.dia) from d), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.painel_indicadores_jornada(integer, text) from public, anon;
grant execute on function public.painel_indicadores_jornada(integer, text) to authenticated;
