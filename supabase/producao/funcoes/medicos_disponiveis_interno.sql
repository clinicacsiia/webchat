-- public.medicos_disponiveis_interno(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medicos_disponiveis_interno(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_med text[]; v_procs int[]; v_g jsonb; v_hoje date := (now() at time zone 'America/Bahia')::date; v_out jsonb;
begin
  perform set_config('app.conversa', p_conversa::text, true);
  v_med := public.fluxo_medicos(p_conversa);
  v_procs := public.fluxo_procs(p_conversa);
  if v_procs is null or coalesce(cardinality(v_med), 0) = 0 then return '[]'::jsonb; end if;
  v_g := (public.agenda_grupos(v_procs)) -> 0;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;
  with h as (select * from public.agenda_horarios(v_procs, v_hoje, v_hoje + 45)),
       p as (select public.norm_nome(h.profissional) as n, min(h.data + h.hora::time) as primeiro, count(*) as livres from h group by 1)
  select coalesce(jsonb_agg(jsonb_build_object('nome', m, 'proximo', to_char(p.primeiro, 'YYYY-MM-DD HH24:MI'), 'livres', coalesce(p.livres, 0)) order by m), '[]'::jsonb)
    into v_out from unnest(v_med) m left join p on p.n = public.norm_nome(m);
  return v_out;
end $function$;

