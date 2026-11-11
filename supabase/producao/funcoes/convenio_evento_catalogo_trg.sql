-- public.convenio_evento_catalogo_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.convenio_evento_catalogo_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_op text; v_tipo text; v_ant numeric; v_dep numeric; v_var numeric; v_rel boolean := false; v_part boolean;
begin
  if new.tipo not in ('preco', 'plano') then return new; end if;
  v_op := public.convenio_chave(coalesce(nullif(split_part(coalesce(new.descricao, ''), ' · ', 1), ''), split_part(coalesce(new.chave, ''), '|', 1)));
  if v_op = '' then return new; end if;
  v_part := v_op ~ '^PARTICULAR';
  if v_part and (new.tipo <> 'preco' or new.evento <> 'alterado') then return new; end if;
  if new.tipo = 'plano' then
    v_tipo := case new.evento when 'novo' then 'plano_novo' when 'removido' then 'plano_removido' when 'reativado' then 'plano_novo' else 'plano_alterado' end;
    v_rel := new.evento in ('removido');
  else
    v_tipo := (case when v_part then 'preco_particular' else 'preco_convenio' end);
    if new.evento = 'alterado' and new.antes ~ '^-?\d+(\.\d+)?$' and new.depois ~ '^-?\d+(\.\d+)?$' then
      v_ant := new.antes::numeric; v_dep := new.depois::numeric;
      if v_ant <> 0 then v_var := round((v_dep - v_ant) * 100 / v_ant, 1); v_rel := abs(v_var) >= 10; end if;
    elsif new.evento in ('removido', 'novo') then v_rel := new.evento = 'removido';
    end if;
  end if;
  insert into public.convenio_evento (operadora, tipo, descricao, antes, depois, variacao_pct, relevante, origem)
    values (v_op, v_tipo, coalesce(new.descricao, new.chave, '') || case new.evento when 'novo' then ' (novo)' when 'removido' then ' (removido)' when 'reativado' then ' (voltou)' else '' end,
            new.antes, new.depois, v_var, v_rel, 'catalogo');
  return new;
end $function$;

