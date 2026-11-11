-- public.jornada_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje      date := (now() at time zone 'America/Sao_Paulo')::date;
  p           jsonb;
  v_expira    integer;
  v_min       integer;
  v_chat      jsonb;
  v_regras    jsonb;
  v_erros     text[] := '{}';
  n_atraso    integer := 0;
  n_horario   integer := 0;
  n_fechadas  integer := 0;
  n_expiradas integer := 0;
  v_saida     jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('jornada_vigiar')) then
    return jsonb_build_object('pulou', true);
  end if;

  begin
    perform public.jornada_klingo_agendar();
  exception when others then
    v_erros := v_erros || ('klingo: ' || left(sqlerrm, 120));
  end;

  begin
    v_chat := public.jornada_conversas_sincronizar();
  exception when others then
    v_erros := v_erros || ('chat: ' || left(sqlerrm, 120));
  end;

  begin
    v_regras := public.jornada_aplicar_regras();
  exception when others then
    v_erros := v_erros || ('regras: ' || left(sqlerrm, 120));
  end;

  begin
    if public.jornada_regra_ativa('alerta_atraso') then
      select parametros into p from public.jornada_regra where chave = 'alerta_atraso';
      v_expira := greatest(coalesce((p ->> 'expira_horas')::integer, 48), 1);
      with novas as (
        insert into public.jornada_tarefa (card_id, titulo, origem, chave, vence_em)
        select c.id, 'Passou do prazo em "' || k.nome || '": resolver e seguir o paciente', 'sistema', 'atraso:' || c.coluna, now()
        from public.jornada_card c
        join public.jornada_coluna k on k.id = c.coluna
        where c.arquivado_em is null
          and k.sla_min is not null
          and now() - c.coluna_desde > make_interval(mins => k.sla_min)
          and now() - c.coluna_desde <= make_interval(hours => v_expira)
          and (c.data_ref >= v_hoje - 1 or k.etapa = 'antes')
          and c.coluna in (select jsonb_array_elements_text(coalesce(p -> 'colunas', '[]'::jsonb)))
        on conflict (card_id, chave) where chave is not null do nothing
        returning card_id, chave
      )
      insert into public.jornada_evento (card_id, tipo, origem, detalhe)
      select card_id, 'tarefa', 'sistema', jsonb_build_object('acao', 'alerta', 'motivo', 'atraso', 'chave', chave) from novas;
      get diagnostics n_atraso = row_count;
    end if;
  exception when others then
    v_erros := v_erros || ('alerta_atraso: ' || left(sqlerrm, 120));
  end;

  begin
    if public.jornada_regra_ativa('alerta_horario') then
      select parametros into p from public.jornada_regra where chave = 'alerta_horario';
      v_expira := greatest(coalesce((select (parametros ->> 'expira_horas')::integer from public.jornada_regra where chave = 'alerta_atraso'), 48), 1);
      v_min := greatest(coalesce((p ->> 'minutos')::integer, 15), 1);
      with novas as (
        insert into public.jornada_tarefa (card_id, titulo, origem, chave, vence_em)
        select c.id, 'Passou do horário e o paciente ainda não foi atendido: localizar', 'sistema', 'horario', now()
        from public.jornada_card c
        where c.arquivado_em is null
          and c.coluna in ('a_confirmar', 'confirmado')
          and c.data_ref = v_hoje
          and now() - c.coluna_desde <= make_interval(hours => v_expira)
          and exists (select 1 from public.jornada_exame e
                      where e.card_id = c.id and e.status in ('agendado', 'confirmado') and e.agendado_para < now() - make_interval(mins => v_min))
        on conflict (card_id, chave) where chave is not null do nothing
        returning card_id
      )
      insert into public.jornada_evento (card_id, tipo, origem, detalhe)
      select card_id, 'tarefa', 'sistema', jsonb_build_object('acao', 'alerta', 'motivo', 'horario') from novas;
      get diagnostics n_horario = row_count;
    end if;
  exception when others then
    v_erros := v_erros || ('alerta_horario: ' || left(sqlerrm, 120));
  end;

  v_expira := greatest(coalesce((select (parametros ->> 'expira_horas')::integer from public.jornada_regra where chave = 'alerta_atraso'), 48), 1);

  begin
    with fechadas as (
      update public.jornada_tarefa t
         set feita_em = now(), chave = t.chave || '#' || t.id
        from public.jornada_card c
       where t.card_id = c.id and t.feita_em is null and t.origem = 'sistema'
         and (
           (t.chave like 'atraso:%' and (
              c.arquivado_em is not null
              or c.coluna <> substr(t.chave, 8)
              or now() - c.coluna_desde > make_interval(hours => v_expira)
              or not exists (select 1 from public.jornada_coluna k where k.id = c.coluna and k.sla_min is not null and now() - c.coluna_desde > make_interval(mins => k.sla_min))))
           or
           (t.chave = 'horario' and (
              c.arquivado_em is not null
              or c.coluna not in ('a_confirmar', 'confirmado')
              or not exists (select 1 from public.jornada_exame e where e.card_id = c.id and e.status in ('agendado', 'confirmado') and e.agendado_para < now())))
         )
      returning t.card_id, t.titulo
    )
    insert into public.jornada_evento (card_id, tipo, origem, detalhe)
    select card_id, 'tarefa', 'sistema', jsonb_build_object('acao', 'feita', 'titulo', titulo, 'motivo', 'O problema deixou de existir ou o aviso expirou.') from fechadas;
    get diagnostics n_fechadas = row_count;
  exception when others then
    v_erros := v_erros || ('fechar: ' || left(sqlerrm, 120));
  end;

  begin
    with expiradas as (
      update public.jornada_tarefa t
         set feita_em = now()
        from public.jornada_card c
       where t.card_id = c.id and t.feita_em is null and t.origem = 'sistema'
         and now() - c.coluna_desde > make_interval(hours => v_expira)
      returning t.card_id, t.titulo
    )
    insert into public.jornada_evento (card_id, tipo, origem, detalhe)
    select card_id, 'tarefa', 'sistema', jsonb_build_object('acao', 'feita', 'titulo', titulo, 'motivo', 'Aviso expirou (cartão parado há muito tempo).') from expiradas;
    get diagnostics n_expiradas = row_count;
  exception when others then
    v_erros := v_erros || ('expirar: ' || left(sqlerrm, 120));
  end;

  v_saida := jsonb_build_object('alertas_atraso', n_atraso, 'alertas_horario', n_horario, 'alertas_fechados', n_fechadas, 'alertas_expirados', n_expiradas,
                                'chat', v_chat, 'regras', v_regras, 'erros', to_jsonb(v_erros));
  update public.jornada_sync_estado
     set vigia_em = now(), vigia_resultado = v_saida, vigia_erro = nullif(array_to_string(v_erros, ' | '), '')
   where id;
  return v_saida;
end;
$function$;

