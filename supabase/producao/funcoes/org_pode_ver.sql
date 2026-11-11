-- public.org_pode_ver(p_agente uuid, p_papel text, p_dono uuid, p_unidade text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.org_pode_ver(p_agente uuid, p_papel text, p_dono uuid, p_unidade text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_nivel text;
begin
  if p_agente is null or p_papel is null then return false; end if;
  if p_papel in ('admin', 'marketing') then return true; end if;
  if p_dono = p_agente then return true; end if;
  v_nivel := public.org_nivel_de(p_agente, p_papel);
  if v_nivel in ('ti', 'gerente') then return true; end if;
  return exists (
    select 1 from public.org_membro m join public.org_equipe e on e.id = m.equipe_id
     where m.agente_id = p_agente and m.ativo and (m.fim is null or m.fim >= current_date) and e.ativa
       and (e.transversal
            or (p_unidade is not null and e.unidade = p_unidade)));
end $function$;

