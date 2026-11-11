-- public.ind_calc_conclusoes(p_de date, p_ate date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_calc_conclusoes(p_de date, p_ate date)
 RETURNS TABLE(dia date, pessoa text, teste boolean, unidades text[], origem text, motivo text, cruzou boolean, mais24 boolean, reencerrada boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (ce.encerrada_em at time zone 'America/Sao_Paulo')::date, pu.pessoa, c.teste, coalesce(pu.chaves, '{}'),
         coalesce(ce.origem, 'sem_origem'), coalesce(ce.motivo, 'sem_motivo'),
         (c.criado_em at time zone 'America/Sao_Paulo')::date < (ce.encerrada_em at time zone 'America/Sao_Paulo')::date,
         ce.encerrada_em - c.criado_em > interval '24 hours',
         exists (select 1 from public.conversa_encerramento x where x.conversa_id = ce.conversa_id and x.encerrada_em < ce.encerrada_em)
    from public.conversa_encerramento ce
    join public.conversas c on c.id = ce.conversa_id
    join public.painel_conversa_pessoa_un() pu on pu.conversa_id = c.id
   where (ce.encerrada_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
$function$;

