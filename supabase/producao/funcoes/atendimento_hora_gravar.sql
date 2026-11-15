-- public.atendimento_hora_gravar(p_linhas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.atendimento_hora_gravar(p_linhas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r jsonb; v_ok integer := 0; v_ruim integer := 0;
  v_m text; v_c timestamptz; v_i timestamptz; v_f timestamptz;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'Entrada deve ser uma lista.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_linhas) > 5000 then
    raise exception 'No máximo 5000 linhas por chamada.' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_linhas) loop
    begin
      v_m := nullif(btrim(r ->> 'm'), '');
      v_c := nullif(r ->> 'chegada', '')::timestamptz; v_i := nullif(r ->> 'inicio', '')::timestamptz; v_f := nullif(r ->> 'fim', '')::timestamptz;
      if v_m is null or v_m !~ '^m[0-9]+$' or (v_c is null and v_i is null and v_f is null) then v_ruim := v_ruim + 1; continue; end if;
      insert into public.atendimento_hora as a (marcacao_id, chegada_em, inicio_em, fim_em, lido_em)
      values (v_m, v_c, v_i, v_f, now())
      on conflict (marcacao_id) do update
        set chegada_em = coalesce(excluded.chegada_em, a.chegada_em), inicio_em = coalesce(excluded.inicio_em, a.inicio_em),
            fim_em = coalesce(excluded.fim_em, a.fim_em), lido_em = now();
      v_ok := v_ok + 1;
    exception when others then
      v_ruim := v_ruim + 1;   -- hora fora de ordem, formato inválido ou exame de mais de 8 h
    end;
  end loop;
  return jsonb_build_object('gravadas', v_ok, 'recusadas', v_ruim);
end;
$function$;

