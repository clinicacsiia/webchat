-- public.klingo_avisar_gestao(p_aviso text, p_detalhe jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_avisar_gestao(p_aviso text, p_detalhe jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.equipe_notificacao (agente_id, tipo, detalhe)
  select distinct x.id, 'klingo_autogestao', jsonb_build_object('aviso', p_aviso) || coalesce(p_detalhe, '{}'::jsonb)
    from (select a.id from public.agentes a where a.ativo and a.papel = 'admin'
          union select m.agente_id from public.org_membro m where m.ativo and m.funcao in ('ti', 'gerente') and m.agente_id is not null) x
$function$;

