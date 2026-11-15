-- public.app_aparelho_validar(p_token text, p_exige boolean, OUT o_pac uuid, OUT o_aparelho uuid, OUT o_erro text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_aparelho_validar(p_token text, p_exige boolean DEFAULT true, OUT o_pac uuid, OUT o_aparelho uuid, OUT o_erro text)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.app_aparelho%rowtype;
begin
  if not public.app_modo() then o_erro := 'indisponivel'; return; end if;
  select * into a from public.app_aparelho where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  if not found or a.ultimo_uso_em < now() - interval '90 days' then o_erro := 'sessao'; return; end if;
  if p_exige and (a.desbloqueada_ate is null or a.desbloqueada_ate < now()) then o_erro := 'bloqueado'; return; end if;
  update public.app_aparelho set ultimo_uso_em = now(),
    desbloqueada_ate = case when p_exige then now() + interval '30 minutes' else desbloqueada_ate end where id = a.id;
  o_pac := a.paciente_id; o_aparelho := a.id;
end $function$;

