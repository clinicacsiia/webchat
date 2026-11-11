-- public.equipe_notificacao_lida(p_ids bigint[])
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.equipe_notificacao_lida(p_ids bigint[] DEFAULT NULL::bigint[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  update public.equipe_notificacao set lida_em = now()
   where lida_em is null and agente_id = (select auth.uid()) and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

