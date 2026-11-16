-- public.plano_exato_chave(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.plano_exato_chave(p_conversa uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when coalesce((f.dados ->> 'plano_exato_id'), '') ~ '^[1-9][0-9]*$'
               and lower(btrim(coalesce(f.dados ->> 'plano_exato_de', ''))) = lower(btrim(coalesce(pa.plano, '')))
              then pa.plano || '#' || (f.dados ->> 'plano_exato_id') else pa.plano end
    from public.pre_agendamentos pa left join public.conversa_fluxo f on f.conversa_id = pa.conversa_id
   where pa.conversa_id = p_conversa
$function$;

