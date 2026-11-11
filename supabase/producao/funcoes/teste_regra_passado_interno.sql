-- public.teste_regra_passado_interno(p_aplicar boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.teste_regra_passado_interno(p_aplicar boolean DEFAULT false)
 RETURNS TABLE(conversa_id uuid, motivo text, criada_em timestamp with time zone, status text, aplicada boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare v_ids uuid[] := public.teste_ids('teste_agentes'); r record;
begin
  for r in
    select c.id as cid, c.criado_em as cri, c.status as sit,
           case when c.teste_manual then null
                when c.agente_id = any (v_ids) then 'dona atual é conta de teste'
                when c.encerrada_por = any (v_ids) then 'encerrada por conta de teste'
                when exists (select 1 from public.conversa_encerramento ce where ce.conversa_id = c.id and ce.por = any (v_ids)) then 'já foi encerrada por conta de teste'
                when exists (select 1 from public.mensagens m where m.conversa_id = c.id and m.autor = 'agente' and m.agente_id = any (v_ids)) then 'respondida por conta de teste'
                when exists (select 1 from public.contatos ct where ct.id = c.contato_id and ct.teste) then 'contato de teste' end as mot
      from public.conversas c where not c.teste
     order by c.criado_em
  loop
    if r.mot is null then continue; end if;
    if p_aplicar then perform public.conversa_marcar_teste_interno(r.cid, r.mot); end if;
    conversa_id := r.cid; motivo := r.mot; criada_em := r.cri; status := r.sit; aplicada := coalesce(p_aplicar, false);
    return next;
  end loop;
end $function$;

