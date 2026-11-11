-- public.catalogo_preco_particular_sincronizar(p_linhas jsonb, p_demanda jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.catalogo_preco_particular_sincronizar(p_linhas jsonb, p_demanda jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_lote uuid := gen_random_uuid();
  v_recebidas integer; v_casadas integer; v_primeira boolean; v_sem jsonb; v_dem integer;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'Formato inválido.'; end if;
  perform pg_advisory_xact_lock(hashtext('catalogo_preco_particular'));
  create temp table _nome on commit drop as
    select distinct on (n) n, id from (select upper(extensions.unaccent(regexp_replace(trim(nome), '\s+', ' ', 'g'))) n, id from public.catalogo_procedimento where ativo) q order by n, id;
  create temp table _part on commit drop as
    select distinct on (m.id) m.id as procedimento_id, x.procedimento, x.valor, x.amostras, x.valor_min, x.valor_max, x.ultima_marcacao, x.confianca
    from jsonb_to_recordset(p_linhas) as x(procedimento text, valor numeric, amostras int, valor_min numeric, valor_max numeric, ultima_marcacao date, confianca text)
    join pg_temp._nome m on m.n = upper(extensions.unaccent(regexp_replace(trim(x.procedimento), '\s+', ' ', 'g')))
    where x.valor is not null and x.valor > 0
    order by m.id, x.amostras desc;
  select jsonb_array_length(p_linhas) into v_recebidas;
  select count(*) into v_casadas from pg_temp._part;
  select coalesce(jsonb_agg(x.procedimento), '[]'::jsonb) into v_sem from (
    select x.procedimento from jsonb_to_recordset(p_linhas) as x(procedimento text, valor numeric)
    where not exists (select 1 from pg_temp._nome m where m.n = upper(extensions.unaccent(regexp_replace(trim(x.procedimento), '\s+', ' ', 'g')))) limit 25) x;
  select not exists (select 1 from public.catalogo_preco where fonte = 'particular') into v_primeira;
  if v_casadas = 0 and v_recebidas > 0 then raise exception 'Nenhum procedimento do Particular casou com o catálogo: nada foi alterado.'; end if;

  if v_primeira then
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      values (v_lote, 'preco', 'novo', 'particular', v_casadas || ' preços Particular carregados (primeira carga)');
  else
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao, campo, antes, depois)
      select v_lote, 'preco', 'alterado', p.chave, 'PARTICULAR · ' || coalesce(s.procedimento, ''), 'valor', p.valor::text, s.valor::text
      from pg_temp._part s join public.catalogo_preco p on p.chave = 'particular|' || s.procedimento_id where p.status = 'ativo' and p.valor is distinct from s.valor;
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'preco', 'novo', 'particular|' || s.procedimento_id, 'PARTICULAR · ' || coalesce(s.procedimento, '')
      from pg_temp._part s where not exists (select 1 from public.catalogo_preco p where p.chave = 'particular|' || s.procedimento_id and p.status = 'ativo');
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'preco', 'removido', p.chave, 'PARTICULAR · ' || coalesce(p.procedimento, '') || ' (sem marcação recente)'
      from public.catalogo_preco p where p.fonte = 'particular' and p.status = 'ativo' and not exists (select 1 from pg_temp._part s where 'particular|' || s.procedimento_id = p.chave);
  end if;

  update public.catalogo_preco p set
    vigente_desde = case when p.status = 'ativo' and p.valor is not distinct from s.valor then p.vigente_desde else now() end,
    valor = s.valor, procedimento = s.procedimento, amostras = s.amostras, valor_min = s.valor_min, valor_max = s.valor_max,
    ultima_marcacao = s.ultima_marcacao, confianca = s.confianca, status = 'ativo', removido_em = null, visto_em = now()
  from pg_temp._part s where p.chave = 'particular|' || s.procedimento_id;
  insert into public.catalogo_preco (chave, fonte, operadora, procedimento_id, procedimento, valor, moeda, amostras, valor_min, valor_max, ultima_marcacao, confianca)
    select 'particular|' || s.procedimento_id, 'particular', 'PARTICULAR', s.procedimento_id, s.procedimento, s.valor, 'R$', s.amostras, s.valor_min, s.valor_max, s.ultima_marcacao, s.confianca
    from pg_temp._part s where not exists (select 1 from public.catalogo_preco p where p.chave = 'particular|' || s.procedimento_id);
  update public.catalogo_preco p set status = 'removido', removido_em = now()
    where p.fonte = 'particular' and p.status = 'ativo' and not exists (select 1 from pg_temp._part s where 'particular|' || s.procedimento_id = p.chave);

  -- demanda: quantas marcações abertas cada procedimento teve nos últimos 90 dias (só contagem)
  if jsonb_typeof(p_demanda) = 'array' and jsonb_array_length(p_demanda) > 0 then
    create temp table _dem on commit drop as
      select m.id as procedimento_id, sum(x.marcacoes)::int as marcacoes
      from jsonb_to_recordset(p_demanda) as x(procedimento text, marcacoes int)
      join pg_temp._nome m on m.n = upper(extensions.unaccent(regexp_replace(trim(x.procedimento), '\s+', ' ', 'g')))
      group by m.id;
    update public.catalogo_procedimento p set demanda_90d = coalesce(d.marcacoes, 0)
      from public.catalogo_procedimento p2 left join pg_temp._dem d on d.procedimento_id = p2.id where p2.id = p.id;
    select count(*) into v_dem from pg_temp._dem;
  end if;

  return jsonb_build_object('recebidas', v_recebidas, 'casadas', v_casadas, 'primeira_carga', v_primeira, 'procedimentos_com_demanda', coalesce(v_dem, 0), 'sem_correspondencia_exemplos', v_sem);
end $function$;

