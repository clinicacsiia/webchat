-- public.equipe_convidar(p_email text, p_papel text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.equipe_convidar(p_email text, p_papel text DEFAULT 'atendente'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só administrador convida pessoas para a equipe.' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if coalesce(p_papel, '') not in ('admin','atendente','marketing') then raise exception 'Papel inválido.' using errcode = '22023'; end if;
  insert into public.equipe_convites (email, papel, criado_por) values (v_email, p_papel, (select auth.uid()))
  on conflict (email) do update set papel = excluded.papel, criado_por = excluded.criado_por, criado_em = now(), usado_em = null;
  return jsonb_build_object('ok', true, 'email', v_email, 'papel', p_papel);
end $function$;

