-- public.preco_observado_registrar(p_linhas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.preco_observado_registrar(p_linhas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n int := 0; l jsonb; v_pn text; v_on text; v_tip numeric; v_min numeric; v_max numeric; v_am int;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then return jsonb_build_object('gravadas', 0); end if;
  if jsonb_array_length(p_linhas) > 5000 then raise exception 'Linhas demais (máximo 5000).' using errcode = '22023'; end if;
  for l in select x from jsonb_array_elements(p_linhas) x loop
    begin
      v_pn := public.norm_chave(l ->> 'procedimento'); v_on := public.norm_chave(l ->> 'operadora');
      v_tip := (l ->> 'valor_tipico')::numeric; v_min := (l ->> 'valor_min')::numeric; v_max := (l ->> 'valor_max')::numeric;
      v_am := (l ->> 'amostras')::int;
      if coalesce(v_pn, '') = '' or coalesce(v_on, '') = '' or v_tip is null or v_tip <= 0 or v_min is null or v_max is null or coalesce(v_am, 0) < 1 then continue; end if;
      insert into public.preco_observado (procedimento_norm, operadora_norm, procedimento, operadora, valor_tipico, valor_min, valor_max, amostras, janela_ini, janela_fim, atualizado_em)
      values (v_pn, v_on, left(l ->> 'procedimento', 200), left(l ->> 'operadora', 120), v_tip, v_min, v_max, v_am,
              nullif(l ->> 'ini', '')::date, nullif(l ->> 'fim', '')::date, now())
      on conflict (procedimento_norm, operadora_norm) do update set
        procedimento = excluded.procedimento, operadora = excluded.operadora, valor_tipico = excluded.valor_tipico, valor_min = excluded.valor_min,
        valor_max = excluded.valor_max, amostras = excluded.amostras, janela_ini = excluded.janela_ini, janela_fim = excluded.janela_fim, atualizado_em = now();
      v_n := v_n + 1;
    exception when others then
      raise warning 'preco_observado_registrar: %', sqlerrm;
    end;
  end loop;
  return jsonb_build_object('gravadas', v_n);
end $function$;

