-- public.pmarc_identificar(p_celular text, p_nascimento date)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_identificar(p_celular text, p_nascimento date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tel text; v_marca text; v_sal text; v_lista jsonb;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_tel := public.pmarc_telefone(p_celular);
  if v_tel is null then return jsonb_build_object('ok', false, 'motivo', 'celular_invalido'); end if;
  select valor into v_sal from public.config where chave = 'ia_segredo';
  v_marca := encode(sha256(convert_to(v_tel || coalesce(v_sal, ''), 'UTF8')), 'hex');
  delete from public.pmarc_tentativa where quando < now() - interval '6 hours';
  if (select count(*) from public.pmarc_tentativa where marca = v_marca and tipo = 'identificar' and quando > now() - interval '1 hour') >= 8 then
    return jsonb_build_object('ok', false, 'motivo', 'muitas_tentativas');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('codigo', x.codigo, 'primeiro_nome', initcap(split_part(lower(coalesce(nullif(btrim(x.nome), ''), '')), ' ', 1)))), '[]'::jsonb)
    into v_lista
  from (select codigo, nome from public.pmarc_pessoa
         where p_nascimento is not null and nascimento = p_nascimento and (celular = v_tel or telefone = v_tel) order by criado_em limit 5) x;
  if jsonb_array_length(v_lista) = 0 then
    insert into public.pmarc_tentativa (marca, tipo) values (v_marca, 'identificar');
    return jsonb_build_object('ok', true, 'achou', false);
  end if;
  return jsonb_build_object('ok', true, 'achou', true, 'pessoas', v_lista);
end $function$;

