-- public.jornada_klingo_proximo(p_agora timestamp with time zone, p_movimento timestamp with time zone)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_klingo_proximo(p_agora timestamp with time zone, p_movimento timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_local timestamp := p_agora at time zone 'America/Sao_Paulo';
  v_h     time := v_local::time;
  v_dow   integer := extract(isodow from v_local)::integer;
  v_int   interval;
  v_dia   date;
begin
  if p_movimento is not null and p_movimento > p_agora - interval '15 minutes' then
    v_int := interval '30 seconds';
  elsif public.jornada_klingo_expediente(p_agora) then
    v_int := interval '30 seconds';
  elsif v_dow <> 7 and v_h >= time '18:30' and v_h < time '22:00' then
    v_int := interval '15 minutes';
  elsif v_h >= time '22:00' or v_h < time '05:00' then
    v_int := interval '2 hours';
  else
    v_int := interval '30 minutes';
  end if;
  v_dia := v_local::date;
  if v_h >= time '06:30' then v_dia := v_dia + 1; end if;
  while extract(isodow from v_dia) = 7 loop v_dia := v_dia + 1; end loop;
  return least(p_agora + v_int, (v_dia + time '06:30') at time zone 'America/Sao_Paulo');
end $function$;

