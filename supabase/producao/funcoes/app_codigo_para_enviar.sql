-- public.app_codigo_para_enviar(p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_codigo_para_enviar(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('email', c.email, 'codigo', c.codigo, 'nome', c.nome, 'finalidade', c.finalidade, 'validade_min', greatest(1, ceil(extract(epoch from (c.expira_em - now())) / 60)::int))
    from public.app_codigo_email c where c.id = p_id and c.envio = 'pendente' and c.email is not null and c.usado_em is null and c.descartado_em is null and c.expira_em > now() $function$;

