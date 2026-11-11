-- public.painel_anexo_klingo_conferido(p_conversa uuid, p_feito boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_anexo_klingo_conferido(p_conversa uuid, p_feito boolean DEFAULT true)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n int;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  update public.conversa_anexo set klingo_conferido_em = case when p_feito then now() end, klingo_conferido_por = case when p_feito then (select auth.uid()) end
   where conversa_id = p_conversa and (klingo_conferido_em is null) = p_feito;
  get diagnostics n = row_count;
  return n;
end $function$;

