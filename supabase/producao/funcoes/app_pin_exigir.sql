-- public.app_pin_exigir()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_pin_exigir()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tok text; s record;
begin
  v_tok := public.app_pin_token();
  if v_tok is null then return; end if;
  if v_tok = '' then raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.'; end if;
  select * into s from public.app_aparelho_validar(v_tok);   -- confere o PIN dos últimos 30 minutos e RENOVA o prazo
  if s.o_erro is not null then raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.'; end if;
end $function$;

