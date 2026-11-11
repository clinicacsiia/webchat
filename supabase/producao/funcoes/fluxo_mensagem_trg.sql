-- public.fluxo_mensagem_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_mensagem_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ent jsonb; v_motor text;
begin
  if new.autor <> 'cliente' then return new; end if;
  select motor into v_motor from public.conversas where id = new.conversa_id;
  if v_motor is distinct from 'fluxo' then return new; end if;
  begin v_ent := nullif(current_setting('fluxo.entrada', true), '')::jsonb; exception when others then v_ent := null; end;
  v_ent := coalesce(v_ent, '{}'::jsonb) || jsonb_build_object('texto', new.texto, 'mensagem_id', new.id);
  begin
    perform public.fluxo_avancar(new.conversa_id, v_ent);
  exception when others then
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido) values (new.conversa_id, 'erro', left(sqlstate || ' ' || sqlerrm, 300), false);
    begin
      perform public.fluxo_dizer(new.conversa_id, public.fluxo_t('erro'));
      perform public.fluxo_transferir(new.conversa_id, 'ATENÇÃO: erro técnico no atendimento automático; conferir a conversa.', 'media', false);
    exception when others then null;
    end;
  end;
  return new;
end $function$;

