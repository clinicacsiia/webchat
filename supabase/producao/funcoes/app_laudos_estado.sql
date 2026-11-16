-- public.app_laudos_estado(p_pac uuid, p_marcacao text, p_pronto boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_laudos_estado(p_pac uuid, p_marcacao text, p_pronto boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.app_laudo set
    estado = case when p_pronto then 'disponivel' when estado in ('disponivel', 'em_revisao') then 'em_revisao' else 'aguardando' end,
    disponivel_em = case when p_pronto then coalesce(disponivel_em, now()) else disponivel_em end,
    retirado_em = case when p_pronto then null when estado = 'disponivel' then now() else retirado_em end,
    checado_em = now(), atualizado_em = now()
   where paciente_id = p_pac and marcacao_id = p_marcacao
$function$;

