-- public.conversas_teste_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversas_teste_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ids uuid[]; v_oficial boolean := coalesce(current_setting('app.teste_via_funcao', true), '') = '1';
begin
  if tg_op = 'UPDATE' and not v_oficial then
    new.teste := old.teste; new.teste_motivo := old.teste_motivo; new.teste_manual := old.teste_manual; new.primeiro_humano_em := old.primeiro_humano_em;
  end if;
  begin
    if tg_op = 'INSERT' and not new.teste and exists (select 1 from public.contatos ct where ct.id = new.contato_id and ct.teste) then
      new.teste := true; new.teste_motivo := 'contato de teste';
    end if;
    if not new.teste and not new.teste_manual then
      v_ids := public.teste_ids('teste_agentes');
      if cardinality(v_ids) > 0 and ((new.agente_id is not null and new.agente_id = any (v_ids)) or (new.encerrada_por is not null and new.encerrada_por = any (v_ids))) then
        new.teste := true; new.teste_motivo := coalesce(new.teste_motivo, 'atendida por conta de teste');
      end if;
    end if;
    if new.primeiro_humano_em is null and new.agente_id is not null and new.status = 'em_atendimento' then
      new.primeiro_humano_em := now();
    end if;
  exception when others then null;
  end;
  return new;
end $function$;

