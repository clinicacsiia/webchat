-- public.app_pedido_dados(p_pac uuid, p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_pedido_dados(p_pac uuid, p_conversa uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with hoje as (
    select to_char(now() at time zone 'America/Bahia', 'YYYY-MM-DD') as d
  ), base as (
    select ac.conversa_id, ac.pessoa_nome, ac.eu, ac.visto_sig, c.status as cstatus, c.criado_em, c.atualizado_em, c.encerrada_em, c.motivo_encerramento as motivo,
           c.encerramento_origem as origem, c.primeiro_humano_em, pa.tipo as pre_tipo, pa.status as pre_status,
           pa.procedimento as pre_proc, pa.escolha_horario as pre_hor, pa.unidade as pre_unidade
      from public.app_conversa ac
      join public.conversas c on c.id = ac.conversa_id
      left join public.pre_agendamentos pa on pa.conversa_id = c.id
     where ac.paciente_id = p_pac and (p_conversa is null or ac.conversa_id = p_conversa)
       and (ac.removido_em is null or c.status <> 'encerrada' or c.encerrada_em > ac.removido_em)
  ), jor_fonte as (
    select b.conversa_id, b.pre_status, false as do_klingo, e.id as exame_id, e.procedimento, e.unidade, e.marcacao_id, e.status, e.confirm_status, e.checkin_em, e.agendado_para, jc.coluna
      from base b
      join public.jornada_card jc on jc.conversa_id = b.conversa_id
      join public.jornada_exame e on e.card_id = jc.id
     where e.status <> 'remarcado'
    union all
    select b.conversa_id, b.pre_status, true, e.id, e.procedimento, e.unidade, e.marcacao_id, e.status, e.confirm_status, e.checkin_em, e.agendado_para, jc.coluna
      from base b
      join public.pre_agendamentos pa on pa.conversa_id = b.conversa_id
      cross join lateral unnest(coalesce(pa.klingo_marcacoes, '{}'::text[])) as m(id)
      join public.jornada_exame e on e.marcacao_id = 'm' || m.id
      join public.jornada_card jc on jc.id = e.card_id
     where e.status <> 'remarcado' and jc.conversa_id is distinct from b.conversa_id
  ), jor as (
    select f.conversa_id, f.exame_id, f.procedimento as nome, f.unidade,
           case when f.marcacao_id ~ '^m\d+$' then substr(f.marcacao_id, 2) end as voucher,
           case when (f.checkin_em at time zone 'America/Bahia')::date = (f.agendado_para at time zone 'America/Bahia')::date then to_char(f.checkin_em at time zone 'America/Bahia', 'HH24:MI') end as chegada,
           to_char(f.agendado_para at time zone 'America/Bahia', 'YYYY-MM-DD') as data, to_char(f.agendado_para at time zone 'America/Bahia', 'HH24:MI') as hora,
           case when f.status in ('cancelado', 'faltou') or (f.status = 'pedido' and f.pre_status = 'cancelado') then null
                when f.status = 'atendido' then 5
                when f.status = 'pedido' then 1
                when f.coluna in ('chegou', 'em_atendimento') then 4
                when (f.checkin_em at time zone 'America/Bahia')::date = (f.agendado_para at time zone 'America/Bahia')::date then 4
                when f.status = 'confirmado' or lower(coalesce(f.confirm_status, '')) = 'confirmado' then 3
                else 2 end as ok,
           case when f.status in ('cancelado', 'faltou') then f.status when f.status = 'pedido' and f.pre_status = 'cancelado' then 'cancelado' end as excecao
      from jor_fonte f
     where not (f.status = 'pedido' and f.pre_status in ('agendado', 'cancelado') and exists (select 1 from jor_fonte k where k.conversa_id = f.conversa_id and k.do_klingo))
  ), pre as (
    select b.conversa_id, null::bigint as exame_id, coalesce(nullif(i.procedimento, ''), nullif(b.pre_proc, ''), 'Atendimento') as nome, b.pre_unidade as unidade,
           null::text as voucher, null::text as chegada,
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

           coalesce(jsonb_agg(jsonb_build_object('id', x.exame_id, 'nome', x.nome, 'unidade', x.unidade, 'data', x.data, 'hora', x.hora, 'ok', x.ok, 'excecao', x.excecao, 'voucher', x.voucher, 'chegada', x.chegada,
                                                 'resultado', x.res, 'resultado_id', x.res_id, 'resultado_conversa', x.res_conv)
                             order by (x.data is not null and x.data < (select d from hoje)), case when x.data >= (select d from hoje) then x.data end, x.data desc nulls last, x.hora, x.nome)
                    filter (where x.nome is not null), '[]'::jsonb) as exames,
           md5(coalesce(string_agg(coalesce(x.exame_id::text, 'p') || ':' || coalesce(x.ok::text, 'x') || ':' || coalesce(x.excecao, '') || ':' || coalesce(x.data, '') || coalesce(x.hora, '') || ':' || coalesce(x.res, ''),
                                   '|' order by x.exame_id nulls last, x.nome) filter (where x.ok >= 2 or x.excecao is not null), '')
               || case when b.cstatus = 'encerrada' then '|enc:' || coalesce(b.encerrada_em::text, '') else '' end) as sig,
           min(x.data) filter (where x.excecao is null and x.ok < 5 and x.data >= (select d from hoje)) as proxima,
           coalesce(bool_or(x.ok between 2 and 5), false) as tem_exame_ativo,
           max(x.data) filter (where x.ok between 2 and 4) as ultima_data
      from base b left join com_res x on x.conversa_id = b.conversa_id
     group by b.conversa_id, b.pessoa_nome, b.eu, b.visto_sig, b.cstatus, b.criado_em, b.atualizado_em, b.encerrada_em, b.motivo, b.origem, b.primeiro_humano_em,
              b.pre_tipo, b.pre_status, b.pre_proc, b.pre_hor, b.pre_unidade
  ), pronto as (
    select pc.*,
           case when pc.cstatus = 'encerrada' and pc.encerrada_em is not null
                then greatest(pc.encerrada_em, coalesce(case when pc.ultima_data ~ '^\d{4}-\d{2}-\d{2}$' then pc.ultima_data::date::timestamp at time zone 'America/Bahia' end, pc.encerrada_em)) + interval '30 days' end as apaga_em
      from por_conversa pc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'conversa', conversa_id, 'pessoa', pessoa_nome, 'eu', eu, 'aberta', cstatus <> 'encerrada', 'status', cstatus, 'criado_em', criado_em, 'atualizado_em', atualizado_em,
           'tipo', pre_tipo, 'pre_status', pre_status, 'exames', exames, 'sig', sig, 'novo', visto_sig is not null and visto_sig <> sig,
           'encerrada_em', encerrada_em, 'motivo', motivo, 'origem', origem, 'apaga_em', apaga_em, 'proxima', proxima,
           'pode_reabrir', cstatus = 'encerrada' and origem is distinct from 'paciente' and encerrada_em > now() - interval '30 days',
           'pode_avaliar', cstatus = 'encerrada' and motivo is distinct from 'nao_respondido'
                           and coalesce((select valor from public.config where chave = 'avaliacao_ativa'), 'nao') = 'sim'
                           and exists (select 1 from public.mensagens m where m.conversa_id = pronto.conversa_id and (m.opcoes ->> 'tipo') = 'despedida' and (m.opcoes ->> 'encerrada_em')::timestamptz = pronto.encerrada_em)
                           and not exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = pronto.conversa_id and a.encerrada_em = pronto.encerrada_em),
           'avaliou', cstatus = 'encerrada' and exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = pronto.conversa_id and a.encerrada_em = pronto.encerrada_em),
           'pode_apagar', cstatus = 'encerrada' or (not tem_exame_ativo and coalesce(pre_status, '') <> 'agendado'),
           'cancela_ao_apagar', cstatus <> 'encerrada',
           'reservado', proxima is not null and tem_exame_ativo)

         order by (cstatus = 'encerrada'), case when cstatus <> 'encerrada' then proxima end nulls last,
                  case when cstatus = 'encerrada' then encerrada_em else atualizado_em end desc nulls last, criado_em desc), '[]'::jsonb)
    from pronto
   where (jsonb_array_length(exames) > 0
          or (cstatus = 'encerrada' and origem is distinct from 'paciente' and coalesce(motivo, '') not in ('nao_respondido', 'nova_conversa'))
          or (cstatus <> 'encerrada' and primeiro_humano_em is not null))
     and not (cstatus = 'encerrada' and apaga_em < now())
$function$;

