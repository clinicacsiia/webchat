-- public.catalogo_exames_regiao(p_modalidade text, p_regiao text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.catalogo_exames_regiao(p_modalidade text, p_regiao text)
 RETURNS TABLE(id integer, nome text, unilateral boolean, bilateral boolean, marcacoes_90d integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with base as (
    select p.id, p.nome, p.demanda_90d, regexp_replace(public.norm_nome(p.nome), 'NAO INCLUI.*$', '') as chave
    from public.catalogo_procedimento p
    where p.ativo and p.modalidade = p_modalidade
      and public.norm_nome(p.nome) !~ 'ACRESCENTAR|\mPCTE\M|PACOTE|\mCONTRASTE\M|RECONSTRUCAO|PLANEJAMENTO|PUNCAO|BIOPSIA|DRENAGEM|AMNIOCENTESE|RADIOCIRURGIA|SEDACAO|ADICIONAL'
      and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')
  ), sel as (
    select b.* from base b where
      case when p_regiao = 'todos' then true
           when p_regiao = 'outros' then not exists (select 1 from public.catalogo_regiao r where b.chave ~ r.padrao)
           else exists (select 1 from public.catalogo_regiao r where r.codigo = p_regiao and b.chave ~ r.padrao) end
  )
  select s.id, s.nome, s.nome ~* 'UNILATERAL', s.nome ~* 'BILATERAL', coalesce(s.demanda_90d, 0)
  from sel s
  where not exists (select 1 from sel s2 where s2.id <> s.id and length(s2.nome) > length(s.nome) and s2.nome like s.nome || '%')
  order by coalesce(s.demanda_90d, 0) desc, s.nome limit 24
$function$;

