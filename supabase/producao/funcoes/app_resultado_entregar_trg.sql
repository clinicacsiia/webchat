-- public.app_resultado_entregar_trg()
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.app_resultado_entregar_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_table_name = 'conversa_anexo' then
    if new.tipo = 'equipe_arquivo' then
      update public.app_resultado set estado = 'entregue', entregue_em = now(), anexo_id = new.id where conversa_resultado_id = new.conversa_id and estado = 'solicitado';
    end if;
  elsif new.autor = 'agente' and new.agente_id is not null and new.texto ~* 'https?://' then
    update public.app_resultado set estado = 'entregue', entregue_em = now(), mensagem_id = new.id where conversa_resultado_id = new.conversa_id and estado = 'solicitado';
  end if;
  return new;
exception when others then return new;   -- nunca impede a equipe de enviar a mensagem
end $function$;

