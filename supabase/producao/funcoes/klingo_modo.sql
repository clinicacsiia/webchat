-- public.klingo_modo(p_conversa uuid, p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_modo(p_conversa uuid, p_chave text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_m text := public.klingo_mestre(); v_modo text := public.klingo_modo_chave(p_chave); v_tel text; v_lista boolean := false; v_pct integer;
begin
  if v_m = 'nao' or v_modo = 'nao' then return 'nao'; end if;
  if v_modo = 'sombra' then return case when public.klingo_aceita_sombra(p_chave) then 'sombra' else 'nao' end; end if;
  if p_conversa is null or not exists (select 1 from public.conversas c where c.id = p_conversa) then return 'nao'; end if;
  if p_conversa is not null then
    select right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) into v_tel from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
    if v_tel is not null and length(v_tel) = 8 then
      v_lista := exists (select 1 from regexp_split_to_table(public.klingo_cfg('klingo_api_telefones_teste', ''), '[^0-9]+') t where length(t) >= 8 and right(t, 8) = v_tel);
    end if;
  end if;
  if v_lista then return case when v_modo = 'sim' and v_m <> 'teste' then 'sim' else 'teste' end; end if;
  if v_modo = 'teste' or v_m = 'teste' then return 'nao'; end if;
  v_pct := least(100, greatest(0, coalesce(nullif(public.klingo_cfg('klingo_api_percentual', '100'), '')::integer, 100)));
  return case when p_conversa is not null and (abs(hashtext(p_conversa::text)) % 100) < v_pct then 'sim' else 'nao' end;
exception when others then return 'nao';
end $function$;

