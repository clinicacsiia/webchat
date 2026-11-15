-- public.app_pedido_dados(p_pac uuid, p_conversa uuid)
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.app_pedido_dados(p_pac uuid, p_conversa uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with base as (
    select ac.conversa_id, ac.pessoa_nome, ac.eu, ac.visto_sig, c.status as cstatus, c.criado_em, pa.tipo as pre_tipo, pa.status as pre_status,
           pa.procedimento as pre_proc, pa.escolha_horario as pre_hor, pa.unidade as pre_unidade
      from public.app_conversa ac
      join public.conversas c on c.id = ac.conversa_id
      left join public.pre_agendamentos pa on pa.conversa_id = c.id
     where ac.paciente_id = p_pac and (p_conversa is null or ac.conversa_id = p_conversa)
  ), jor as (
    select b.conversa_id, e.id as exame_id, e.procedimento as nome, e.unidade,
           to_char(e.agendado_para at time zone 'America/Bahia', 'YYYY-MM-DD') as data, to_char(e.agendado_para at time zone 'America/Bahia', 'HH24:MI') as hora,
           case when e.status in ('cancelado', 'faltou') then null
                when e.status = 'atendido' then 5
                when e.status = 'pedido' then 1
                when jc.coluna in ('chegou', 'em_atendimento') then 4
                when e.status = 'confirmado' or lower(coalesce(e.confirm_status, '')) = 'confirmado' then 3
                else 2 end as ok,
           case when e.status in ('cancelado', 'faltou') then e.status end as excecao
      from base b
      join public.jornada_card jc on jc.conversa_id = b.conversa_id
      join public.jornada_exame e on e.card_id = jc.id
     where e.status <> 'remarcado'
  ), pre as (   -- pedido que o chat montou e o Klingo ainda não devolveu (ou nunca devolverá): itens do próprio pedido
    select b.conversa_id, null::bigint as exame_id, coalesce(nullif(i.procedimento, ''), nullif(b.pre_proc, ''), 'Atendimento') as nome, b.pre_unidade as unidade,
           b.pre_hor -> 0 ->> 'data' as data, b.pre_hor -> 0 ->> 'hora' as hora,
           case b.pre_status when 'agendado' then 2 when 'pronto' then 1 else 0 end as ok,
           case when b.pre_status = 'cancelado' then 'cancelado' end as excecao
      from base b
      left join public.pre_agendamento_itens i on i.conversa_id = b.conversa_id and i.ativo
     where not exists (select 1 from jor j where j.conversa_id = b.conversa_id)
       and b.pre_status in ('rascunho', 'pronto', 'agendado', 'cancelado')
       and (b.pre_status <> 'rascunho' or b.criado_em > now() - interval '14 days')
       and (i.id is not null or b.pre_proc is not null)
  ), todos as (
    select * from jor union all select * from pre
  ), com_res as (
    select t.*, case when t.ok = 5 then coalesce(r.estado, 'aguardando') end as res, r.id as res_id, r.conversa_resultado_id as res_conv
      from todos t
      left join public.app_resultado r on r.paciente_id = p_pac and r.conversa_id = t.conversa_id and t.exame_id is not null and r.exame_id = t.exame_id
  ), por_conversa as (
    select b.*,
           coalesce(jsonb_agg(jsonb_build_object('id', x.exame_id, 'nome', x.nome, 'unidade', x.unidade, 'data', x.data, 'hora', x.hora, 'ok', x.ok, 'excecao', x.excecao,
                                                 'resultado', x.res, 'resultado_id', x.res_id, 'resultado_conversa', x.res_conv) order by x.data nulls last, x.hora nulls last, x.nome) filter (where x.nome is not null), '[]'::jsonb) as exames,
           md5(coalesce(string_agg(coalesce(x.exame_id::text, 'p') || ':' || x.ok || ':' || coalesce(x.excecao, '') || ':' || coalesce(x.data, '') || coalesce(x.hora, '') || ':' || coalesce(x.res, ''),
                                   '|' order by x.exame_id nulls last, x.nome) filter (where x.ok >= 2 or x.excecao is not null), '')) as sig
      from base b left join com_res x on x.conversa_id = b.conversa_id
     group by b.conversa_id, b.pessoa_nome, b.eu, b.visto_sig, b.cstatus, b.criado_em, b.pre_tipo, b.pre_status, b.pre_proc, b.pre_hor, b.pre_unidade
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'conversa', conversa_id, 'pessoa', pessoa_nome, 'eu', eu, 'aberta', cstatus <> 'encerrada', 'criado_em', criado_em, 'tipo', pre_tipo, 'pre_status', pre_status,
           'exames', exames, 'sig', sig, 'novo', visto_sig is not null and visto_sig <> sig) order by criado_em desc), '[]'::jsonb)
    from por_conversa where jsonb_array_length(exames) > 0
$function$;

