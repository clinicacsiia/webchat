-- public.app_codigo_validar(p_telefone text, p_finalidade text, p_codigo text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_codigo_validar(p_telefone text, p_finalidade text, p_codigo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); c public.app_codigo_email%rowtype; v_rest integer;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if not public.app_codigo_exigido() then return jsonb_build_object('ok', true, 'exigido', false); end if;
  if coalesce(p_codigo, '') !~ '^[0-9]{6}$' then return jsonb_build_object('ok', false, 'erro', 'codigo', 'mensagem', 'O código tem 6 números.'); end if;
  select * into c from public.app_codigo_email where telefone = v_tel and finalidade = p_finalidade and usado_em is null and descartado_em is null and expira_em > now() and tentativas < 5
   order by criado_em desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'codigo_vencido', 'mensagem', 'Esse código venceu ou foi cancelado. Peça um novo.'); end if;
  if c.codigo = p_codigo then
    update public.app_codigo_email set validado_em = coalesce(validado_em, now()), expira_em = greatest(expira_em, now() + interval '30 minutes') where id = c.id;
    return jsonb_build_object('ok', true, 'exigido', true);
  end if;
  update public.app_codigo_email set tentativas = tentativas + 1, descartado_em = case when tentativas + 1 >= 5 then now() end where id = c.id returning 5 - tentativas into v_rest;
  if v_rest <= 0 then return jsonb_build_object('ok', false, 'erro', 'codigo_bloqueado', 'mensagem', 'Muitos erros. Peça um código novo.'); end if;
  return jsonb_build_object('ok', false, 'erro', 'codigo', 'restantes', v_rest, 'mensagem', case when v_rest = 1 then 'Código incorreto. Resta 1 tentativa.' else 'Código incorreto. Restam ' || v_rest || ' tentativas.' end);
end $function$;

