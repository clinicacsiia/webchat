-- public.klingo_pre_reservar(p_op uuid, p_cpf text, p_nasc date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_pre_reservar(p_op uuid, p_cpf text, p_nasc date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'); v_hash text; v_ex public.klingo_identidade; v_rid text;
begin
  if not public.fluxo_cpf_ok(v_cpf) then raise exception 'CPF inválido' using errcode = '22023'; end if;
  v_hash := public.klingo_hash(v_cpf);
  perform pg_advisory_xact_lock(hashtext('pre:' || v_hash));
  select * into v_ex from public.klingo_identidade where cpf_hash = v_hash and tipo = 'pre' limit 1;
  if v_ex.id is not null then return jsonb_build_object('acao', 'existente', 'klingo_id', v_ex.klingo_id); end if;
  -- o registro foi feito por outra operação mas a gravação da identidade falhou: reaproveita o id guardado na operação
  select o.detalhe ->> 'registro_id' into v_rid from public.klingo_operacao o where o.detalhe ->> 'cpf_hash' = v_hash and o.detalhe ? 'registro_id' order by o.criado_em desc limit 1;
  if v_rid is not null then return jsonb_build_object('acao', 'existente', 'klingo_id', v_rid); end if;
  -- outra operação já começou (ou deixou incerto) um registro para este CPF: NUNCA registra de novo
  if exists (select 1 from public.klingo_operacao o where o.id <> p_op and o.detalhe ->> 'cpf_hash' = v_hash and o.detalhe ? 'registro_iniciado_em'
              and ((o.detalhe ->> 'registro_iniciado_em')::timestamptz > now() - interval '3 minutes' or o.estado = 'incerto' or o.codigo = 'registro_incerto')
              and not (o.detalhe ? 'registro_id')) then
    return jsonb_build_object('acao', 'bloqueado');
  end if;
  update public.klingo_operacao set detalhe = detalhe || jsonb_build_object('cpf_hash', v_hash, 'registro_iniciado_em', now()) where id = p_op;
  return jsonb_build_object('acao', 'criar');
end $function$;

