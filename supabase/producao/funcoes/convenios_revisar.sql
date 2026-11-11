-- public.convenios_revisar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.convenios_revisar()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_n integer := 0;
begin
  for r in select operadora, suspenso_motivo from public.convenio_config where suspenso_em is not null and suspenso_ate <= now() and revisao_avisada_em is null loop
    insert into public.equipe_notificacao (agente_id, tipo, detalhe)
    select distinct x.id, 'convenio_revisar', jsonb_build_object('convenio', r.operadora, 'motivo', r.suspenso_motivo, 'aviso', 'A suspensão deste convênio completou 1 mês: reative, renove ou mantenha.')
      from (select a.id from public.agentes a where a.ativo and a.papel = 'admin'
            union select m.agente_id from public.org_membro m where m.ativo and m.funcao in ('ti', 'gerente') and m.agente_id is not null) x;
    update public.convenio_config set revisao_avisada_em = now() where operadora = r.operadora;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $function$;

