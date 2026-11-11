-- public.chamar_zap_feito(p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.chamar_zap_feito(p_conversa uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Apenas a equipe.' using errcode = '42501'; end if;
  update public.conversas set chamar_zap_em = null, chamar_zap_feito_em = now(), chamar_zap_feito_por = (select auth.uid()), aguarda_paciente_desde = now()
   where id = any (public.pessoa_membros(p_conversa)) and status = 'em_atendimento' and chamar_zap_em is not null;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

