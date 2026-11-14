-- public.catalogo_config_aplicar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.catalogo_config_aplicar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_chave text := substr(new.chave, 10); v_quer boolean := (new.valor = 'sim'); v_restam int;
begin
  if not exists (select 1 from public.unidade_config u where u.chave = v_chave) then return new; end if;
  if not v_quer then
    select count(*) into v_restam from public.unidade_config u where u.ativo and u.chave <> v_chave;
    if v_restam = 0 then raise exception 'Deixe pelo menos um catálogo ligado: sem nenhum o chat não consegue começar.' using errcode = '22023'; end if;
  end if;
  update public.unidade_config set ativo = v_quer where chave = v_chave and ativo is distinct from v_quer;
  return new;
end $function$;

