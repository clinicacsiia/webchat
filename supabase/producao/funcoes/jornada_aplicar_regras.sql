-- public.jornada_aplicar_regras()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_aplicar_regras()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje     date := (now() at time zone 'America/Sao_Paulo')::date;
  p          jsonb;
  n_conf     integer := 0;
  n_remarc   integer := 0;
  n_prio     integer := 0;
  n_atrib    integer := 0;
  r          record;
  v_alvo     uuid;
begin
  perform pg_advisory_xact_lock(hashtext('jornada_aplicar_regras'));

  if public.jornada_regra_ativa('confirmar_proximo_dia') then
    select parametros into p from public.jornada_regra where chave = 'confirmar_proximo_dia';
    insert into public.jornada_tarefa (card_id, titulo, origem, chave, vence_em)
    select c.id, 'Confirmar presença com o paciente', 'sistema', 'confirmar',
           ((c.data_ref - coalesce((p ->> 'dias_antes')::integer, 1))::timestamp + make_interval(hours => coalesce((p ->> 'vence_hora')::integer, 16))) at time zone 'America/Sao_Paulo'
    from public.jornada_card c
    where c.coluna = 'a_confirmar' and c.arquivado_em is null and c.paciente_chave not like 'manual:%' and c.paciente_chave not like 'conv:%'
      and c.data_ref between v_hoje and v_hoje + coalesce((p ->> 'dias_antes')::integer, 1)
    on conflict (card_id, chave) where chave is not null do nothing;
    get diagnostics n_conf = row_count;
  end if;

  if public.jornada_regra_ativa('remarcar_faltou') then
    select parametros into p from public.jornada_regra where chave = 'remarcar_faltou';
    insert into public.jornada_tarefa (card_id, titulo, origem, chave, vence_em)
    select c.id, 'Ligar e oferecer nova data', 'sistema', 'remarcar',
           ((c.data_ref + 1)::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo'
    from public.jornada_card c
    where c.coluna = 'faltou' and c.arquivado_em is null
      and c.data_ref >= v_hoje - coalesce((p ->> 'dias')::integer, 1)
    on conflict (card_id, chave) where chave is not null do nothing;
    get diagnostics n_remarc = row_count;
  end if;

  if public.jornada_regra_ativa('prioridade_por_atraso') then
    for r in
      select c.id, c.coluna, c.prioridade,
             case
               when k.sla_min is null or now() - c.coluna_desde <= make_interval(mins => k.sla_min) then 0
               when now() - c.coluna_desde > make_interval(mins => k.sla_min * 2) then 3
               else 2
             end as nova
      from public.jornada_card c join public.jornada_coluna k on k.id = c.coluna
      where c.arquivado_em is null
    loop
      if r.nova <> r.prioridade then
        update public.jornada_card set prioridade = r.nova, atualizado_em = now() where id = r.id;
        if r.nova > r.prioridade then
          insert into public.jornada_evento (card_id, tipo, origem, detalhe) values (r.id, 'prioridade', 'sistema', jsonb_build_object('de', r.prioridade, 'para', r.nova, 'motivo', 'Passou do prazo da coluna.'));
        end if;
        n_prio := n_prio + 1;
      end if;
    end loop;
  end if;

  if public.jornada_regra_ativa('atribuir_por_escala') then
    for r in
      select c.id, c.coluna
      from public.jornada_card c
      where c.arquivado_em is null and c.responsavel is null and c.paciente_chave not like 'manual:%'
        and c.data_ref between v_hoje - 1 and v_hoje + 1
        and exists (select 1 from public.jornada_escala e where e.coluna = c.coluna and e.ativa)
      order by c.data_ref, c.id
    loop
      select e.usuario into v_alvo
      from public.jornada_escala e
      where e.coluna = r.coluna and e.ativa
      order by (select count(*) from public.jornada_card x where x.responsavel = e.usuario and x.arquivado_em is null and x.coluna <> 'concluido'), e.usuario
      limit 1;
      if v_alvo is not null then
        update public.jornada_card set responsavel = v_alvo, versao = versao + 1, atualizado_em = now() where id = r.id and responsavel is null;
        insert into public.jornada_evento (card_id, tipo, origem, detalhe) values (r.id, 'atribuido', 'sistema', jsonb_build_object('responsavel', v_alvo, 'motivo', 'Escala da coluna.'));
        n_atrib := n_atrib + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('tarefas_confirmar', n_conf, 'tarefas_remarcar', n_remarc, 'prioridades_mudadas', n_prio, 'atribuidos', n_atrib);
end;
$function$;

