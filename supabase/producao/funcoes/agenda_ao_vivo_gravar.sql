-- public.agenda_ao_vivo_gravar(p_de date, p_ate date, p_dias date[], p_iniciado timestamp with time zone, p_linhas jsonb, p_ok boolean, p_erro text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_ao_vivo_gravar(p_de date, p_ate date, p_dias date[], p_iniciado timestamp with time zone, p_linhas jsonb, p_ok boolean, p_erro text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_novas integer := 0; v_cand integer := 0; v_vistas integer := 0; v_removidas integer := 0; v_velhas integer := 0; v_suspeito boolean := false; v_res jsonb; v_valido timestamptz;
begin
  if p_de is null or p_ate is null or p_ate < p_de or p_ate - p_de > 14 or p_iniciado is null or p_dias is null then raise exception 'Parâmetros inválidos.' using errcode = '22023'; end if;
  if not coalesce(p_ok, false) then
    update public.agenda_ao_vivo a set lendo_desde = null, ok = false, erro = left(coalesce(p_erro, 'falha'), 200), atualizado_em = now() where a.dia = any (p_dias);
    return jsonb_build_object('ok', false);
  end if;
  v_novas := case when p_linhas is not null and jsonb_typeof(p_linhas) = 'array' then jsonb_array_length(p_linhas) else 0 end;
  v_res := public.agenda_ocupacao_atualizar(case when v_novas > 0 then p_linhas else '[]'::jsonb end, null, false);
  select m.valido_desde into v_valido from public.agenda_ocupacao_meta m where m.id = 1;
  select count(*) filter (where o.visto_em < p_iniciado and (v_valido is null or o.visto_em >= v_valido)), count(*) filter (where o.visto_em >= p_iniciado)
    into v_cand, v_vistas
    from public.agenda_ocupacao o
   where o.fonte = 'marcada' and o.inicio >= p_de::timestamp and o.inicio < (p_ate + 1)::timestamp;
  if v_valido is not null then
    delete from public.agenda_ocupacao o
     where o.fonte = 'marcada' and o.inicio >= p_de::timestamp and o.inicio < (p_ate + 1)::timestamp and o.visto_em < v_valido and o.visto_em < p_iniciado;
    get diagnostics v_velhas = row_count;
  end if;
  if v_cand > 2 and (v_vistas = 0 or (v_cand > 5 and v_cand > v_vistas)) then
    v_suspeito := true;
  elsif v_cand > 0 then
    delete from public.agenda_ocupacao o
     where o.fonte = 'marcada' and o.inicio >= p_de::timestamp and o.inicio < (p_ate + 1)::timestamp and o.visto_em < p_iniciado;
    get diagnostics v_removidas = row_count;
  end if;
  update public.agenda_ao_vivo a set lendo_desde = null, lido_em = p_iniciado, ok = true, erro = case when v_suspeito then 'suspeito: nada liberado' end, atualizado_em = now()
   where a.dia = any (p_dias);
  return jsonb_build_object('ok', true, 'recebidas', v_novas, 'liberadas', v_removidas, 'velhas_limpas', v_velhas, 'suspeito', v_suspeito);
end $function$;

