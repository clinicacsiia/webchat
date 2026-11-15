-- public.app_pedido_visto(p_token text, p_conversa uuid)
-- Pode executar: anon, authenticated
CREATE OR REPLACE FUNCTION public.app_pedido_visto(p_token text, p_conversa uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  update public.app_conversa ac set visto_em = now(),
         visto_sig = coalesce((select e ->> 'sig' from jsonb_array_elements(public.app_pedido_dados(ac.paciente_id, ac.conversa_id)) e limit 1), md5(''))
   where ac.paciente_id = s.o_pac and (p_conversa is null or ac.conversa_id = p_conversa);
  return jsonb_build_object('ok', true);
end $function$;

