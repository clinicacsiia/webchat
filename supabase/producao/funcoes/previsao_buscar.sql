-- public.previsao_buscar(p_conversa uuid, p_turno text, p_de date, p_ate date, p_antec_min integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.previsao_buscar(p_conversa uuid, p_turno text, p_de date, p_ate date, p_antec_min integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_procs int[] := public.fluxo_procs(p_conversa); v_todos jsonb; v_s1 jsonb; v_s2 jsonb;
begin
  if v_procs is null or jsonb_array_length(public.agenda_grupos(v_procs)) <> 1 then return '[]'::jsonb; end if;
  perform set_config('app.conversa', p_conversa::text, true);
  select coalesce(jsonb_agg(to_jsonb(x) - 'ord' order by x.ord), '[]'::jsonb) into v_todos from (
    select h.data, h.hora, h.unidade, h.local, h.profissional, h.duracao_min as min, h.chegada, row_number() over (order by h.data, h.hora) as ord
      from public.agenda_horarios(v_procs, p_de, p_ate, null, null, case when p_turno = 'qualquer' then null else p_turno end, '[]'::jsonb, p_antec_min) h limit 60) x;
  v_s1 := v_todos -> 0;
  if v_s1 is null then return '[]'::jsonb; end if;
  select s into v_s2 from jsonb_array_elements(v_todos) with ordinality t(s, ord) where ord > 1 order by (s ->> 'data' = v_s1 ->> 'data'), ord limit 1;
  return case when v_s2 is null then jsonb_build_array(v_s1) else jsonb_build_array(v_s1, v_s2) end;
end $function$
;
