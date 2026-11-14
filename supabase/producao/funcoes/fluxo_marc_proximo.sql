-- public.fluxo_marc_proximo(p_conversa uuid, d jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_marc_proximo(p_conversa uuid, d jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  case d ->> 'marc_estado'
    when 'consultando' then return 'marc_consultando';
    when 'vazio' then return 'marc_vazio';
    when 'pos' then return 'marc_pos';
    when 'pronto' then
      if d ->> 'marc_acao' = 'cancelando' then return 'marc_consultando'; end if;
      if d ->> 'marc_voucher' is null then return 'marc_lista'; end if;
      if d ->> 'marc_acao' = 'cancelar' then return 'marc_cancelar'; end if;
      return 'marc_acao';
    else return 'assunto_texto';
  end case;
end $function$;

