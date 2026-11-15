-- public.app_conversa_vincular(p_token text, p_conversa uuid, p_conv_token text)
-- Pode executar: anon, authenticated
CREATE OR REPLACE FUNCTION public.app_conversa_vincular(p_token text, p_conversa uuid, p_conv_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; a public.app_paciente%rowtype; c public.conversas; v_tel text; v_eu boolean;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  begin perform public.chat_valida(p_conversa, p_conv_token);
  exception when others then return jsonb_build_object('ok', false, 'erro', 'conversa'); end;
  select * into a from public.app_paciente where id = s.o_pac;
  select * into c from public.conversas where id = p_conversa;
  select regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g') into v_tel from public.contatos ct where ct.id = c.contato_id;
  if v_tel is distinct from a.telefone then return jsonb_build_object('ok', false, 'erro', 'celular'); end if;
  v_eu := coalesce(c.paciente_tipo, 'proprio') = 'proprio';
  insert into public.app_conversa (paciente_id, conversa_id, pessoa_nome, eu)
  values (a.id, c.id, case when v_eu then a.nome else coalesce(nullif(btrim(c.paciente_nome), ''), 'Filho(a)') end, v_eu)
  on conflict (paciente_id, conversa_id) do nothing;
  -- o que já existe quando a conversa entra NÃO conta como novidade: só o que mudar depois
  update public.app_conversa ac set visto_sig = coalesce((select e ->> 'sig' from jsonb_array_elements(public.app_pedido_dados(a.id, c.id)) e limit 1), md5('')), visto_em = now()
   where ac.paciente_id = a.id and ac.conversa_id = c.id and ac.visto_sig is null;
  return jsonb_build_object('ok', true);
end $function$;

