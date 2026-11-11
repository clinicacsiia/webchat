-- public.ia_precos_divergentes(p_limite integer, p_minimo_pct numeric)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.ia_precos_divergentes(p_limite integer DEFAULT 30, p_minimo_pct numeric DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_lim int := least(greatest(coalesce(p_limite, 30), 1), 200); v_min numeric := greatest(coalesce(p_minimo_pct, 10), 1); v_res jsonb;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente o administrador vê o relatório de aprendizado.' using errcode = '42501';
  end if;
  with par as (
    select distinct on (o.procedimento_norm, o.operadora_norm)
           o.procedimento, o.operadora, o.amostras, o.valor_tipico, o.valor_min, o.valor_max, o.atualizado_em,
           c.valor as catalogo, c.fonte, c.confianca,
           count(*) over (partition by o.procedimento_norm, o.operadora_norm) as n_linhas,
           round((o.valor_tipico - c.valor) / nullif(c.valor, 0) * 100, 1) as dif_pct
      from public.preco_observado o
      join public.catalogo_procedimento p on p.ativo and public.norm_chave(p.nome) = o.procedimento_norm
      join public.catalogo_preco c on c.procedimento_id = p.id and c.status = 'ativo' and c.valor is not null and c.valor > 0 and c.confianca in ('alta', 'media')
       and ((c.fonte = 'particular' and o.operadora_norm = 'PARTICULAR')
         or (c.fonte = 'convenio' and public.norm_chave(c.operadora) = o.operadora_norm))
     where o.atualizado_em > now() - interval '1 day'
     order by o.procedimento_norm, o.operadora_norm, abs(o.valor_tipico - c.valor)
  )
  select jsonb_build_object(
      'comparados', (select count(*) from par),
      'sem_referencia', (select count(*) from public.preco_observado where atualizado_em > now() - interval '1 day') - (select count(*) from par),
      'divergentes_total', (select count(*) from par where abs(dif_pct) >= v_min),
      'com_varias_linhas', (select count(*) from par where n_linhas > 1),
      'divergentes', coalesce((select jsonb_agg(jsonb_build_object('exame', d.procedimento, 'operadora', d.operadora, 'catalogo', d.catalogo,
              'klingo', d.valor_tipico, 'dif_pct', d.dif_pct, 'amostras', d.amostras, 'fonte', d.fonte, 'confianca', d.confianca) order by abs(d.dif_pct) desc)
          from (select * from par where abs(dif_pct) >= v_min order by abs(dif_pct) desc limit v_lim) d), '[]'::jsonb),
      'atualizado_em', (select max(atualizado_em) from public.preco_observado where atualizado_em > now() - interval '1 day'))
    into v_res;
  return v_res;
end $function$;

