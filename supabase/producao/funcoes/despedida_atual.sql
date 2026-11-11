-- public.despedida_atual()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.despedida_atual()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ver bigint; r record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select case when valor ~ '^[0-9]+$' then valor::bigint end into v_ver from public.config where chave = 'despedida_versao_atual';
  select texto, mime, (dados is not null) as tem_imagem, criado_em into r from public.despedida_versao where id = v_ver;
  return jsonb_build_object('ativa', coalesce((select valor from public.config where chave = 'despedida_configurada'), 'nao') = 'sim',
    'versao', case when r.criado_em is null then null else v_ver end, 'texto', r.texto, 'tem_imagem', coalesce(r.tem_imagem, false), 'criado_em', r.criado_em);
end $function$;

