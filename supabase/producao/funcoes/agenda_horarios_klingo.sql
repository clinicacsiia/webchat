-- public.agenda_horarios_klingo(p_procs integer[], p_de date, p_ate date, p_unidade text, p_profissional text, p_periodo text, p_excluir jsonb, p_antecedencia_min integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_horarios_klingo(p_procs integer[], p_de date, p_ate date, p_unidade text DEFAULT NULL::text, p_profissional text DEFAULT NULL::text, p_periodo text DEFAULT NULL::text, p_excluir jsonb DEFAULT '[]'::jsonb, p_antecedencia_min integer DEFAULT 120)
 RETURNS TABLE(data date, hora text, unidade text, local text, profissional text, duracao_min integer, chegada boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select * from public.agenda_horarios_klingo_v2(p_procs, p_de, p_ate, p_unidade, p_profissional, p_periodo, p_excluir, p_antecedencia_min)
$function$;

