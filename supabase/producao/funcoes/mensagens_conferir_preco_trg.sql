-- public.mensagens_conferir_preco_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.mensagens_conferir_preco_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ref jsonb; v_tol numeric; v numeric; k int := 0; c jsonb; v_perto jsonb; v_dist numeric; v_melhor numeric; v_ok boolean;
begin
  if new.autor <> 'agente' or new.agente_id is null or new.texto is null or new.texto !~* '(R\$|reais)' then return new; end if;
  begin
    v_ref := public.preco_referencia_pedido(new.conversa_id);
    if v_ref is null then return new; end if;
    v_tol := coalesce(nullif((select valor from public.config where chave = 'alerta_preco_tolerancia_pct'), '')::numeric, 10) / 100.0;
    foreach v in array public.valores_em_reais(new.texto) loop
      k := k + 1; exit when k > 3;
      if v < 5 then continue; end if;
      v_ok := false; v_perto := null; v_melhor := null;
      for c in select * from jsonb_array_elements(v_ref -> 'candidatos') loop
        if v >= (c ->> 'de')::numeric * (1 - v_tol) and v <= (c ->> 'ate')::numeric * (1 + v_tol) then v_ok := true; exit; end if;
        v_dist := least(abs(v - (c ->> 'de')::numeric), abs(v - (c ->> 'ate')::numeric));
        if v_melhor is null or v_dist < v_melhor then v_melhor := v_dist; v_perto := c; end if;
      end loop;
      if v_ok then continue; end if;
      insert into public.alerta_preco (conversa_id, mensagem_id, agente_id, valor_informado, tipo, referencia)
      values (new.conversa_id, new.id, new.agente_id, v,
              case when v < (v_perto ->> 'de')::numeric * (1 - v_tol) then 'abaixo' else 'acima' end, v_ref);
    end loop;
  exception when others then
    raise warning 'mensagens_conferir_preco_trg: %', sqlerrm;   -- nunca atrapalha o atendimento
  end;
  return new;
end $function$;

