-- public.previsao_ativa(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.previsao_ativa(p_conversa uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_modo text := coalesce((select valor from public.config where chave = 'pedido_horario_modo'), 'desligado'); v_fone text;
begin
  if v_modo = 'ligado' then return true; end if;
  if v_modo <> 'teste' then return false; end if;
  select right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) into v_fone from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  return coalesce(length(v_fone) = 8 and exists (select 1 from regexp_split_to_table(coalesce((select valor from public.config where chave = 'klingo_api_telefones_teste'), ''), '[^0-9]+') t where length(t) >= 8 and right(t, 8) = v_fone), false);
end $function$
;
