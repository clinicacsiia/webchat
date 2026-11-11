-- public.ind_calc_pessoas(p_de date, p_ate date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_calc_pessoas(p_de date, p_ate date)
 RETURNS TABLE(dia date, pessoa text, teste boolean, unidades text[], contatos integer, entrou boolean, reentradas integer, transferencias integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with pu as (select x.conversa_id, x.pessoa, x.chaves from public.painel_conversa_pessoa_un() x),
  cv as (select c.id, pu.pessoa, coalesce(pu.chaves, '{}') as chaves, c.teste, c.criado_em, c.primeiro_humano_em from public.conversas c join pu on pu.conversa_id = c.id),
  ev as (
    select cv.pessoa, cv.teste, cv.chaves, (cv.criado_em at time zone 'America/Sao_Paulo')::date as d, 1 as contato, 0 as transf, false as ent from cv
    union all
    select cv.pessoa, cv.teste, cv.chaves, (e.em at time zone 'America/Sao_Paulo')::date, case when e.tipo = 'reaberta' then 1 else 0 end, case when e.tipo = 'transferida' then 1 else 0 end, false
      from public.conversa_evento e join cv on cv.id = e.conversa_id where e.tipo in ('reaberta', 'transferida')
    union all
    select cv.pessoa, cv.teste, cv.chaves, (cv.primeiro_humano_em at time zone 'America/Sao_Paulo')::date, 0, 0, true from cv where cv.primeiro_humano_em is not null)
  select ev.d, ev.pessoa, ev.teste, ev.chaves, sum(ev.contato)::integer, bool_or(ev.ent),
         case when bool_or(ev.ent) then greatest(sum(ev.contato) - 1, 0)::integer else 0 end, sum(ev.transf)::integer
    from ev where ev.d between p_de and p_ate
   group by ev.d, ev.pessoa, ev.teste, ev.chaves
$function$;

