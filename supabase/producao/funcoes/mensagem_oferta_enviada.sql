-- public.mensagem_oferta_enviada()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.mensagem_oferta_enviada()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare r jsonb;
begin
  if new.agente_id is distinct from auth.uid() or auth.uid() is null then
    raise exception 'Somente a equipe pode enviar a oferta.' using errcode = '42501';
  end if;
  r := public.painel_oferta_registrar(new.conversa_id, new.opcoes ->> 'oferta', 'oferecido');
  if r ->> 'ok' is distinct from 'true' then
    raise exception 'Esta oferta já foi recusada ou dispensada.';
  end if;
  new.opcoes := nullif(new.opcoes - 'oferta', '{}'::jsonb);
  return new;
end $function$;

