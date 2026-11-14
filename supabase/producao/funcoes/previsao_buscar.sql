-- public.previsao_buscar(p_conversa uuid, p_turno text, p_de date, p_ate date, p_antec_min integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.previsao_buscar(p_conversa uuid, p_turno text, p_de date, p_ate date, p_antec_min integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_todos jsonb; v_s1 jsonb; v_s2 jsonb; v_agora timestamp := now() at time zone 'America/Bahia';
begin
  select coalesce(jsonb_agg(to_jsonb(x) - 'ord' order by x.ord), '[]'::jsonb) into v_todos from (
    select o.data, o.hora, o.unidade, null::text as local, o.profissional, 30 as min, o.ordem_chegada as chegada, o.chave as oferta, row_number() over (order by o.data, o.hora) as ord
      from public.klingo_oferta o
     where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.data between p_de and p_ate
       and (o.data + o.hora::time) >= v_agora + make_interval(mins => coalesce(p_antec_min, 0))
       and (p_turno is null or p_turno = 'qualquer' or (p_turno = 'manha' and o.hora < '12:00') or (p_turno = 'tarde' and o.hora >= '12:00' and o.hora < '18:00'))
     limit 60) x;
  v_s1 := v_todos -> 0;
  if v_s1 is null then return '[]'::jsonb; end if;
  select s into v_s2 from jsonb_array_elements(v_todos) with ordinality t(s, ord) where ord > 1 order by (s ->> 'data' = v_s1 ->> 'data'), ord limit 1;
  return case when v_s2 is null then jsonb_build_array(v_s1) else jsonb_build_array(v_s1, v_s2) end;
end $function$;

