-- Cardápio do catálogo: cada exame com o preço por operadora (e Particular) e aviso quando o catálogo diverge do que o Klingo está lançando.
-- Só leitura. Preço do catálogo = catalogo_preco (ativo). Preço lançado = preco_observado (marcações do Klingo, última leitura, agregado sem dado de paciente).
--
-- Estado de cada linha (exame x operadora):
--   ok         catálogo confiável (alta/média) e dentro do limite do que o Klingo lança  -> mostra o preço do catálogo
--   divergente catálogo confiável, mas o Klingo lança outro valor (diferença >= limite)   -> mostra o preço lançado, como previsão, com aviso
--   previsao   catálogo sem preço confiável (ex.: CBHPM sem valor em reais) mas há marcações -> mostra o preço lançado, como previsão
--   sem_preco  nem catálogo confiável nem marcações                                         -> sem valor
-- Depende de catalogo-preco-revisao.sql (aplicar aquele antes).
-- Parte interna sem checagem de papel (só o banco chama); a pública exige administrador.


create or replace function public.catalogo_cardapio_dados(p_busca text default null, p_operadora text default null, p_filtro text default null,
                                                         p_limite integer default 40, p_deslocamento integer default 0, p_limite_pct numeric default 10)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_busca text := nullif(public.norm_chave(coalesce(p_busca, '')), '');
  v_op text := nullif(public.norm_chave(coalesce(p_operadora, '')), '');
  v_lim int := least(greatest(coalesce(p_limite, 40), 1), 100);
  v_off int := greatest(coalesce(p_deslocamento, 0), 0);
  v_pct numeric := least(greatest(coalesce(p_limite_pct, 10), 1), 100);
  v_filtro text := case when p_filtro in ('alerta', 'previsao', 'sem_preco', 'ligado', 'nao_ligado') then p_filtro else null end;
  v_res jsonb;
begin
  with obs as (
    select p.id as pid, o.operadora_norm as opn, o.operadora, o.valor_tipico, o.valor_min, o.valor_max, o.amostras, o.atualizado_em
      from public.preco_observado o
      join public.catalogo_procedimento p on p.ativo and public.norm_chave(p.nome) = o.procedimento_norm
     where o.atualizado_em > now() - interval '1 day'
  ),
  cat as (
    select c.procedimento_id as pid, c.fonte, c.tabela, c.valor, c.confianca,
           case when c.fonte = 'particular' then 'PARTICULAR' else c.operadora end as operadora,
           case when c.fonte = 'particular' then 'PARTICULAR' else public.norm_chave(c.operadora) end as opn
      from public.catalogo_preco c
      join public.catalogo_procedimento p on p.id = c.procedimento_id and p.ativo
     where c.status = 'ativo' and c.valor is not null and c.valor > 0
  ),
  -- uma linha do catálogo por exame e operadora: prefere confiável e, entre as tabelas, a mais próxima do que o Klingo lança
  cat1 as (
    select distinct on (c.pid, c.opn) c.*, count(*) over (partition by c.pid, c.opn) as n_tabelas
      from cat c left join obs o on o.pid = c.pid and o.opn = c.opn
     order by c.pid, c.opn, (c.confianca in ('alta', 'media')) desc, abs(coalesce(o.valor_tipico, c.valor) - c.valor), c.valor
  ),
  lin as (
    select coalesce(c.pid, o.pid) as pid, coalesce(c.opn, o.opn) as opn, coalesce(c.operadora, o.operadora) as operadora,
           c.fonte, c.tabela, c.n_tabelas, c.confianca, c.valor as catalogo,
           o.valor_tipico as observado, o.valor_min as obs_min, o.valor_max as obs_max, o.amostras, o.atualizado_em as obs_em,
           (c.confianca in ('alta', 'media')) as usavel
      from cat1 c full join obs o on o.pid = c.pid and o.opn = c.opn
  ),
  est0 as (
    select l.*,
           case when l.usavel and l.observado is not null then round((l.observado - l.catalogo) / l.catalogo * 100, 1) end as dif_pct,
           case when l.usavel and l.observado is not null and abs((l.observado - l.catalogo) / l.catalogo * 100) >= v_pct then 'divergente'
                when l.usavel then 'ok'
                when l.observado is not null then 'previsao'
                else 'sem_preco' end as estado,
           rv.ligado as rv_ligado, rv.valor as rv_valor, rv.referencia as rv_ref, rv.nota as rv_nota, rv.revisado_em as rv_em, ag.nome as rv_por
      from lin l
      left join public.catalogo_preco_revisao rv on rv.procedimento_id = l.pid and rv.opn = l.opn
      left join public.agentes ag on ag.id = rv.revisado_por
     where v_op is null or l.opn = v_op
  ),
  -- "mudou" = a referência atual (catálogo ou Klingo) ficou 10% ou mais longe da referência que a pessoa viu ao confirmar.
  -- Assim, corrigir um valor errado resolve o alerta; ele só volta se o catálogo ou o Klingo mudarem depois.
  est as (
    select e.*,
           (e.rv_ref is not null and (case e.estado when 'ok' then e.catalogo when 'sem_preco' then null else e.observado end) is not null
             and abs((case e.estado when 'ok' then e.catalogo else e.observado end) - e.rv_ref) / e.rv_ref * 100 >= v_pct) as mudou
      from est0 e
  ),
  exames as (
    select p.id, p.nome, p.especialidade, p.demanda_90d,
           count(*) filter (where (e.estado = 'divergente' and (e.rv_valor is null or e.mudou)) or e.mudou) as alertas,
           count(*) filter (where e.estado = 'previsao') as previsoes,
           count(*) filter (where e.estado = 'sem_preco') as sem_preco,
           count(*) filter (where coalesce(e.rv_ligado, false)) as ligadas,
           count(*) filter (where not coalesce(e.rv_ligado, false) and e.estado <> 'sem_preco') as nao_ligadas,
           count(*) filter (where e.mudou) as mudaram,
           jsonb_agg(jsonb_build_object(
             'operadora', e.operadora, 'particular', (e.opn = 'PARTICULAR'), 'tabela', e.tabela, 'tabelas', e.n_tabelas, 'estado', e.estado,
             'catalogo', case when e.usavel then e.catalogo end,
             'exibido', case e.estado when 'ok' then e.catalogo when 'sem_preco' then null else e.observado end,
             'observado', e.observado, 'obs_min', e.obs_min, 'obs_max', e.obs_max, 'amostras', e.amostras, 'dif_pct', e.dif_pct,
             'revisao', case when e.rv_valor is not null then jsonb_build_object('ligado', e.rv_ligado, 'valor', e.rv_valor, 'nota', e.rv_nota, 'em', e.rv_em, 'por', e.rv_por, 'mudou', e.mudou) end)
             order by (e.opn = 'PARTICULAR') desc, e.operadora) as linhas
      from est e join public.catalogo_procedimento p on p.id = e.pid and p.ativo
     where v_busca is null or public.norm_chave(p.nome) like '%' || v_busca || '%'
     group by p.id, p.nome, p.especialidade, p.demanda_90d
  ),
  filtrados as (
    select * from exames x
     where v_filtro is null
        or (v_filtro = 'alerta' and x.alertas > 0)
        or (v_filtro = 'previsao' and x.previsoes > 0)
        or (v_filtro = 'sem_preco' and x.sem_preco > 0)
        or (v_filtro = 'ligado' and x.ligadas > 0)
        or (v_filtro = 'nao_ligado' and x.nao_ligadas > 0)
  )
  select jsonb_build_object(
    'limite_pct', v_pct,
    'exames_total', (select count(*) from filtrados),
    'exames_com_alerta', (select count(*) from filtrados where alertas > 0),
    'exames_com_previsao', (select count(*) from filtrados where previsoes > 0),
    'exames_com_chat_ligado', (select count(*) from filtrados where ligadas > 0),
    'preco_lido_em', (select max(atualizado_em) from public.preco_observado where atualizado_em > now() - interval '1 day'),
    'catalogo_em', (select max(atualizado_em) from public.catalogo_meta),
    'exames', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome, 'especialidade', f.especialidade, 'marcacoes_90d', f.demanda_90d,
                          'alertas', f.alertas, 'previsoes', f.previsoes, 'sem_preco', f.sem_preco, 'ligadas', f.ligadas, 'linhas', f.linhas)
                        order by f.demanda_90d desc nulls last, f.nome)
                  from (select * from filtrados order by demanda_90d desc nulls last, nome limit v_lim offset v_off) f), '[]'::jsonb))
    into v_res;
  return v_res;
end $$;
revoke all on function public.catalogo_cardapio_dados(text, text, text, integer, integer, numeric) from public, anon, authenticated;

create or replace function public.catalogo_cardapio(p_busca text default null, p_operadora text default null, p_filtro text default null,
                                                   p_limite integer default 40, p_deslocamento integer default 0)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  return public.catalogo_cardapio_dados(p_busca, p_operadora, p_filtro, p_limite, p_deslocamento, 10);
end $$;
revoke all on function public.catalogo_cardapio(text, text, text, integer, integer) from public, anon;
grant execute on function public.catalogo_cardapio(text, text, text, integer, integer) to authenticated;

-- Lista de operadoras para o filtro do cardápio (administrador).
create or replace function public.catalogo_cardapio_operadoras() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(o order by o) from (select distinct case when fonte = 'particular' then 'PARTICULAR' else operadora end as o
                    from public.catalogo_preco where status = 'ativo' and operadora is not null) q), '[]'::jsonb);
end $$;
revoke all on function public.catalogo_cardapio_operadoras() from public, anon;
grant execute on function public.catalogo_cardapio_operadoras() to authenticated;
