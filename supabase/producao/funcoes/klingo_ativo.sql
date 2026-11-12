-- public.klingo_ativo(p_conversa uuid, p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_ativo(p_conversa uuid, p_chave text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_modo text := public.klingo_cfg(p_chave, 'nao'); v_tel text; v_pct integer;
begin
  if v_modo not in ('teste', 'sim') then return false; end if;
  select right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) into v_tel
    from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  if v_tel is not null and length(v_tel) = 8 and exists (
       select 1 from regexp_split_to_table(public.klingo_cfg('klingo_api_telefones_teste', ''), '[^0-9]+') t
        where length(t) >= 8 and right(t, 8) = v_tel) then return true; end if;
  if v_modo = 'teste' then return false; end if;
  v_pct := least(100, greatest(0, coalesce(nullif(public.klingo_cfg('klingo_api_percentual', '100'), '')::integer, 100)));
  return (abs(hashtext(p_conversa::text)) % 100) < v_pct;
exception when others then return false;
end $function$;

