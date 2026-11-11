-- public.preco_referencia_pedido(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.preco_referencia_pedido(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_plano text; v_n int; v_com int; r jsonb;
begin
  select pa.plano into v_plano from public.pre_agendamentos pa where pa.conversa_id = p_conversa;
  if nullif(btrim(coalesce(v_plano, '')), '') is null then return null; end if;

  with itens as (
    select i.procedimento_id, coalesce(max(i.procedimento), '') as nome, sum(i.quantidade * coalesce(public.preco_fator_lado(i.lado, (select p2.nome from public.catalogo_procedimento p2 where p2.id = i.procedimento_id)), 1))::int as qtd
    from public.pre_agendamento_itens i
    where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
    group by i.procedimento_id),
  ref as (
    select it.procedimento_id, it.nome, it.qtd,
           min(coalesce(pr.valor_min, pr.valor)) as lo, max(coalesce(pr.valor_max, pr.valor)) as hi
    from itens it
    join public.catalogo_preco pr on pr.procedimento_id = it.procedimento_id and pr.status = 'ativo' and pr.confianca in ('alta', 'media')
     and ((upper(extensions.unaccent(v_plano)) like 'PARTICULAR%' and pr.fonte = 'particular')
       or (pr.fonte = 'convenio' and (strpos(upper(extensions.unaccent(pr.operadora)), upper(extensions.unaccent(v_plano))) > 0
                                   or strpos(upper(extensions.unaccent(v_plano)), upper(extensions.unaccent(pr.operadora))) > 0)))
    group by it.procedimento_id, it.nome, it.qtd)
  select (select count(*) from itens), (select count(*) from ref),
    (select jsonb_agg(c) from (
       select jsonb_build_object('rotulo', ref.nome, 'de', ref.lo, 'ate', ref.hi) as c from ref
       union all
       select jsonb_build_object('rotulo', ref.nome || ' (' || ref.qtd || ' unidades)', 'de', ref.lo * ref.qtd, 'ate', ref.hi * ref.qtd) from ref where ref.qtd > 1
       union all
       select jsonb_build_object('rotulo', 'Total dos exames do pedido', 'de', sum(ref.lo * ref.qtd), 'ate', sum(ref.hi * ref.qtd)) from ref having count(*) > 1) q)
  into v_n, v_com, r;
  if v_n = 0 or v_com < v_n or r is null then return null; end if;
  return jsonb_build_object('plano', v_plano, 'candidatos', r);
end $function$;

