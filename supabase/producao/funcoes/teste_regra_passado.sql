-- public.teste_regra_passado(p_aplicar boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.teste_regra_passado(p_aplicar boolean DEFAULT false)
 RETURNS TABLE(conversa_id uuid, motivo text, criada_em timestamp with time zone, status text, aplicada boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not coalesce((select auth.uid()) = any (public.teste_ids('teste_marcadores')), false) then
    raise exception 'Somente a TI aplica a regra de teste ao passado.' using errcode = '42501';
  end if;
  return query select * from public.teste_regra_passado_interno(p_aplicar);
end $function$;

