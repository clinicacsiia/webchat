-- public.painel_pmarc_estado()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_pmarc_estado()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê a previsão.' using errcode = '42501'; end if;
  return (select jsonb_build_object('completo_em', completo_em, 'rapido_em', rapido_em, 'erro', erro, 'resultado', resultado) from public.pmarc_estado where id);
end $function$;

