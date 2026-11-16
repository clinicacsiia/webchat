-- public.painel_ofertas(p_conversas uuid[])
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_ofertas(p_conversas uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb := '{}'::jsonb; t text; e record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if p_conversas is null or cardinality(p_conversas) = 0 or cardinality(p_conversas) > 30 then return r; end if;
  foreach t in array array['horario', 'disponibilidade'] loop
    select o.estado, o.criado_em into e from public.painel_oferta o where o.conversa_id = any (p_conversas) and o.tipo = t order by o.criado_em desc, o.id desc limit 1;
    if e.estado is not null then r := r || jsonb_build_object(t, jsonb_build_object('estado', e.estado, 'em', e.criado_em)); end if;
  end loop;
  return r;
end $function$;

