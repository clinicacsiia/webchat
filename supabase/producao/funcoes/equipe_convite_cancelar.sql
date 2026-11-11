-- public.equipe_convite_cancelar(p_email text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.equipe_convite_cancelar(p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n int;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só administrador cancela convites.' using errcode = '42501'; end if;
  delete from public.equipe_convites where email = lower(btrim(coalesce(p_email, '')));
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'removidos', v_n);
end $function$;

