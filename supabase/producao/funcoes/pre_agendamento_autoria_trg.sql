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
      if new.agendado_origem is null then
        new.agendado_origem := case when new.agendado_por is not null then 'equipe' when new.agendado_auto_em is not null then 'reconhecido' end;
      end if;
    elsif old.status = 'agendado' and new.status is distinct from 'agendado' then
      new.agendado_origem := null;
    end if;
  exception when others then null;
  end;
  return new;
end $function$;

