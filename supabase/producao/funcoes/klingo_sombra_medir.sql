-- public.klingo_sombra_medir(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_sombra_medir(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb := public.klingo_dados_conversa(p_conversa); v_proc integer := (d ->> 'procedimento')::integer; v_api integer; v_grade integer; v_a_na_g integer; v_g_na_a integer;
begin
  if v_proc is null or (d ->> 'n_procedimentos')::integer <> 1 then return; end if;
  with g as (select * from public.agenda_horarios(array[v_proc], current_date, current_date + 28, null, null, null, '[]'::jsonb)),
       o as (select * from public.klingo_oferta where conversa_id = p_conversa and expira_em > now())
  select (select count(*) from o), (select count(*) from g),
         (select count(*) from o where exists (select 1 from g where g.data = o.data and g.hora = o.hora and public.klingo_prof_confere(o.profissional, g.profissional))),
         (select count(*) from g where exists (select 1 from o where g.data = o.data and g.hora = o.hora and public.klingo_prof_confere(o.profissional, g.profissional)))
    into v_api, v_grade, v_a_na_g, v_g_na_a;
  perform public.klingo_medir('sombra_api', v_api); perform public.klingo_medir('sombra_grade', v_grade);
  perform public.klingo_medir('sombra_api_na_grade', v_a_na_g); perform public.klingo_medir('sombra_grade_na_api', v_g_na_a);
exception when others then null;
end $function$;

