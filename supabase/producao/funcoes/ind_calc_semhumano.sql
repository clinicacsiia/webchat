-- public.ind_calc_semhumano(p_de date, p_ate date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_calc_semhumano(p_de date, p_ate date)
 RETURNS TABLE(dia date, pessoa text, teste boolean, unidades text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (c.criado_em at time zone 'America/Sao_Paulo')::date, pu.pessoa, c.teste, coalesce(pu.chaves, '{}')
    from public.conversas c
    join public.painel_conversa_pessoa_un() pu on pu.conversa_id = c.id
   where (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
     and (c.primeiro_humano_em is null
          or c.primeiro_humano_em >= (((c.criado_em at time zone 'America/Sao_Paulo')::date + 1)::timestamp at time zone 'America/Sao_Paulo'))
$function$;

