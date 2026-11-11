-- public.jornada_klingo_fechar(p_atras integer, p_frente integer, p_resumo jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_klingo_fechar(p_atras integer DEFAULT 2, p_frente integer DEFAULT 30, p_resumo jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje      date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ini       timestamptz := clock_timestamp();
  r           record;
  c           public.jornada_card%rowtype;
  v_res       text;
  v_ord_alvo  integer;
  v_ord_atual integer;
  n_movidos   integer := 0;
  n_diverg    integer := 0;
  n_finaliz   integer := 0;
  n_arquiv    integer := 0;
  v_mexeu     boolean;
  v_saida     jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('jornada_klingo_fechar'));
  perform set_config('jornada.sem_aviso', '1', true);

  for r in
    select k.id, k.coluna, x.alvo
    from public.jornada_card k
    cross join lateral (select public.jornada_coluna_do_card(array_agg(e.status)) as alvo, count(*) as n from public.jornada_exame e where e.card_id = k.id and e.marcacao_id like 'm%') x
    where k.arquivado_em is null and k.paciente_chave not like 'manual:%' and k.paciente_chave not like 'conv:%'
      and k.data_ref between v_hoje - p_atras and v_hoje + p_frente and x.n > 0
  loop
    if r.coluna = r.alvo then
      continue;
    end if;
    select ordem into v_ord_alvo from public.jornada_coluna where id = r.alvo;
    select ordem into v_ord_atual from public.jornada_coluna where id = r.coluna;
    if r.alvo in ('a_confirmar', 'confirmado', 'em_atendimento') and v_ord_atual > v_ord_alvo and v_ord_atual < 20
       and not (r.coluna in ('a_confirmar', 'confirmado') and r.alvo in ('a_confirmar', 'confirmado')) then
      continue;
    end if;
    v_res := public.jornada_aplicar_klingo(r.id, r.alvo, jsonb_build_object('fonte', '13825'));
    if v_res = 'moveu' then n_movidos := n_movidos + 1; elsif v_res = 'ignorado' then n_diverg := n_diverg + 1; end if;
  end loop;

  for c in select * from public.jornada_card where coluna = 'em_atendimento' and data_ref < v_hoje and arquivado_em is null loop
    update public.jornada_card set coluna = 'finalizado', coluna_desde = now(), versao = versao + 1, atualizado_em = now() where id = c.id;
    insert into public.jornada_evento (card_id, tipo, origem, de_coluna, para_coluna, detalhe)
    values (c.id, 'movido', 'sistema', 'em_atendimento', 'finalizado', jsonb_build_object('motivo', 'O dia do atendimento já passou.'));
    n_finaliz := n_finaliz + 1;
  end loop;

  update public.jornada_card
     set arquivado_em = now(), atualizado_em = now()
   where arquivado_em is null and paciente_chave not like 'manual:%'
     and ((data_ref < v_hoje - 7 and coluna in ('concluido', 'cancelado', 'remarcado', 'faltou')) or data_ref < v_hoje - 30);
  get diagnostics n_arquiv = row_count;

  v_saida := coalesce(p_resumo, '{}'::jsonb) || jsonb_build_object('cartoes_movidos', n_movidos, 'divergencias', n_diverg, 'finalizados_sozinho', n_finaliz, 'arquivados', n_arquiv,
                            'duracao_ms', round(extract(epoch from (clock_timestamp() - v_ini)) * 1000));
  v_mexeu := coalesce((p_resumo ->> 'alteradas')::integer, 0) > 0 or n_movidos > 0 or n_finaliz > 0;
  update public.jornada_sync_estado
     set klingo_em = now(), klingo_fim_em = now(), klingo_resultado = v_saida, klingo_erro = null, klingo_falhas = 0,
         klingo_modo = coalesce(p_resumo ->> 'modo', klingo_modo),
         klingo_completo_em = case when p_resumo ->> 'modo' = 'completo' then now() else klingo_completo_em end,
         klingo_movimento_em = case when v_mexeu then now() else klingo_movimento_em end,
         klingo_proximo_em = public.jornada_klingo_proximo(now(), case when v_mexeu then now() else klingo_movimento_em end)
   where id;
  -- 1 único aviso por leitura, só se algo mudou (sem dado pessoal)
  if v_mexeu or n_arquiv > 0 then
    begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  end if;
  return v_saida;
end;
$function$;

