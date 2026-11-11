-- public.despedida_imagem(p_versao bigint)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.despedida_imagem(p_versao bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select mime, dados into r from public.despedida_versao where id = p_versao and dados is not null;
  if not found then return null; end if;
  return jsonb_build_object('mime', r.mime, 'base64', encode(r.dados, 'base64'));
end $function$;

