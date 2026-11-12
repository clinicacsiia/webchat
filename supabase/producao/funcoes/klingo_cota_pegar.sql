-- public.klingo_cota_pegar(p_n integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_cota_pegar(p_n integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.klingo_cota; v_agora timestamptz := clock_timestamp(); v_f numeric;
begin
  select * into c from public.klingo_cota where id for update;
  if c.pausado_ate is not null and c.pausado_ate > v_agora then
    return jsonb_build_object('ok', false, 'motivo', 'pausado', 'espera_ms', ceil(extract(epoch from c.pausado_ate - v_agora) * 1000)::int);
  end if;
  v_f := least(c.max_fichas, c.fichas + greatest(extract(epoch from v_agora - c.reposto_em), 0) * c.reposicao_por_s);
  if v_f >= p_n then
    update public.klingo_cota set fichas = v_f - p_n, reposto_em = v_agora, pausado_ate = null where id;
    return jsonb_build_object('ok', true);
  end if;
  update public.klingo_cota set fichas = v_f, reposto_em = v_agora where id;
  return jsonb_build_object('ok', false, 'motivo', 'sem_fichas', 'espera_ms', ceil((p_n - v_f) / c.reposicao_por_s * 1000)::int);
end $function$;

