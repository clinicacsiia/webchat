-- public.agendamento_reconhecer_fim(p_ok boolean, p_erro text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_reconhecer_fim(p_ok boolean, p_erro text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.agendamento_reconhecer_estado
     set terminou_em = now(),
         falhas = case when p_ok then 0 else falhas + 1 end,
         erro = case when p_ok then null else left(coalesce(nullif(trim(p_erro), ''), 'erro desconhecido'), 300) end,
         proximo_em = case when p_ok then null
                           else now() + case when falhas + 1 <= 4 then interval '30 seconds' when falhas + 1 <= 8 then interval '2 minutes' else interval '10 minutes' end end
   where id;
$function$;

