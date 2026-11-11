-- public.org_membro_vincular(p_membro bigint, p_agente uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.org_membro_vincular(p_membro bigint, p_agente uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.org_membro;
begin
  select * into m from public.org_membro where id = p_membro;
  if not found then raise exception 'Membro não encontrado.' using errcode = '22023'; end if;
  perform public.org_membro_salvar(m.id, m.equipe_id, p_agente, case when p_agente is null then m.rotulo end, m.funcao, m.ativo);
  return true;
end $function$;

