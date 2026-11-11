-- public.painel_alerta_agenda_limpar(p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_alerta_agenda_limpar(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Não autorizado.' using errcode = '28000';
  end if;
  update public.conversas set alerta_agenda = null where id = p_conversa and alerta_agenda is not null;
end $function$;

