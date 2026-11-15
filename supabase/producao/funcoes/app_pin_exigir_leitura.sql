-- public.app_pin_exigir_leitura()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_pin_exigir_leitura()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tok text;
begin
  v_tok := public.app_pin_token();
  if v_tok is null then return; end if;
  -- só confere (não renova): o prazo de 30 minutos é renovado pelo uso do chat (app_perfil) e pelas ações principais
  if v_tok = '' or not exists (select 1 from public.app_aparelho a where a.token_hash = encode(sha256(convert_to(v_tok, 'UTF8')), 'hex')
        and a.ultimo_uso_em >= now() - interval '90 days' and a.desbloqueada_ate is not null and a.desbloqueada_ate >= now()) then
    raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.';
  end if;
end $function$;

