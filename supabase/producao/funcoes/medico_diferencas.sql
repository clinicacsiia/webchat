-- public.medico_diferencas()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medico_diferencas()
 RETURNS TABLE(profissional text, unidade text, tipo text, antes jsonb, depois jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(k.profissional, b.profissional), coalesce(k.unidade, b.unidade),
         case when b.profissional is null then 'novo' when k.profissional is null then 'removido' else 'alterado' end,
         case when b.profissional is null then null else jsonb_build_object('dias', b.dias, 'hora_ini', b.hora_ini, 'hora_fim', b.hora_fim) end,
         case when k.profissional is null then null else jsonb_build_object('dias', k.dias, 'hora_ini', k.hora_ini, 'hora_fim', k.hora_fim) end
  from (select * from public.medico_klingo() x where not x.sala) k
  full join public.medico_base b on public.norm_nome(b.profissional) = public.norm_nome(k.profissional) and public.norm_nome(b.unidade) = public.norm_nome(k.unidade)
  where b.profissional is null or k.profissional is null or (b.dias, b.hora_ini, b.hora_fim) is distinct from (k.dias, k.hora_ini, k.hora_fim)
$function$;

