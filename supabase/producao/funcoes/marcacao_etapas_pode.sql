-- public.marcacao_etapas_pode(p_telefone text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.marcacao_etapas_pode(p_telefone text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_modo text; v_tel text; v_lista text;
begin
  select valor into v_modo from public.config where chave = 'marcacao_etapas_modo';
  if v_modo in ('sim', 'todos') then return true; end if;   -- 'todos' = tela do teste para todos os pacientes
  if v_modo is distinct from 'piloto' and v_modo is distinct from 'teste' then return false; end if;
  v_tel := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_tel) not in (10, 11) then return false; end if;
  select valor into v_lista from public.config where chave = 'marcacao_etapas_telefones';
  return exists (
    select 1 from unnest(string_to_array(coalesce(v_lista, ''), ',')) t(x)
    where case when char_length(regexp_replace(t.x, '\D', '', 'g')) in (12, 13) and left(regexp_replace(t.x, '\D', '', 'g'), 2) = '55'
               then substr(regexp_replace(t.x, '\D', '', 'g'), 3) else regexp_replace(t.x, '\D', '', 'g') end = v_tel);
end $function$;

