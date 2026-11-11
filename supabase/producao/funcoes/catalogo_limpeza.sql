-- public.catalogo_limpeza()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.catalogo_limpeza()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select public.papel_atual()) is distinct from 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'gerado_em', now(),
    'ativos', (select count(*) from public.catalogo_procedimento where ativo),
    'removidos', (select count(*) from public.catalogo_procedimento where not ativo),
    'sem_agenda_vigente', (
      select jsonb_build_object('total', count(*),
             'exemplos', coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'classe', x.classe) order by x.nome) filter (where x.rn <= 30), '[]'::jsonb))
      from (select p.id, p.nome, p.classe, row_number() over (order by p.nome) rn
            from public.catalogo_procedimento p
            where p.ativo and not exists (select 1 from public.catalogo_agenda a
                     where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')) x),
    'nomes_duplicados', (
      select coalesce(jsonb_agg(jsonb_build_object('nome', d.nome, 'ids', d.ids)), '[]'::jsonb)
      from (select min(nome) nome, jsonb_agg(id order by id) ids
            from public.catalogo_procedimento where ativo group by upper(trim(nome)) having count(*) > 1) d),
    'agenda_teste', (
      select jsonb_build_object('linhas', count(*), 'profissionais', coalesce(jsonb_agg(distinct profissional), '[]'::jsonb))
      from public.catalogo_agenda where profissional ~* 'teste'),
    'sem_preco_com_agenda', (
      select jsonb_build_object('total', count(*),
             'exemplos', coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'marcacoes_90d', x.demanda_90d) order by x.demanda_90d desc nulls last) filter (where x.rn <= 30), '[]'::jsonb))
      from (select p.id, p.nome, p.demanda_90d, row_number() over (order by p.demanda_90d desc nulls last, p.nome) rn
            from public.catalogo_procedimento p
            where p.ativo
              and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')
              and not exists (select 1 from public.catalogo_preco pr where pr.procedimento_id = p.id and pr.status = 'ativo' and pr.confianca in ('alta','media'))) x),
    'sem_preparo', (select count(*) from public.catalogo_procedimento where ativo and coalesce(preparo, '') = ''),
    'mais_pedidos_sem_preparo', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'nome', t.nome, 'marcacoes_90d', t.demanda_90d) order by t.demanda_90d desc), '[]'::jsonb)
      from (select id, nome, demanda_90d from public.catalogo_procedimento where ativo and coalesce(preparo, '') = '' and demanda_90d > 0 order by demanda_90d desc limit 20) t),
    'precos_cbhpm_sem_valor_em_reais', (select count(*) from public.catalogo_preco where fonte = 'convenio' and status = 'ativo' and confianca = 'baixa'),
    'precos_particular_confianca_baixa', (select count(*) from public.catalogo_preco where fonte = 'particular' and status = 'ativo' and confianca = 'baixa'));
end $function$;

