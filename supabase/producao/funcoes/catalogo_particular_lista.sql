-- public.catalogo_particular_lista(p_busca text, p_filtro text, p_limite integer, p_deslocamento integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.catalogo_particular_lista(p_busca text DEFAULT NULL::text, p_filtro text DEFAULT NULL::text, p_limite integer DEFAULT 50, p_deslocamento integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_busca text := nullif(public.norm_chave(coalesce(p_busca, '')), ''); v_lim int := least(greatest(coalesce(p_limite, 50), 1), 100); v_off int := greatest(coalesce(p_deslocamento, 0), 0);
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' and coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente administrador ou gerência.' using errcode = '42501'; end if;
  return (
    with base as (
      select p.id, p.nome, p.especialidade, case when rv.ligado then rv.valor end as valor,
             sg.valor as sug_valor, sg.ultima_marcacao as sug_data, sg.amostras as sug_amostras, sg.confianca as sug_confianca
        from public.catalogo_procedimento p
        left join lateral (select c.valor, c.ultima_marcacao, c.amostras, c.confianca from public.catalogo_preco c
                            where c.procedimento_id = p.id and c.fonte = 'particular' and c.status = 'ativo' and c.valor > 0
                            order by c.ultima_marcacao desc nulls last limit 1) sg on true
        left join public.catalogo_preco_revisao rv on rv.procedimento_id = p.id and rv.opn = 'PARTICULAR'
       where p.ativo and (v_busca is null or public.norm_chave(p.nome) like '%' || v_busca || '%')
    ), f as (
      select * from base where coalesce(p_filtro, '') = '' or (p_filtro = 'com_valor' and valor is not null) or (p_filtro = 'sem_valor' and valor is null)
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'com_valor', (select count(*) from f where valor is not null),
      'itens', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'especialidade', x.especialidade, 'valor', x.valor,
                          'sugestao', case when x.sug_valor is not null then jsonb_build_object('valor', x.sug_valor, 'data', x.sug_data, 'amostras', x.sug_amostras, 'confianca', x.sug_confianca) end) order by x.nome)
                           from (select * from f order by nome limit v_lim offset v_off) x), '[]'::jsonb)));
end $function$;

