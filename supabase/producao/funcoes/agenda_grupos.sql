-- public.agenda_grupos(p_procs integer[])
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_grupos(p_procs integer[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_g jsonb := '[]'::jsonb; p int; i int; v_cand int[]; v_placed boolean; v_len int;
begin
  foreach p in array coalesce(p_procs, '{}') loop
    v_placed := false; v_len := jsonb_array_length(v_g);
    for i in 0 .. v_len - 1 loop
      select array_agg(x::int) into v_cand from jsonb_array_elements_text(v_g -> i -> 'procs') x;
      v_cand := v_cand || p;
      if public.agenda_cobre(v_cand) then
        v_g := jsonb_set(v_g, array[i::text, 'procs'], to_jsonb(v_cand));
        v_placed := true; exit;
      end if;
    end loop;
    if not v_placed then v_g := v_g || jsonb_build_array(jsonb_build_object('procs', jsonb_build_array(p))); end if;
  end loop;
  return v_g;
end $function$;

