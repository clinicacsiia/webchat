-- public.chat_push_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.chat_push_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_url text; v_seg text;
begin
  if new.autor <> 'agente' then return null; end if;
  if not exists (select 1 from public.chat_push_inscricao where conversa_id = new.conversa_id) then return null; end if;
  if exists (select 1 from public.conversas where id = new.conversa_id and push_silenciado_em is not null) then return null; end if;
  select valor into v_url from public.config where chave = 'chat_push_url';
  v_seg := public.fila_aviso_segredo();
  if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
    begin
      perform net.http_post(url := v_url, body := jsonb_build_object('conversa', new.conversa_id, 'mensagem', new.id),
                            headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
    exception when others then null;
    end;
  end if;
  return null;
end $function$;

