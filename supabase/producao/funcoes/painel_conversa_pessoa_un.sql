-- public.painel_conversa_pessoa_un()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.painel_conversa_pessoa_un()
 RETURNS TABLE(conversa_id uuid, pessoa text, chaves text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with g as (
    select c.id, coalesce(cg.grupo_id::text, c.id::text) as pessoa, c.unidade_inicial
      from public.conversas c left join public.conversa_grupo cg on cg.conversa_id = c.id),
  a as (
    select g.pessoa, array_agg(distinct public.unidade_chave(x.unidade)) filter (where public.unidade_chave(x.unidade) is not null) as k
      from g join public.v_agendamento_aberto x on x.conversa_id = g.id group by g.pessoa),
  q as (
    select g.pessoa, array_agg(distinct public.unidade_chave(j.unidade)) filter (where public.unidade_chave(j.unidade) is not null) as k
      from g join public.jornada_card j on j.conversa_id = g.id and j.arquivado_em is null group by g.pessoa),
  f as (
    select g.pessoa, array_agg(distinct public.unidade_chave(g.unidade_inicial)) filter (where public.unidade_chave(g.unidade_inicial) is not null) as k
      from g group by g.pessoa)
  select g.id, g.pessoa, coalesce(a.k, q.k, f.k)
    from g left join a on a.pessoa = g.pessoa left join q on q.pessoa = g.pessoa left join f on f.pessoa = g.pessoa
$function$;

