-- public.catalogo_particular_salvar(p_procedimento integer, p_valor numeric)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.catalogo_particular_salvar(p_procedimento integer, p_valor numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

