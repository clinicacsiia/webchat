-- public.ind_recorrencia_base(p_ate date, p_teste boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_recorrencia_base(p_ate date, p_teste boolean)
 RETURNS TABLE(pessoa text, dia date, chaves text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with c0 as (
    select c.contato_id, cg.grupo_id, (c.criado_em at time zone 'America/Sao_Paulo')::date as dia, x.chaves
      from public.conversas c
      join public.painel_conversa_pessoa_un() x on x.conversa_id = c.id
      left join public.conversa_grupo cg on cg.conversa_id = c.id
     where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date <= p_ate),
  rep as (select c0.contato_id, min(c0.grupo_id::text) as g from c0 where c0.grupo_id is not null group by c0.contato_id)
  select coalesce(c0.grupo_id::text, rep.g, 'c' || c0.contato_id::text), c0.dia, c0.chaves
    from c0 left join rep on rep.contato_id = c0.contato_id
$function$;

