-- public.pre_agendamento_autoria_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pre_agendamento_autoria_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  begin
    if new.status = 'agendado' and old.status is distinct from 'agendado' then
      new.agendado_em := now();
      new.agendado_por := case when coalesce((select public.papel_atual()), '') <> '' then (select auth.uid()) end;
    end if;
  exception when others then null;
  end;
  return new;
end $function$;

