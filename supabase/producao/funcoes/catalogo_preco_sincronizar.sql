-- public.catalogo_preco_sincronizar(p_operadora_id integer, p_linhas jsonb, p_forcar boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.catalogo_preco_sincronizar(p_operadora_id integer, p_linhas jsonb, p_forcar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_lote uuid := gen_random_uuid();
  v_antes integer; v_novas integer; v_total integer; v_primeira boolean; v_nome text;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' or jsonb_array_length(p_linhas) = 0 then
    raise exception 'Preços vazios: nada foi alterado.';
  end if;
  perform pg_advisory_xact_lock(hashtext('catalogo_preco:' || p_operadora_id));
  create temp table _pstg on commit drop as
    select distinct on (q.chave) q.* from (
      select x.*, 'convenio|' || x.operadora_id || '|' || coalesce(x.tabela_id, 0) || '|' || x.procedimento_id || '|' || coalesce(x.item_codigo, '') as chave
      from jsonb_to_recordset(p_linhas) as x(operadora_id int, operadora text, tabela_id int, tabela text, procedimento_id int,
        procedimento text, item_codigo text, item_descricao text, valor numeric, moeda text)
      where x.operadora_id = p_operadora_id and x.procedimento_id is not null and x.valor is not null) q
    order by q.chave;
  select count(*) into v_novas from pg_temp._pstg;
  select min(operadora) into v_nome from pg_temp._pstg;
  select count(*) into v_antes from public.catalogo_preco where fonte = 'convenio' and operadora_id = p_operadora_id and status = 'ativo';
  select not exists (select 1 from public.catalogo_preco where fonte = 'convenio' and operadora_id = p_operadora_id) into v_primeira;
  if v_novas = 0 then raise exception 'Nenhum preço válido para a operadora %: nada foi alterado.', p_operadora_id; end if;
  if not p_forcar and v_antes > 0 and v_novas < v_antes * 0.5 then
    raise exception 'Operadora % veio com % preços (hoje há % ativos): menos da metade, nada foi alterado.', p_operadora_id, v_novas, v_antes;
  end if;

  if v_primeira then
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      values (v_lote, 'preco', 'novo', 'operadora ' || p_operadora_id, v_nome || ': ' || v_novas || ' preços carregados (primeira carga)');
  else
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'preco', case when p.status = 'removido' then 'reativado' else 'novo' end, s.chave, s.operadora || ' · ' || coalesce(s.tabela, '') || ' · ' || coalesce(s.procedimento, '')
      from pg_temp._pstg s left join public.catalogo_preco p on p.chave = s.chave where p.id is null or p.status = 'removido';
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao, campo, antes, depois)
      select v_lote, 'preco', 'alterado', s.chave, s.operadora || ' · ' || coalesce(s.tabela, '') || ' · ' || coalesce(s.procedimento, ''), 'valor', p.valor::text, s.valor::text
      from pg_temp._pstg s join public.catalogo_preco p on p.chave = s.chave where p.status = 'ativo' and p.valor is distinct from s.valor;
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'preco', 'removido', p.chave, p.operadora || ' · ' || coalesce(p.tabela, '') || ' · ' || coalesce(p.procedimento, '')
      from public.catalogo_preco p where p.fonte = 'convenio' and p.operadora_id = p_operadora_id and p.status = 'ativo'
        and not exists (select 1 from pg_temp._pstg s where s.chave = p.chave);
  end if;

  update public.catalogo_preco p set
    vigente_desde = case when p.status = 'ativo' and p.valor is not distinct from s.valor then p.vigente_desde else now() end,
    valor = s.valor, moeda = s.moeda, operadora = s.operadora, tabela = s.tabela, procedimento = s.procedimento, item_descricao = s.item_descricao,
    status = 'ativo', removido_em = null, visto_em = now()
  from pg_temp._pstg s where s.chave = p.chave;
  insert into public.catalogo_preco (chave, fonte, operadora_id, operadora, tabela_id, tabela, procedimento_id, procedimento, item_codigo, item_descricao, valor, moeda)
    select s.chave, 'convenio', s.operadora_id, s.operadora, s.tabela_id, s.tabela, s.procedimento_id, s.procedimento, s.item_codigo, s.item_descricao, s.valor, s.moeda
    from pg_temp._pstg s where not exists (select 1 from public.catalogo_preco p where p.chave = s.chave);
  update public.catalogo_preco p set status = 'removido', removido_em = now()
    where p.fonte = 'convenio' and p.operadora_id = p_operadora_id and p.status = 'ativo' and not exists (select 1 from pg_temp._pstg s where s.chave = p.chave);
  select count(*) into v_total from public.catalogo_preco where fonte = 'convenio' and operadora_id = p_operadora_id and status = 'ativo';

  return jsonb_build_object('operadora_id', p_operadora_id, 'operadora', v_nome, 'antes', v_antes, 'recebidos', v_novas, 'ativos_agora', v_total, 'primeira_carga', v_primeira,
    'mudancas', coalesce((select jsonb_object_agg(evento, n) from (select evento, count(*) n from public.catalogo_mudanca where lote = v_lote group by evento) m), '{}'::jsonb));
end $function$;

