-- public.app_confianca_aceitar(p_token text, p_codigo text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_confianca_aceitar(p_token text, p_codigo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; v_cod text := regexp_replace(coalesce(p_codigo, ''), '\D', '', 'g'); v_meu text; v_cid uuid;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select telefone into v_meu from public.app_paciente where id = s.o_pac;
  if v_cod ~ '^[0-9]{6}$' then
    select c.id into v_cid from public.app_contato_confianca c
     where c.telefone = v_meu and c.removido_em is null and c.vinculado_em is null and c.codigo_falhas < 5 and c.codigo = v_cod
     order by c.criado_em limit 1 for update;
  end if;
  if v_cid is not null then
    update public.app_contato_confianca set vinculado_a = s.o_pac, vinculado_em = now() where id = v_cid;
    perform public.app_evento_gravar(s.o_pac, 'confianca_vinculada');
    return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
  end if;
  update public.app_contato_confianca set codigo_falhas = codigo_falhas + 1 where telefone = v_meu and removido_em is null and vinculado_em is null;
  return jsonb_build_object('ok', false, 'erro', 'codigo', 'mensagem', 'Código inválido ou vencido. Peça um novo a quem cadastrou o seu número.');
end $function$;

