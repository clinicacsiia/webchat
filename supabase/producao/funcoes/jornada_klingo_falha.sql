-- public.jornada_klingo_falha(p_erro text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_klingo_falha(p_erro text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.jornada_sync_estado
     set klingo_erro = left(coalesce(nullif(trim(p_erro), ''), 'erro desconhecido'), 300),
         klingo_falhas = klingo_falhas + 1,
         klingo_fim_em = now(),
         klingo_proximo_em = now() + case when klingo_falhas + 1 <= 4 then interval '30 seconds' when klingo_falhas + 1 <= 8 then interval '2 minutes' else interval '10 minutes' end
   where id;
$function$;

