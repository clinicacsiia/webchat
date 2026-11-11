-- public.fila_registrar_completo(p_nome text, p_email text, p_telefone text, p_criar_conta boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_registrar_completo(p_nome text, p_email text, p_telefone text, p_criar_conta boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid; v_email text := lower(btrim(coalesce(p_email, ''))); v_fone text := public.fone_digitos(p_telefone); v_conta jsonb;
begin
  perform public.fila_equipe_ok();
  if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if coalesce(p_telefone, '') <> '' and v_fone is null then raise exception 'Telefone inválido (use DDD).' using errcode = '22023'; end if;
  if coalesce(p_criar_conta, false) and (v_email = '' or v_fone is null) then raise exception 'Para criar a conta, informe e-mail e telefone.' using errcode = '22023'; end if;
  v_id := public.fila_registrar_chegada(p_nome);
  update public.fila_chegada set email = nullif(v_email, ''), telefone = v_fone where id = v_id;
  if coalesce(p_criar_conta, false) then v_conta := public.fila_criar_conta(v_id); end if;
  return jsonb_build_object('id', v_id) || coalesce(v_conta, '{}'::jsonb);
end $function$;

