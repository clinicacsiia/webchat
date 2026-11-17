-- public.painel_pmarc_link_enviado(p_id uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_pmarc_link_enviado(p_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe marca o envio do link.' using errcode = '42501'; end if;
  update public.pmarc_pessoa set link_enviado_em = now(), link_enviado_por = (select auth.uid()), atualizado_em = now() where id = p_id;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

