-- public.paciente_jornada()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.paciente_jornada()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

