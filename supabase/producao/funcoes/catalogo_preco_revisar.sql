-- public.catalogo_preco_revisar(p_procedimento integer, p_operadora text, p_ligado boolean, p_valor numeric, p_nota text, p_referencia numeric)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.catalogo_preco_revisar(p_procedimento integer, p_operadora text, p_ligado boolean, p_valor numeric DEFAULT NULL::numeric, p_nota text DEFAULT NULL::text, p_referencia numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_opn text := public.norm_chave(p_operadora);
    v_ant public.catalogo_preco_revisao%rowtype;
      v_valor numeric(12,2);
        v_op text;
        begin
          if coalesce((select public.papel_atual()), '') <> 'admin' then
              raise exception 'Somente administrador.' using errcode = '42501';
                end if;
                  if v_opn is null or p_ligado is null then raise exception 'Informe o exame, a operadora e se o chat deve informar o preço.' using errcode = '22023'; end if;
                    if not exists (select 1 from public.catalogo_procedimento where id = p_procedimento and ativo) then
                        raise exception 'Exame não encontrado ou inativo.' using errcode = '22023';
                          end if;
                            v_op := case when v_opn = 'PARTICULAR' then 'PARTICULAR' else btrim(p_operadora) end;
                              select * into v_ant from public.catalogo_preco_revisao where procedimento_id = p_procedimento and opn = v_opn;
                                v_valor := round(coalesce(p_valor, v_ant.valor), 2);
                                  if v_valor is null then
                                      if not p_ligado then return jsonb_build_object('ok', true, 'ligado', false, 'sem_revisao', true); end if;
                                          raise exception 'Informe o valor que o chat deve passar.' using errcode = '22023';
                                            end if;
                                              if v_valor < 5 or v_valor >= 100000 then raise exception 'Valor fora do esperado (R$ 5 a R$ 99.999,99).' using errcode = '22023'; end if;
                                                insert into public.catalogo_preco_revisao (procedimento_id, opn, operadora, ligado, valor, referencia, nota, revisado_por, revisado_em)
                                                  values (p_procedimento, v_opn, v_op, p_ligado, v_valor, round(p_referencia, 2), nullif(left(btrim(coalesce(p_nota, '')), 200), ''), auth.uid(), now())
                                                    on conflict (procedimento_id, opn) do update
                                                        set ligado = excluded.ligado, valor = excluded.valor, operadora = excluded.operadora,
                                                                referencia = case when p_referencia is null then public.catalogo_preco_revisao.referencia else excluded.referencia end,
                                                                        nota = case when p_nota is null then public.catalogo_preco_revisao.nota else excluded.nota end,
                                                                                revisado_por = excluded.revisado_por, revisado_em = excluded.revisado_em;
                                                                                  insert into public.catalogo_preco_revisao_log (procedimento_id, opn, operadora, ligado_antes, ligado_depois, valor_antes, valor_depois, nota, por)
                                                                                    values (p_procedimento, v_opn, v_op, v_ant.ligado, p_ligado, v_ant.valor, v_valor, nullif(left(btrim(coalesce(p_nota, '')), 200), ''), auth.uid());
                                                                                      return jsonb_build_object('ok', true, 'ligado', p_ligado, 'valor', v_valor);
                                                                                      end $function$;

