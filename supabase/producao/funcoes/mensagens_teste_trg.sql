-- public.mensagens_teste_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.mensagens_teste_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.autor = 'agente' and new.agente_id is not null then
    begin
      if new.agente_id = any (public.teste_ids('teste_agentes')) then
        perform public.conversa_marcar_teste_interno(new.conversa_id, 'respondida por conta de teste');
      end if;
    exception when others then null;
    end;
  end if;
  return null;
end $function$;

