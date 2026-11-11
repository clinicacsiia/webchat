-- FLUXOGRAMA: entrada (painel > Catálogo: lista de exames com um campo de valor Particular) -> validação (admin/TI ou gerência; valor entre R$ 5 e R$ 99.999,99; exame ativo) -> lógica (grava em catalogo_preco_revisao com opn PARTICULAR e ligado = true, que é o que o chat já usa em preco_previsao_chat; valor vazio desliga) -> saída (lista paginada, log em catalogo_preco_revisao_log)
-- Versão 1.0 — 11/11/2026 / Mudança: cardápio só Particular, valor digitado ao lado do nome do exame (pedido do dono); convênios saem da tela.
-- DESLIGAR/VOLTAR: as funções antigas catalogo_cardapio e catalogo_preco_revisar continuam; basta o painel voltar a chamá-las.
create or replace function public.catalogo_particular_lista(p_busca text default null, p_filtro text default null, p_limite integer default 50, p_deslocamento integer default 0) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_busca text := nullif(public.norm_chave(coalesce(p_busca, '')), ''); v_lim int := least(greatest(coalesce(p_limite, 50), 1), 100); v_off int := greatest(coalesce(p_deslocamento, 0), 0);
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' and coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente administrador ou gerência.' using errcode = '42501'; end if;
  return (
    with base as (
      select p.id, p.nome, p.especialidade, case when rv.ligado then rv.valor end as valor
        from public.catalogo_procedimento p
        left join public.catalogo_preco_revisao rv on rv.procedimento_id = p.id and rv.opn = 'PARTICULAR'
       where p.ativo and (v_busca is null or public.norm_chave(p.nome) like '%' || v_busca || '%')
    ), f as (
      select * from base where coalesce(p_filtro, '') = '' or (p_filtro = 'com_valor' and valor is not null) or (p_filtro = 'sem_valor' and valor is null)
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'com_valor', (select count(*) from f where valor is not null),
      'itens', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'especialidade', x.especialidade, 'valor', x.valor) order by x.nome)
                           from (select * from f order by nome limit v_lim offset v_off) x), '[]'::jsonb)));
end $$;
revoke all on function public.catalogo_particular_lista(text, text, integer, integer) from public, anon;
grant execute on function public.catalogo_particular_lista(text, text, integer, integer) to authenticated;

-- valor nulo = tirar o preço (o chat volta a dizer que o atendente informa)
create or replace function public.catalogo_particular_salvar(p_procedimento integer, p_valor numeric) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_ant public.catalogo_preco_revisao%rowtype; v_valor numeric(12,2) := round(p_valor, 2);
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' and coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente administrador ou gerência.' using errcode = '42501'; end if;
  if not exists (select 1 from public.catalogo_procedimento where id = p_procedimento and ativo) then raise exception 'Exame não encontrado ou inativo.' using errcode = '22023'; end if;
  select * into v_ant from public.catalogo_preco_revisao where procedimento_id = p_procedimento and opn = 'PARTICULAR';
  if v_valor is null then
    if v_ant.procedimento_id is null or not v_ant.ligado then return jsonb_build_object('ok', true, 'valor', null); end if;
    update public.catalogo_preco_revisao set ligado = false, revisado_por = (select auth.uid()), revisado_em = now() where procedimento_id = p_procedimento and opn = 'PARTICULAR';
    insert into public.catalogo_preco_revisao_log (procedimento_id, opn, operadora, ligado_antes, ligado_depois, valor_antes, valor_depois, por)
      values (p_procedimento, 'PARTICULAR', 'PARTICULAR', true, false, v_ant.valor, v_ant.valor, (select auth.uid()));
    return jsonb_build_object('ok', true, 'valor', null);
  end if;
  if v_valor < 5 or v_valor >= 100000 then raise exception 'Valor fora do esperado (R$ 5 a R$ 99.999,99).' using errcode = '22023'; end if;
  insert into public.catalogo_preco_revisao (procedimento_id, opn, operadora, ligado, valor, revisado_por, revisado_em)
    values (p_procedimento, 'PARTICULAR', 'PARTICULAR', true, v_valor, (select auth.uid()), now())
  on conflict (procedimento_id, opn) do update set ligado = true, valor = excluded.valor, revisado_por = excluded.revisado_por, revisado_em = excluded.revisado_em;
  insert into public.catalogo_preco_revisao_log (procedimento_id, opn, operadora, ligado_antes, ligado_depois, valor_antes, valor_depois, por)
    values (p_procedimento, 'PARTICULAR', 'PARTICULAR', v_ant.ligado, true, v_ant.valor, v_valor, (select auth.uid()));
  return jsonb_build_object('ok', true, 'valor', v_valor);
end $$;
revoke all on function public.catalogo_particular_salvar(integer, numeric) from public, anon;
grant execute on function public.catalogo_particular_salvar(integer, numeric) to authenticated;
