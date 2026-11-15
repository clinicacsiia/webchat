-- public.app_aparelho_abrir(p_pac uuid, p_aparelho text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_aparelho_abrir(p_pac uuid, p_aparelho text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into public.app_aparelho (paciente_id, token_hash, aparelho, desbloqueada_ate)
  values (p_pac, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), left(nullif(btrim(coalesce(p_aparelho, '')), ''), 120), now() + interval '30 minutes');
  delete from public.app_aparelho where id in (select id from public.app_aparelho where paciente_id = p_pac order by ultimo_uso_em desc offset 5);
  update public.app_paciente set ultimo_acesso_em = now() where id = p_pac;
  return v_token;
end $function$;

