-- public.app_acesso_gravar(p_pac uuid, p_aparelho uuid, p_evento text, p_local jsonb, p_disp jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_acesso_gravar(p_pac uuid, p_aparelho uuid, p_evento text, p_local jsonb, p_disp jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ip text; v_lat numeric; v_lng numeric; v_prec integer; v_dist integer; v_na boolean; v_neg boolean := false; v_clat numeric; v_clng numeric; v_raio integer; v_ex integer; v_hoje text;
  v_local_on boolean := coalesce((select valor from public.config where chave = 'app_local_ativo'), 'nao') = 'sim';
begin
  begin v_ip := left(nullif(btrim(split_part(coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ''), ',', 1)), ''), 60); exception when others then v_ip := null; end;
  if v_local_on and p_local is not null and jsonb_typeof(p_local) = 'object' then
    if coalesce(p_local ->> 'negado', '') = 'true' then v_neg := true;
    elsif coalesce(p_local ->> 'lat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' and coalesce(p_local ->> 'lng', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then
      v_lat := (p_local ->> 'lat')::numeric; v_lng := (p_local ->> 'lng')::numeric;
      if v_lat between -90 and 90 and v_lng between -180 and 180 then
        v_prec := case when coalesce(p_local ->> 'precisao', '') ~ '^[0-9]+(\.[0-9]+)?$' then least(round((p_local ->> 'precisao')::numeric), 100000)::integer end;
        select case when valor ~ '^-?[0-9]+(\.[0-9]+)?$' then valor::numeric end into v_clat from public.config where chave = 'clinica_lat';
        select case when valor ~ '^-?[0-9]+(\.[0-9]+)?$' then valor::numeric end into v_clng from public.config where chave = 'clinica_lng';
        select case when valor ~ '^[0-9]+$' then valor::int end into v_raio from public.config where chave = 'clinica_raio_m';
        if v_clat is not null and v_clng is not null then
          v_dist := public.app_distancia_m(v_lat, v_lng, v_clat, v_clng);
          v_na := v_dist <= coalesce(v_raio, 300);
        end if;
        v_lat := round(v_lat, 3); v_lng := round(v_lng, 3);
      else v_lat := null; v_lng := null; end if;
    end if;
  end if;
  v_hoje := to_char(now() at time zone 'America/Bahia', 'YYYY-MM-DD');
  begin
    select count(*)::integer into v_ex from jsonb_array_elements(public.app_pedido_dados(p_pac)) p, jsonb_array_elements(p -> 'exames') e
     where e ->> 'data' = v_hoje and coalesce((e ->> 'ok')::int, 0) between 2 and 4 and e ->> 'excecao' is null;
  exception when others then v_ex := null; end;
  insert into public.app_acesso_log (paciente_id, aparelho_id, evento, ip, agente, idioma, fuso, tela, plataforma, lat, lng, precisao_m, distancia_m, na_clinica, local_negado, exames_hoje)
  values (p_pac, p_aparelho, p_evento, v_ip, left(p_disp ->> 'agente', 200), left(p_disp ->> 'idioma', 20), left(p_disp ->> 'fuso', 60), left(p_disp ->> 'tela', 20), left(p_disp ->> 'plataforma', 60),
          v_lat, v_lng, v_prec, v_dist, v_na, v_neg, v_ex);
  return jsonb_build_object('na_clinica', v_na, 'exames_hoje', coalesce(v_ex, 0), 'local_negado', v_neg);
end $function$;

