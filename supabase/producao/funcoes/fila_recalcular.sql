-- public.fila_recalcular()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_recalcular()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_antes int; v_url text; v_seg text; v_novo boolean := false; v_n int;
begin
  select coalesce(nullif(valor, '')::int, 2) into v_antes from public.config where chave = 'fila_aviso_antes';
  v_antes := greatest(coalesce(v_antes, 2), 1);

  for r in select id, conta_id from public.fila_chegada where status = 'chamado' and public.fila_dia(chegou_em) = public.fila_dia(now()) loop
    insert into public.fila_aviso (fila_id, conta_id, tipo, titulo, corpo)
    values (r.id, r.conta_id, 'vez', 'É a sua vez!', 'Pode se dirigir ao atendimento. A equipe está esperando você.')
    on conflict (fila_id, tipo) do nothing;
    get diagnostics v_n = row_count; v_novo := v_novo or v_n > 0;
  end loop;

  for r in select id, conta_id, public.fila_posicao(id) as pos from public.fila_chegada
            where status = 'aguardando' and public.fila_dia(chegou_em) = public.fila_dia(now()) loop
    insert into public.fila_aviso (fila_id, conta_id, tipo, titulo, corpo)
    values (r.id, r.conta_id, 'chegada', 'Sua chegada foi avisada', 'Você está na posição ' || r.pos || ' da fila. Vamos avisar quando estiver perto.')
    on conflict (fila_id, tipo) do nothing;
    get diagnostics v_n = row_count; v_novo := v_novo or v_n > 0;
    if r.pos - 1 <= v_antes and r.pos > 1 then
      insert into public.fila_aviso (fila_id, conta_id, tipo, titulo, corpo)
      values (r.id, r.conta_id, 'perto', 'Está perto da sua vez', case when r.pos - 1 = 1 then 'Falta 1 pessoa à sua frente.' else 'Faltam ' || (r.pos - 1) || ' pessoas à sua frente.' end || ' Fique por perto.')
      on conflict (fila_id, tipo) do nothing;
      get diagnostics v_n = row_count; v_novo := v_novo or v_n > 0;
    end if;
  end loop;

  perform realtime.send(jsonb_build_object('evento', 'fila_mudou'), 'fila_mudou', 'fila-chegada', false);

  if v_novo then
    select valor into v_url from public.config where chave = 'fila_push_url';
    v_seg := public.fila_aviso_segredo();
    if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
      begin
        perform net.http_post(url := v_url, body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
      exception when others then null;
      end;
    end if;
  end if;
end $function$;

