-- public.painel_app_solicitacao_status(p_grupo uuid, p_status text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.painel_app_solicitacao_status(p_grupo uuid, p_status text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe atende as solicitações.' using errcode = '42501'; end if;
  if coalesce(p_status, '') not in ('solicitada', 'confirmada', 'concluida', 'cancelada') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  update public.app_marcacao set status = p_status, atualizado_em = now() where grupo = p_grupo;
  get diagnostics n = row_count;
  return n;
end $function$;

