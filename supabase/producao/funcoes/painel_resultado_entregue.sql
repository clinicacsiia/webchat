-- public.painel_resultado_entregue(p_conversa uuid)
-- Pode executar: authenticated
CREATE OR REPLACE FUNCTION public.painel_resultado_entregue(p_conversa uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  update public.app_resultado set estado = 'entregue', entregue_em = now() where conversa_resultado_id = p_conversa and estado = 'solicitado';
  get diagnostics n = row_count;
  return n;
end $function$;

